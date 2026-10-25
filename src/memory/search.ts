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
import { bm25Body, knnBody, parseTimeRangeDays, type MetaFilterOptions } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import type { Fused, Hit, Projected, Scope } from '../fragment.ts'
import { mergeScopes, projectHit, renderText, rrfFuse, scoreMargin } from '../fragment.ts'

export const SCOPES = ['both', 'personal', 'team'] as const
export type SearchScope = (typeof SCOPES)[number]

/** 返回给模型的条数上限（§6.3：默认 8，上限 20） */
export const MAX_RESULT_LIMIT = 20
/** 正文投影上限：一次检索 8 条 × 500 字，不至于吃掉大量 token */
export const PROJECT_MAX_CHARS = 500
/** 团队库在「没有任何收窄条件」时的兜底时间窗（§8.2） */
export const TEAM_FALLBACK_WINDOW_DAYS = 365
/** 个人库权重：个人记忆通常更贴近当前上下文（§8.3） */
export const PERSONAL_WEIGHT = 1.2

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
  marginFloor: number
  limit: number
}

export interface SearchDeps {
  userId: string
  personalPrefix: string
  teamIndex: string
  /** 读身份：检索一律走只读凭证 */
  reader: Pick<EsClient, 'search'>
  embed?: Pick<Embedder, 'embed'> | null
  /** 索引 mapping 的向量维度（来自配置）；与 embedder 实际输出不一致时 knnBody 会抛 */
  dims: number
  retrieval: RetrievalConfig
  /** 注入时钟（团队库兜底时间窗要用） */
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
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
  const teamMeta: MetaFilterOptions =
    filtered || meta.updatedWithinDays !== undefined
      ? meta
      : { ...meta, updatedWithinDays: TEAM_FALLBACK_WINDOW_DAYS }

  // 团队库的审核闸（S9）：pending（待人工裁决）/ rejected（已驳回）都不该出现在检索结果里。
  // 个人库没有 review_state 字段，所以只能加在 teamMeta 上，不能塞进共用的 meta。
  const teamReviewFilter = ['auto', 'approved'] as const

  // 向量失败 → 降级为纯 BM25（不抛：检索还能用）
  let vector: number[] | null = null
  let degraded = false
  if (deps.embed) {
    try {
      vector = await deps.embed.embed(query)
    } catch (err) {
      degraded = true
      log({ tool: 'search', user: deps.userId, event: 'embedding_degraded', kind: (err as { kind?: string }).kind ?? 'unknown' })
    }
  } else {
    degraded = true
  }

  const topK = deps.retrieval.topK
  const tasks: Array<{ scope: Scope; route: 'bm25' | 'knn'; run: Promise<Hit[]> }> = []

  const pushRoute = (target: Scope, indexName: string, targetMeta: MetaFilterOptions): void => {
    tasks.push({
      scope: target,
      route: 'bm25',
      run: deps.reader.search(indexName, bm25Body(query, targetMeta, topK)).then((r) => r.hits),
    })
    if (vector) {
      tasks.push({
        scope: target,
        route: 'knn',
        run: deps.reader.search(indexName, knnBody(vector, deps.dims, targetMeta, topK)).then((r) => r.hits),
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
    groups.push({ source: 'personal', hits: rrfFuse(routes, deps.retrieval.rrfK) })
  }
  if (scope !== 'personal') {
    const routes = [pick('team', 'bm25')]
    if (vector) routes.push(pick('team', 'knn'))
    groups.push({ source: 'team', hits: rrfFuse(routes, deps.retrieval.rrfK) })
  }

  const merged = mergeScopes(groups, { weights: { personal: PERSONAL_WEIGHT } })
  const basis = `${scope === 'both' ? 'personal+team' : scope}:${degraded ? 'bm25' : 'bm25+knn'}`

  if (merged.length === 0) {
    log({ tool: 'search', user: deps.userId, ms: Date.now() - startedAt, routes: basis, hits: 0, degraded })
    return { hits: [], note: 'no_match', degraded, filtered, text: '没有找到相关记忆。' }
  }

  // margin 只用 kNN 原始 cosine，且至少两条才有意义（见文件头第 3 条）
  const knnScores = settled
    .filter((item) => item.route === 'knn')
    .flatMap((item) => item.hits.map((hit) => hit.score))
    .sort((a, b) => b - a)
  const margin = knnScores.length >= 2 ? scoreMargin(knnScores) : undefined

  if (margin !== undefined && margin < deps.retrieval.marginFloor) {
    log({
      tool: 'search',
      user: deps.userId,
      ms: Date.now() - startedAt,
      routes: basis,
      hits: 0,
      degraded,
      margin,
      note: 'low_confidence',
    })
    return {
      hits: [],
      note: 'low_confidence',
      degraded,
      filtered,
      text: '没有足够相关的记忆（候选之间的区分度太低，宁可不给）。',
    }
  }

  const hits = merged.slice(0, limit).map((hit) => projectHit(hit, PROJECT_MAX_CHARS, hit.origin))
  log({
    tool: 'search',
    user: deps.userId,
    ms: Date.now() - startedAt,
    routes: basis,
    hits: hits.length,
    degraded,
    ...(margin === undefined ? {} : { margin }),
  })
  return { hits, note: 'ok', degraded, filtered, text: renderText(hits) }
}

const DESCRIPTION = [
  '查记忆库（个人 + 团队），混合检索：关键词与语义都能命中。',
  '时机：动手前确认「这个项目以前怎么定的」；用户提到「之前说过 / 记过」；遇到似曾相识的报错。',
  '同一问题最多查一次，拿到结果就往前走；查不到就问人，不要凭印象编。',
  '返回精简结果（正文截断 500 字，不带向量）。note=no_match 表示确实没有；',
  'note=low_confidence 表示候选区分度太低——别把它当证据用。',
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
    async execute(args) {
      return await searchMemories(deps, args)
    },
  })
}
