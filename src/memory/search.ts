/**
 * `memory_search` —— 混合检索：BM25 一路 + kNN 一路，各自在库内 RRF，再跨库合并。
 *
 * 四个决定，改之前先看文档：
 *  1. **`knn` 是顶层参数**（§8.1）：不能塞进 `query.bool.should`，所以是两次独立请求；
 *  2. **判空只用 kNN 的原始 cosine margin**（§8.4）：绝对相似度不能当阈值，
 *     RRF 融合分尺度又差一个数量级，都不能拿来比 0.05；
 *  3. **命中不足两条时不判空**：margin 至少要两个分数才能算，只有一条记忆≠低置信
 *     （否则「库里就一条」会被永久判成没有记忆）；
 *  4. **向量不可用不等于检索不可用**：embedding 失败就只走 BM25，返回 `degraded=true`。
 *
 * @module dsh-memory-es/memory/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Embedder } from '../embedding.ts'
import { bm25Body, extractIdentifiers, knnBody, parseTimeRangeDays, type MetaFilterOptions } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import type { Fused, Hit, Projected, Scope } from '../fragment.ts'
import { applyRanking, DEFAULT_RANKING, mergeScopes, projectHit, renderText, rrfFuse, scoreMargin, type RankingConfig } from '../fragment.ts'

export const SCOPES = ['both', 'personal', 'team'] as const
export type SearchScope = (typeof SCOPES)[number]

/** 返回给模型的条数上限（§6.3：默认 8，上限 20） */
export const MAX_RESULT_LIMIT = 20
/** 正文投影上限：一次检索 8 条 × 500 字，不至于吃掉大量 token */
export const PROJECT_MAX_CHARS = 500
/** 团队库在「没有任何收窄条件」时的兜底时间窗（§8.2） */
export const TEAM_FALLBACK_WINDOW_DAYS = 365
/**
 * 团队库的「跨域通用」domain。
 * 按 domain 分层后，查某个域时会把 general 一起放行——否则一条真正通用的知识
 * （比如「Jenkins 部署静默空跑」）只能被恰好选对域的人看到。
 */
export const TEAM_GENERAL_DOMAIN = 'general'
/** 个人库权重：个人记忆通常更贴近当前上下文（§8.3） */
export const PERSONAL_WEIGHT = 1.2

/**
 * 置信判定的分层阈值（对应 config.ts 的 `confidence` 组）。
 * 不传时用 DEFAULT_CONFIDENCE，便于测试与脚本各取所需。
 */
export interface ConfidenceConfig {
  floorTop1: number
  autoPassTop1: number
  minMargin: number
  minBm25: number
}

/**
 * 默认阈值。**这是唯一来源**：config.ts 的 schema 默认值直接引它，
 * 避免「代码默认」和「配置默认」两处各自漂移。
 *
 * 取值依据（2026-10-29，30 条评测集）：真命中的 top1 全部 ≥ 0.75，
 * noise 全部 ≤ 0.797；把 autoPassTop1 定在 0.80 能让 noise 全部落进中间区，
 * 再由 minMargin=0.025 / minBm25=30 逐个标注。
 * ⚠️ noise 样本仅 6 条，参数贴边；扩到 20 条以上要重跑 `npm run eval:thresholds`。
 */
export const DEFAULT_CONFIDENCE: ConfidenceConfig = {
  floorTop1: 0.6,
  autoPassTop1: 0.8,
  minMargin: 0.025,
  minBm25: 30,
}

export interface ConfidenceInput {
  /** kNN 第一名的 cosine；向量不可用时为 null */
  top1: number | null
  /** kNN 第二名；不足两条为 null */
  top2: number | null
  /** BM25 首条分；两路都空时为 0 */
  bm25Top1: number
}

export type ConfidenceReason = 'ok' | 'narrow' | 'too-low' | 'no-vector'

/**
 * 分层置信判定（阶段 0.5，替代原来的单一 marginFloor）。
 *
 * 为什么不能只看 margin：候选池越大，top2 越贴近 top1，margin 整体下移。
 * 实测 268 条时 margin 中位数 0.0208，而旧门槛 0.05 让 30/30 查询全部返回空。
 *
 * 判定顺序是「先绝对、后相对」：
 *  1. 向量不可用 → 不判低置信（没有依据就别判）
 *  2. top1 < floorTop1 → 明显无关
 *  3. top1 >= autoPassTop1 → 放行（绝对相似度已经够高，不必再看 margin）
 *  4. 只有一条候选 → 放行（没有第二名就没有「区分度」可言）
 *  5. 中间区：margin >= minMargin 或 BM25 >= minBm25 → 放行，否则低置信
 *
 * ⚠️ 已知边界：真命中与噪声存在「三项全劣」的不可分对（见 docs/优化路线.md 阶段 0.5），
 * 所以低置信只用于**标注**，不再丢弃结果。
 */
export function judgeConfidence(
  input: ConfidenceInput,
  cfg: ConfidenceConfig = DEFAULT_CONFIDENCE,
): { low: boolean; reason: ConfidenceReason } {
  if (input.top1 === null) return { low: false, reason: 'no-vector' }
  if (input.top1 < cfg.floorTop1) return { low: true, reason: 'too-low' }
  if (input.top1 >= cfg.autoPassTop1) return { low: false, reason: 'ok' }
  // 只有一条候选时没有「区分度」可言：不能因为第二名不存在就判窄。
  // （否则库里只存了一条相关记忆时，查询永远被判低置信。）
  if (input.top2 === null) return { low: false, reason: 'ok' }
  if (input.top1 - input.top2 >= cfg.minMargin) return { low: false, reason: 'ok' }
  if (cfg.minBm25 > 0 && input.bm25Top1 >= cfg.minBm25) return { low: false, reason: 'ok' }
  return { low: true, reason: 'narrow' }
}

/** 低置信时的固定提示：结果照常给，但要让模型知道「这是低置信」 */
export const LOW_CONFIDENCE_HINT =
  '以下结果的相关性偏低（候选之间区分度不足），请谨慎采信；如果与问题无关，就当作没有检索到。'

export interface SearchInput {
  query: string
  scope?: SearchScope
  memory_type?: string[]
  domain?: string[]
  time_range?: string
  limit?: number
}

export interface RetrievalConfig {
  topK: number
  rrfK: number
  limit: number
}

export interface SearchDeps {
  /** 取消信号（来自 exec.signal） */
  signal?: AbortSignal
  userId: string
  personalPrefix: string
  teamIndex: string
  /** 读身份：检索一律走只读凭证 */
  reader: Pick<EsClient, 'search'>
  embed?: Pick<Embedder, 'embed'> | null
  /** 索引 mapping 的向量维度（来自配置）；与 embedder 实际输出不一致时 knnBody 会抛 */
  dims: number
  retrieval: RetrievalConfig
  /** 置信判定阈值；不传用 DEFAULT_CONFIDENCE（测试与脚本常用） */
  confidence?: ConfidenceConfig
  /** 排序乘子；不传用 DEFAULT_RANKING */
  ranking?: RankingConfig
  /**
   * 命中回写（热度信号）：必须给写身份。不给就不记，检索结果不受影响。
   * 用脚本 `+= 1`，并发检索时才不会丢更新。
   */
  hitRecorder?: Pick<EsClient, 'updateScript'> | null
  /** 注入时钟（团队库兜底时间窗要用） */
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
  /**
   * 检索埋点写入（`search_log_<uid>`，P1）。可选：不配就不记。
   * **写失败只记日志**——埋点是观测通道，不能因为它挂了把检索一起弄失败。
   */
  recorder?: Pick<EsClient, 'index'> | null
  /** 埋点索引名；与 recorder 同时给出才生效 */
  searchLogIndex?: string
}

/** `note` 用固定枚举而不是可选字段：空对象/缺字段会被模型误判成“没有记忆” */
export type SearchNote = 'ok' | 'no_match' | 'low_confidence'

export interface SearchResult {
  hits: Projected[]
  note: SearchNote
  /** true = 向量不可用，本次只走了 BM25 */
  degraded: boolean
  /** true = 用了团队库的兜底时间窗（模型可据此知道自己没给收窄条件） */
  filtered: boolean
  /** 给模型看的短文本 */
  text: string
}

function clampLimit(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(value)))
}

/** 把工具入参翻译成 ES 过滤条件；团队库在无收窄条件时补 365 天兜底 */
function buildMeta(
  input: SearchInput,
  now: Date,
): { meta: MetaFilterOptions; filtered: boolean } {
  const meta: MetaFilterOptions = {
    status: 'active',
    memory_type: input.memory_type,
    domain: input.domain,
    now,
  }
  if (input.time_range !== undefined && input.time_range.trim() !== '') {
    meta.updatedWithinDays = parseTimeRangeDays(input.time_range)
  }
  const narrowed = Boolean(
    (input.memory_type && input.memory_type.length > 0) ||
      (input.domain && input.domain.length > 0) ||
      meta.updatedWithinDays !== undefined,
  )
  return { meta, filtered: narrowed }
}

/**
 * 编排：并发取两路 → 库内 RRF → 跨库合并（个人加权 + 去重）→ margin 判空 → 投影。
 */
export async function searchMemories(deps: SearchDeps, input: SearchInput): Promise<SearchResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const query = (input.query ?? '').trim()
  if (query === '') throw new Error('memory_search: query 不能为空')

  const scope: SearchScope = input.scope ?? 'both'
  if (!SCOPES.includes(scope)) throw new Error(`memory_search: 未知 scope「${String(scope)}」`)
  const limit = clampLimit(input.limit, deps.retrieval.limit)
  const now = deps.now?.() ?? new Date()
  const { meta, filtered } = buildMeta(input, now)

  const personalIndex = `${deps.personalPrefix}${deps.userId}`
  // 团队库按 domain 分层：查某个域时只能看到「本域 + general（跨域通用）」，
  // 看不到别的项目的专属知识。个人库不这么做——自己的记忆不需要按域隔离。
  // 不传 domain 时保持全域检索（否则「我不知道这属于哪个域」会变成召回不到）。
  const teamDomain =
    input.domain && input.domain.length > 0
      ? [...new Set([...input.domain, TEAM_GENERAL_DOMAIN])]
      : undefined
  const teamMeta: MetaFilterOptions = {
    ...(filtered || meta.updatedWithinDays !== undefined
      ? meta
      : { ...meta, updatedWithinDays: TEAM_FALLBACK_WINDOW_DAYS }),
    domain: teamDomain,
  }

  // 团队库的审核闸（S9）：pending（待人工裁决）/ rejected（已驳回）都不该出现在检索结果里。
  // 个人库没有 review_state 字段，所以只能加在 teamMeta 上，不能塞进共用的 meta。
  const teamReviewFilter = ['auto', 'approved'] as const

  // 向量失败 → 降级为纯 BM25（不抛：检索还能用）
  let vector: number[] | null = null
  let degraded = false
  if (deps.embed) {
    try {
      vector = await deps.embed.embed(query, { signal: deps.signal })
    } catch (err) {
      degraded = true
      log({ tool: 'search', user: deps.userId, event: 'embedding_degraded', kind: (err as { kind?: string }).kind ?? 'unknown' })
    }
  } else {
    degraded = true
  }

  const topK = deps.retrieval.topK
  // 标识符（lot.bd_write_sync / class 名 / 主机名）单独走 content_exact 精确匹配加分；
  // IK 会把它们切碎，纯 BM25 分数压不住噪声（实测 13.9）。
  const identifiers = extractIdentifiers(query)
  const tasks: Array<{ scope: Scope; route: 'bm25' | 'knn'; run: Promise<Hit[]> }> = []

  const pushRoute = (target: Scope, indexName: string, targetMeta: MetaFilterOptions): void => {
    tasks.push({
      scope: target,
      route: 'bm25',
      run: deps.reader
        .search(indexName, bm25Body(query, targetMeta, topK, identifiers), { signal: deps.signal })
        .then((r) => r.hits),
    })
    if (vector) {
      tasks.push({
        scope: target,
        route: 'knn',
        run: deps.reader
          .search(indexName, knnBody(vector, deps.dims, targetMeta, topK), { signal: deps.signal })
          .then((r) => r.hits),
      })
    }
  }

  if (scope !== 'team') pushRoute('personal', personalIndex, meta)
  if (scope !== 'personal') {
    pushRoute('team', deps.teamIndex, { ...teamMeta, review_state: [...teamReviewFilter] })
  }

  let settled: Array<{ scope: Scope; route: 'bm25' | 'knn'; hits: Hit[] }>
  try {
    settled = await Promise.all(tasks.map(async (task) => ({ ...task, hits: await task.run })))
  } catch (err) {
    // 任一路 ES 出错就明确失败（§6.5）；不做“猜到一半结果”的降级
    log({ tool: 'search', user: deps.userId, ms: Date.now() - startedAt, error: formatEsError(err) })
    throw err
  }

  const pick = (target: Scope, route: 'bm25' | 'knn'): Hit[] =>
    settled.find((item) => item.scope === target && item.route === route)?.hits ?? []

  const groups: Array<{ source: Scope; hits: Fused[] }> = []
  if (scope !== 'team') {
    const routes = [pick('personal', 'bm25')]
    if (vector) routes.push(pick('personal', 'knn'))
    groups.push({
      source: 'personal',
      hits: rrfFuse(routes, deps.retrieval.rrfK, {
        agreementBonus: deps.ranking?.agreementBonus,
        span: deps.retrieval.topK,
      }),
    })
  }
  if (scope !== 'personal') {
    const routes = [pick('team', 'bm25')]
    if (vector) routes.push(pick('team', 'knn'))
    groups.push({
      source: 'team',
      hits: rrfFuse(routes, deps.retrieval.rrfK, {
        agreementBonus: deps.ranking?.agreementBonus,
        span: deps.retrieval.topK,
      }),
    })
  }

  const mergedRaw = mergeScopes(groups, { weights: { personal: PERSONAL_WEIGHT } })
  // 排序乘子作用在跨库合并之后：importance / 命中次数 / 新鲜度。
  // 系数默认温和（±10% 量级），归零即完全关闭。
  const merged = applyRanking(mergedRaw, deps.ranking ?? DEFAULT_RANKING, now)
  const basis = `${scope === 'both' ? 'personal+team' : scope}:${degraded ? 'bm25' : 'bm25+knn'}`

  /**
   * 检索埋点（P1）：只回答四个问题——查了什么、召回几条、花了多久、是不是空/降级。
   *
   * **不 await、失败不抛**：埋点写失败只打日志，检索结果照常返回。
   * 理由与 §6.5 一致：观测通道的可用性不该成为记忆检索的单点故障。
   * 三个出口（no_match / low_confidence / ok）都要记，否则"空结果率"永远算不出来。
   */
  const record = (note: SearchNote, hitCount: number, extra: { margin?: number } = {}): void => {
    const recorder = deps.recorder
    const index = deps.searchLogIndex
    if (!recorder || !index) return
    const doc: Record<string, unknown> = {
      user_id: deps.userId,
      at: new Date().toISOString(),
      tool: 'search',
      query: query.slice(0, 500),
      scope,
      hits: hitCount,
      note,
      zero_hit: hitCount === 0,
      degraded,
      filtered,
      routes: basis,
      ms: Date.now() - startedAt,
    }
    if (extra.margin !== undefined) doc.margin = extra.margin
    try {
      // 不传 refresh：埋点不需要立刻可见，而 WriteOptions 的 refresh 只接受 'true'|'wait_for'
      void recorder.index(index, doc).catch((err: unknown) => {
        log({ tool: 'search', event: 'record_degraded', error: formatEsError(err) })
      })
    } catch (err) {
      log({ tool: 'search', event: 'record_degraded', error: formatEsError(err) })
    }
  }

  if (merged.length === 0) {
    log({ tool: 'search', user: deps.userId, ms: Date.now() - startedAt, routes: basis, hits: 0, degraded })
    record('no_match', 0)
    return { hits: [], note: 'no_match', degraded, filtered, text: '没有找到相关记忆。' }
  }

  // 置信信号只取「主库」的一手分数：scope=both 时以个人库为准。
  // 不能把两个库的 kNN 分数混在一起排序——候选池不同，混算出来的 margin 没有意义。
  const primaryScope: Scope = scope === 'team' ? 'team' : 'personal'
  const knnScores = settled
    .filter((item) => item.route === 'knn' && item.scope === primaryScope)
    .flatMap((item) => item.hits.map((hit) => hit.score))
    .sort((a, b) => b - a)
  const bm25Top1 = settled
    .filter((item) => item.route === 'bm25' && item.scope === primaryScope)
    .flatMap((item) => item.hits.map((hit) => hit.score))
    .sort((a, b) => b - a)[0] ?? 0
  const margin = knnScores.length >= 2 ? scoreMargin(knnScores) : undefined
  const verdict = judgeConfidence(
    { top1: knnScores[0] ?? null, top2: knnScores[1] ?? null, bm25Top1 },
    deps.confidence,
  )

  const topMerged = merged.slice(0, limit)
  const hits = topMerged.map((hit) => projectHit(hit, PROJECT_MAX_CHARS, hit.origin))

  // 命中回写：fire-and-forget，失败只记日志——观测通道的可用性不该拖累检索。
  if (deps.hitRecorder !== null && deps.hitRecorder !== undefined && topMerged.length > 0) {
    const stamp = now.toISOString()
    const recorder = deps.hitRecorder
    void Promise.all(
      topMerged.map((hit) => {
        const index = hit.origin === 'team' ? deps.teamIndex : personalIndex
        return recorder
          .updateScript(index, hit.id, {
            source:
              'if (ctx._source.hit_count == null) { ctx._source.hit_count = 0 } ctx._source.hit_count += 1; ctx._source.last_hit_at = params.now',
            params: { now: stamp },
          })
          .catch((err: unknown) => {
            log({ tool: 'search', event: 'hit_record_degraded', error: formatEsError(err) })
          })
      }),
    )
  }

  // 低置信不再丢弃结果：返回 + 标注，让模型自己判断。
  // 丢信息的代价更高——模型会以为「没记过」，转而凭印象编。
  if (verdict.low) {
    log({
      tool: 'search',
      user: deps.userId,
      ms: Date.now() - startedAt,
      routes: basis,
      hits: hits.length,
      degraded,
      margin,
      note: 'low_confidence',
      reason: verdict.reason,
    })
    record('low_confidence', hits.length, margin === undefined ? {} : { margin })
    return {
      hits,
      note: 'low_confidence',
      degraded,
      filtered,
      text: `${LOW_CONFIDENCE_HINT}\n${renderText(hits)}`,
    }
  }
  log({
    tool: 'search',
    user: deps.userId,
    ms: Date.now() - startedAt,
    routes: basis,
    hits: hits.length,
    degraded,
    ...(margin === undefined ? {} : { margin }),
  })
  record('ok', hits.length, margin === undefined ? {} : { margin })
  return { hits, note: 'ok', degraded, filtered, text: renderText(hits) }
}

const DESCRIPTION = [
  '查记忆库（个人 + 团队），混合检索：关键词与语义都能命中。',
  '时机：动手前确认「这个项目以前怎么定的」；用户提到「之前说过 / 记过」；遇到似曾相识的报错。',
  '同一问题最多查一次，拿到结果就往前走；查不到就问人，不要凭印象编。',
  '返回精简结果（正文截断 500 字，不带向量）。note=no_match 表示确实没有；',
  'note=low_confidence 表示候选区分度偏低：结果仍会给出，但要谨慎采信。',
].join(' ')

/** 把编排封成模型可见的工具定义 */
export function defineSearchTool(deps: SearchDeps) {
  return defineTool({
    name: 'memory_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '自然语言或关键词；换成用户可能的问法比堆同义词更有效。',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        description: 'both（默认）/ personal（只看自己的）/ team（只看团队库）。',
      },
      memory_type: {
        type: 'array',
        items: { type: 'string' },
        description: '按记忆类型收窄（可多选）：preference / fact / task_progress / decision / context。',
      },
      domain: {
        type: 'array',
        items: { type: 'string' },
        description: '按业务域收窄（可多选），如 lottery-cloud、backup-server。',
      },
      time_range: {
        type: 'string',
        description: '只返回最近更新过的，如 now-180d / now-12h / now-30m。',
      },
      limit: {
        type: 'integer',
        description: `返回条数，默认取配置，上限 ${MAX_RESULT_LIMIT}。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                memory_id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                memory_type: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                updated_at: { type: 'string', required: true },
                source: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
          note: { type: 'string', required: true },
          degraded: { type: 'boolean', required: true },
          filtered: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 两路 + 两库共 4 个请求并发；取消时全部由 deps.signal 打断
    timeoutMs: 15_000,
    async execute(args, exec) {
      return await searchMemories({ ...deps, signal: exec.signal }, args)
    },
  })
}
