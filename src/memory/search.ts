/**
 * `memory_search` —— 混合检索：BM25 一路 + kNN 一路，各自在库内 RRF，再跨库合并。
 *
 * 四个决定，改之前先看文档：
 *  1. **`knn` 是顶层参数**（§8.1）：不能塞进 `query.bool.should`，所以是两次独立请求；
 *  2. **判空只用 kNN 的原始 cosine margin**（§8.4）：绝对相似度不能当阈值，
 *     RRF 融合分尺度又差一个数量级，都不能拿来比 0.05；
 *  3. **命中不足两条时不判空**：margin 至少要两个分数才能算，只有一条记忆≠低置信
 *     （否则「库里就一条」会被永久判成没有记忆）；
 *  4. **降级不等于不可用**：embedding 失败就只走 BM25、团队库读不到（403，如
 *     `--personal-only` 档位）就只查个人库 —— 两种都返回 `degraded=true`，
 *     但**其它错误仍然整体抛**（§6.5 那条「不做猜到一半结果的降级」只豁免这两类
 *     **能力边界**，不豁免超时/网络/服务端这类瞬时故障）。
 *
 * @module dsh-memory-es/memory/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Embedder } from '../embedding.ts'
import { bm25Body, extractIdentifiers, knnBody, parseTimeRangeDays, type MetaFilterOptions, type SearchBody } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import type { Fused, Hit, Projected, Scope } from '../fragment.ts'
import { applyRanking, buildHitReceipts, DETAIL_LEVELS, diversifyByDomain, DEFAULT_RANKING, mergeScopes, projectHit, renderText, rrfFuse, scoreMargin, spreadActivation, type DetailLevel, type HitReceipt, type RankingConfig, type ReceiptSource } from '../fragment.ts'
import { NON_FACT_MEMORY_TYPES } from './common.ts'
import { DEFAULT_TIMEZONE, zonedDayStart } from '../timezone.ts'
import type { RecallCache } from './recallCache.ts'

export const SCOPES = ['both', 'personal', 'team'] as const
export type SearchScope = (typeof SCOPES)[number]

/**
 * 查询的归一化键（阶段 11）：把「同一个问题的不同提法」聚成一簇。
 *
 * 与 `fragment.normalizeContent` 的区别：那个保留空白（正文语义），这个把空白与标点
 * **全部去掉**——面板要按簇数「这周问过什么」，`Nacos 实例列表` 与 `nacos实例列表`
 * 必须落进同一个桶。`query` 本身是 ik 分词的 text，没法直接 terms 聚合，所以埋点里
 * 额外存一份 keyword。
 *
 * 截断 200 字：超过这个长度基本是贴了整段上下文，不指望能聚到一起，但也不该撑爆 keyword。
 */
export function normalizeQueryKey(query: string): string {
  const normalized = query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 200)
  return normalized === '' ? '<empty>' : normalized
}

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
  /**
   * 阶段 21：中间区下限（绝对分闸）。
   *
   * 0.6~autoPassTop1 这段原本只靠 margin/bm25 判断，而**闲聊恰好落在 0.72~0.74**：
   * 2026-11-05 实测闲聊 top1 0.7227~0.7430、真相关 0.7920~0.8314（中间 0.049 空档），
   * 但两者的 note 全是 ok —— margin 分不开它们。低于这条线直接判低置信，不再看区分度。
   * 0 = 关闭（回到旧行为）。
   */
  midBandFloor: number
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
  /** 与注入的 recallInject.minScore 同源（都是 2026-11-05 那批实测定出来的分界） */
  midBandFloor: 0.76,
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

export type ConfidenceReason = 'ok' | 'narrow' | 'too-low' | 'mid-floor' | 'no-vector'

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
  // 阶段 21：中间区下限。这一段 margin 不可靠——闲聊 top1 就落在 0.72~0.74，
  // 与真相关（≥0.79）只差 0.05，而候选池一大 margin 就整体塌到 0.02 量级。
  // 低于 midBandFloor 直接判低置信，不再看区分度；0 = 关闭。
  if (cfg.midBandFloor > 0 && input.top1 < cfg.midBandFloor) {
    return { low: true, reason: 'mid-floor' }
  }
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
  /** true 时在结果里附「命中回执」（只解释排序，不参与算分；默认关闭省 token） */
  explain?: boolean
  /**
   * 阶段 12 分级读取：`full`（默认，正文最多 500 字）/ `summary`（摘要 + 120 字，省 token）。
   * 默认**仍是 full**——切默认值是行为变更，要先过契约评测与 token 对比，不在这轮偷偷改。
   */
  detail?: DetailLevel
  /**
   * 阶段 13 时间点回看：只返回该时间点之前创建的记忆（ISO 8601）。
   * 近似语义：ES 没有版本历史，看到的是「那条目现在的内容」，不是当时的旧版本。
   */
  as_of?: string
}

export interface RetrievalConfig {
  topK: number
  rrfK: number
  limit: number
  /** 阶段 12 结果多样化：同一 domain 最多几条（0 = 关闭，默认关） */
  maxPerDomain?: number
  /**
   * 阶段 12 缺省详略：`full`（默认）/ `summary`。
   * 调用方显式传 `detail` 时以调用方为准；这里只决定「没传时给什么」。
   */
  defaultDetail?: DetailLevel
  /**
   * 召回质量：低置信时**拒答**（返回空而不是「5 条不相关的结果 + 一句提示」）。
   *
   * 默认关：这是行为变更，且会丢掉少量真命中。
   * 2026-11-02 A/B 实测（43 条契约）：开它 should 失败 10 → 3（7 条噪声全部修掉，零误伤）。
   */
  abstainOnLowConfidence?: boolean
  /**
   * 查询扩展表：口语/中文 → 书面/英文同义词。
   *
   * **两路都吃**（BM25 与向量都用扩展后的句子）。实测依据：只扩 BM25 时 43 条契约
   * should 失败仍是 10（毫无收益）；两路都扩才 10 → 8，与 abstain 同开 10 → 1。
   * 默认空表 = 不改写。
   */
  synonyms?: Record<string, string>
}

export interface SearchDeps {
  /** 取消信号（来自 exec.signal） */
  signal?: AbortSignal
  userId: string
  personalPrefix: string
  teamIndex: string
  /** 读身份：检索一律走只读凭证 */
  /**
   * `msearch` 可选：生产环境总是有（真 EsClient），测试里的手写 fake 往往只实现 search。
   * 有它就把四路召回合并成一次往返（阶段 20），没有就退回逐个 search——语义完全一致。
   */
  reader: Pick<EsClient, 'search'> & { msearch?: EsClient['msearch'] }
  /**
   * 阶段 6.3：当前心情（同步读缓存，不额外打 ES）。缺省 = 当没有情绪。
   * 传函数而不是值，是为了每次检索都拿到最新状态。
   */
  mood?: () => { valence: number } | null
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
   *
   * 阶段 20：`bulkUpdateScript` 可选——有它就一次 `_bulk` 写完（省 N-1 次往返），
   * 没有就退回逐条 `updateScript`（语义相同，只是慢）。
   */
  hitRecorder?:
    | (Pick<EsClient, 'updateScript'> & { bulkUpdateScript?: EsClient['bulkUpdateScript'] })
    | null
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
  /**
   * 阶段 9：把本次命中的条目记进短期缓存，供写入侧识别「检索原文再摄取」。
   * 缺省 = 不记（脚本与测试不需要这个联动）。
   */
  recallCache?: RecallCache | null
}

/**
 * 命中回写的 painless 脚本（阶段 2 的热度信号 + 阶段 9 的 activation）。
 *
 * 抽成常量是为了**能被单测钉住**：这段字符串没有任何类型保护，
 * 删掉一行 `activation += 1` 编译不会报错、运行时只会静默降级，
 * 而扩散激活的强度加权就永远拿不到数据（阶段 9 修复的正是这个坑）。
 *
 * 注意这里**不做时间衰减**：衰减放在读取侧（fragment.ts 的 spreadActivation），
 * 因为那边有 `last_hit_at` 与 `now`，用 JS 算既可测又不会因 painless 解析日期而静默失败。
 */
export const HIT_UPDATE_SCRIPT =
  'if (ctx._source.hit_count == null) { ctx._source.hit_count = 0 } ctx._source.hit_count += 1; ' +
  'if (ctx._source.activation == null) { ctx._source.activation = 0 } ctx._source.activation += 1; ' +
  'ctx._source.last_hit_at = params.now'

/** `note` 用固定枚举而不是可选字段：空对象/缺字段会被模型误判成“没有记忆” */
export type SearchNote = 'ok' | 'no_match' | 'low_confidence'

export interface SearchResult {
  hits: Projected[]
  /** 阶段 10：`explain=true` 时给出，与 hits 逐条同序；否则缺省 */
  receipts?: HitReceipt[]
  note: SearchNote
  /**
   * true = 本次是**降级结果**，两种情形：
   *   · 向量不可用 → 只走了 BM25；
   *   · 团队库读不到（403，典型是 `--personal-only` 档位没有 `mem_team_read`）
   *     → 只查了个人库（2026-11-10 审查 M12/#28）。
   * 两种都不影响「个人库这一路的结果是真的」，但模型该知道自己看到的不是全量。
   */
  degraded: boolean
  /** true = 用了团队库的兜底时间窗（模型可据此知道自己没给收窄条件） */
  filtered: boolean
  /**
   * 阶段 13：传了 as_of 时回显生效的时间点（ISO）；没传则缺省。
   *
   * 字段名必须与工具 output schema 一致（`as_of`）——2026-11-02 评审实测：这里原来返回
   * `asOf`，schema 声明的是 `as_of`，DSH 的 `additionalProperties: false` 直接把整个结果
   * 判为非法（`value.asOf is not a declared property`），功能自 v0.5.9 起从未成功执行过。
   */
  as_of?: string
  /** 给模型看的短文本 */
  text: string
}

/**
 * 查询扩展：命中同义词表就把它展开的词拼回原句。
 *
 * 两路都吃（BM25 + 向量）。实测：只扩 BM25 时契约结果毫无变化，
 * 收益来自向量侧——口语化措辞（「那个方法」「归我发」）先被扩成书面词，
 * 语义才落得到目标记忆上。
 */
export function expandQuery(query: string, synonyms?: Record<string, string>): string {
  if (synonyms === undefined || synonyms === null) return query
  const extra: string[] = []
  for (const [key, value] of Object.entries(synonyms)) {
    if (key !== '' && query.includes(key) && typeof value === 'string' && value.trim() !== '') {
      extra.push(value.trim())
    }
  }
  return extra.length === 0 ? query : `${query} ${extra.join(' ')}`
}

function clampLimit(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(value)))
}

/** 只有日期的写法（`2026-10-01`）——按配置时区当天 00:00 解释，不按 UTC */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** as_of 解析：空串视为未传，非法值直接报错（静默回落到"不过滤"会让时间点回看骗人） */
function parseAsOf(raw?: string): Date | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const text = raw.trim()
  // 纯日期：`Date.parse('2026-10-01')` 会按 UTC 零点算，在北京时间等于 08:00
  // —— 而全项目（日记/提炼）都按 Asia/Shanghai 理解「某一天」，这里必须一致，
  // 否则传 date-only 的 as_of 会整体错位 8 小时（评审 2026-11-02 发现）。
  if (DATE_ONLY_PATTERN.test(text)) {
    return new Date(zonedDayStart(text, DEFAULT_TIMEZONE))
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) {
    throw new Error(`memory_search: as_of 不是合法日期「${raw}」（支持 ISO 8601，如 2026-10-01）`)
  }
  return new Date(at)
}

/** 把工具入参翻译成 ES 过滤条件；团队库在无收窄条件时补 365 天兜底 */
function buildMeta(
  input: SearchInput,
  now: Date,
): { meta: MetaFilterOptions; filtered: boolean; asOf: Date | undefined } {
  // 阶段 7.1 / 9.3 / 9.5：identity / persona / journal 默认不进普通检索。
  // 它们分别是「我是谁」「我的人格」「某一天的回顾」，混在事实里只会挤占召回
  // （2026-10-31 实测：persona 条目能排到第 1、第 2 名）。
  // 用户显式在 memory_type 里点了某几类时，只放行被点的那几类。
  const selectedTypes = Array.isArray(input.memory_type) ? input.memory_type : []
  const excludedTypes = NON_FACT_MEMORY_TYPES.filter((type) => !selectedTypes.includes(type))
  const meta: MetaFilterOptions = {
    status: 'active',
    memory_type: input.memory_type,
    excludeMemoryTypes: excludedTypes.length > 0 ? [...excludedTypes] : undefined,
    domain: input.domain,
    now,
  }
  if (input.time_range !== undefined && input.time_range.trim() !== '') {
    meta.updatedWithinDays = parseTimeRangeDays(input.time_range)
  }
  const asOf = parseAsOf(input.as_of)
  if (asOf !== undefined) meta.asOf = asOf
  const narrowed = Boolean(
    (input.memory_type && input.memory_type.length > 0) ||
      (input.domain && input.domain.length > 0) ||
      meta.updatedWithinDays !== undefined ||
      asOf !== undefined,
  )
  return { meta, filtered: narrowed, asOf }
}

/**
 * 编排：并发取两路 → 库内 RRF → 跨库合并（个人加权 + 去重）→ margin 判空 → 投影。
 */
export async function searchMemories(deps: SearchDeps, input: SearchInput): Promise<SearchResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const query = (input.query ?? '').trim()
  // 查询扩展只算一次，BM25 与向量共用（实测依据见 RetrievalConfig.synonyms）
  const expandedQuery = expandQuery(query, deps.retrieval.synonyms)
  if (query === '') throw new Error('memory_search: query 不能为空')

  const scope: SearchScope = input.scope ?? 'both'
  if (!SCOPES.includes(scope)) throw new Error(`memory_search: 未知 scope「${String(scope)}」`)
  const limit = clampLimit(input.limit, deps.retrieval.limit)
  const detail: DetailLevel = input.detail ?? deps.retrieval.defaultDetail ?? 'full'
  if (!DETAIL_LEVELS.includes(detail)) {
    throw new Error(`memory_search: 未知 detail「${String(input.detail)}」（只支持 ${DETAIL_LEVELS.join(' / ')}）`)
  }
  const now = deps.now?.() ?? new Date()
  const { meta, filtered, asOf } = buildMeta(input, now)

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
    // 团队索引**没有** created_at：晋升时写的是 source_created_at（个人原条目的创建时间）。
    // 不显式指定的话，as_of 的 range(created_at) 会命中 0 条 → 团队知识被静默全部滤掉
    // （2026-11-02 评审实测：同查询不带 as_of 命中 3 条、带上就 0 条，而库里 <= 该日期的有 228 条）。
    asOfField: 'source_created_at',
  }

  // 团队库的审核闸（S9）：pending（待人工裁决）/ rejected（已驳回）都不该出现在检索结果里。
  // 个人库没有 review_state 字段，所以只能加在 teamMeta 上，不能塞进共用的 meta。
  const teamReviewFilter = ['auto', 'approved'] as const

  // 向量失败 → 降级为纯 BM25（不抛：检索还能用）
  let vector: number[] | null = null
  let degraded = false
  if (deps.embed) {
    try {
      vector = await deps.embed.embed(expandedQuery, { signal: deps.signal })
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
  // 先收集查询、不立即发：能一次 `_msearch` 就一次（阶段 20），没有 msearch 才逐条。
  const queries: Array<{ scope: Scope; route: 'bm25' | 'knn'; index: string; body: SearchBody }> = []

  const pushQuery = (target: Scope, indexName: string, targetMeta: MetaFilterOptions): void => {
    queries.push({
      scope: target,
      route: 'bm25',
      index: indexName,
      body: bm25Body(expandedQuery, targetMeta, topK, identifiers),
    })
    if (vector) {
      queries.push({
        scope: target,
        route: 'knn',
        index: indexName,
        body: knnBody(vector, deps.dims, targetMeta, topK),
      })
    }
  }

  if (scope !== 'team') pushQuery('personal', personalIndex, meta)
  if (scope !== 'personal') {
    pushQuery('team', deps.teamIndex, { ...teamMeta, review_state: [...teamReviewFilter] })
  }

  /**
   * 跑一批子查询：能一次 `_msearch` 就一次，否则逐条。
   * 抽成函数是为了下面「权限不足时**只重跑个人库那几路**」能复用同一套逻辑。
   */
  const runQueries = async (
    list: Array<{ scope: Scope; route: 'bm25' | 'knn'; index: string; body: SearchBody }>,
  ): Promise<Array<{ scope: Scope; route: 'bm25' | 'knn'; hits: Hit[] }>> => {
    const msearch = deps.reader.msearch
    if (msearch !== undefined && list.length > 1) {
      // 一次往返打完全部子查询。ES 允许 `_msearch` 跨索引，响应顺序与请求严格一致；
      // 任一条失败会整体抛（见 http.ts 的 msearch），与逐条版「任一路出错就失败」同一语义。
      const results = await msearch.call(
        deps.reader,
        list.map((item) => ({ index: item.index, body: item.body })),
        { signal: deps.signal },
      )
      return list.map((item, index) => ({
        scope: item.scope,
        route: item.route,
        hits: results[index]?.hits ?? [],
      }))
    }
    return Promise.all(
      list.map(async (item) => ({
        scope: item.scope,
        route: item.route,
        hits: (await deps.reader.search(item.index, item.body, { signal: deps.signal })).hits,
      })),
    )
  }

  /**
   * true = 团队库这一路被跳过（见下面 catch 里的权限降级）。
   * 只用于内部构造（不再建 team 分组、basis 里不写 personal+team）；
   * 对外的信号走 `degraded`（SearchResult 本来就有这个字段）。
   */
  let teamUnavailable = false

  let settled: Array<{ scope: Scope; route: 'bm25' | 'knn'; hits: Hit[] }>
  try {
    settled = await runQueries(queries)
  } catch (err) {
    // 权限不足是**能力边界**，不是瞬时故障：个人库照常可读。
    //
    // `scripts/init-user.sh --personal-only` 建的账号只有 `mem_personal_rw_<uid>`、
    // **没有 `mem_team_read`** —— 默认 `scope=both` 会带上团队子查询，而 msearch
    // 任一条失败就整体抛（§6.5），于是整条 `memory_search` 直接 403，
    // **连自己的记忆都搜不到**（2026-11-10 审查 M12/#28）。
    //
    // 只对 `permission` 降级；**其它错误仍按 §6.5 整体抛** —— 那条「不做猜到一半
    // 结果的降级」的规矩针对的是瞬时故障（超时/网络/服务端），403 不属于那一类：
    // 它是这次调用**永远不会成功**的能力限制，猜都不用猜。
    // 显式要 `scope='team'` 的调用没有个人库可退，照旧抛。
    const kind = (err as { kind?: string }).kind
    const personalOnly = queries.filter((item) => item.scope === 'personal')
    if (kind !== 'permission' || scope !== 'both' || personalOnly.length === 0) {
      log({ tool: 'search', user: deps.userId, ms: Date.now() - startedAt, error: formatEsError(err) })
      throw err
    }
    log({ tool: 'search', user: deps.userId, event: 'team_scope_degraded', error: formatEsError(err) })
    degraded = true
    teamUnavailable = true
    // 个人库这一路再抛就让它往上抛：个人库也读不了时本来就该失败
    settled = await runQueries(personalOnly)
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
  // `teamUnavailable` = 上面那次权限降级把团队路跳过了（personal-only 档位），
  // 这时不能建一个空的 team 分组 —— 空分组会让「查了哪些库」的回执说谎。
  if (scope !== 'personal' && !teamUnavailable) {
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

  /**
   * 阶段 10：把「各路名次/原始分 + 库内 RRF」收成一张表，供回执使用。
   *
   * 只在 explain=true 时构建：它不影响排序，但遍历候选也不该白做。
   * key 用 `${scope}:${id}` —— 同一 id 只可能在一个库里，但两库可能因为
   * 同 content_sha256 被去重，带上来源才不会串。
   */
  const wantExplain = input.explain === true
  const routeSources = new Map<string, ReceiptSource>()
  if (wantExplain) {
    for (const item of settled) {
      item.hits.forEach((hit, index) => {
        const key = `${item.scope}:${hit.id}`
        const current = routeSources.get(key) ?? { rrf: 0 }
        current[item.route] = { rank: index + 1, score: hit.score }
        routeSources.set(key, current)
      })
    }
    for (const group of groups) {
      for (const hit of group.hits) {
        const key = `${group.source}:${hit.id}`
        const current = routeSources.get(key) ?? { rrf: 0 }
        current.rrf = hit.fusedScore
        routeSources.set(key, current)
      }
    }
  }

  const mergedRaw = mergeScopes(groups, { weights: { personal: PERSONAL_WEIGHT } })
  // 阶段 5.3：扩散激活（默认 alpha=0，原样返回）。放在乘子之前——
  // 它属于「相关性」，乘子是后验信号。
  const rankingCfg = deps.ranking ?? DEFAULT_RANKING
  const spread = spreadActivation(mergedRaw, rankingCfg.activationAlpha, { now })
  // 排序乘子作用在跨库合并之后：importance / 命中次数 / 新鲜度。
  // 系数默认温和（±10% 量级），归零即完全关闭。
  const ranked = applyRanking(spread, rankingCfg, now, deps.mood?.() ?? null)
  // 阶段 12：同一 domain 最多 N 条（默认 0 = 关）。放在乘子之后、切片之前——
  // 多样化的语义是「别让一个域刷屏」，而不是改变相关性打分。
  const merged = diversifyByDomain(ranked, deps.retrieval.maxPerDomain ?? 0)
  // 埋点里「查了哪些库 / 走了哪条路」必须是**实际发生的事**：
  //   · 团队权限降级后只剩个人库，不能还写 personal+team；
  //   · 路由要按「settled 里到底有没有 kNN 那一路」判，**不能沿用 degraded** ——
  //     `degraded` 现在也承载「团队库不可读」（#28），而那种情况下 kNN 照样跑了，
  //     沿用它会把 bm25+knn 误报成 bm25。
  const effectiveScope = teamUnavailable ? 'personal' : scope === 'team' ? 'team' : scope
  const ranKnn = settled.some((item) => item.route === 'knn')
  const basis = `${effectiveScope}:${ranKnn ? 'bm25+knn' : 'bm25'}`

  /**
   * 检索埋点（P1）：只回答四个问题——查了什么、召回几条、花了多久、是不是空/降级。
   *
   * **不 await、失败不抛**：埋点写失败只打日志，检索结果照常返回。
   * 理由与 §6.5 一致：观测通道的可用性不该成为记忆检索的单点故障。
   * 三个出口（no_match / low_confidence / ok）都要记，否则"空结果率"永远算不出来。
   */
  const record = (note: SearchNote, hitIds: readonly string[], extra: { margin?: number } = {}): void => {
    const recorder = deps.recorder
    const index = deps.searchLogIndex
    if (!recorder || !index) return
    const hitCount = hitIds.length
    const doc: Record<string, unknown> = {
      user_id: deps.userId,
      at: new Date().toISOString(),
      tool: 'search',
      query: query.slice(0, 500),
      // 阶段 11：归一化键（面板按簇统计）与本次返回的 memory_id（反查「被哪些问题命中过」）
      query_norm: normalizeQueryKey(query),
      hit_ids: hitIds.slice(0, MAX_RESULT_LIMIT),
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
    record('no_match', [])
    return {
      hits: [],
      ...(wantExplain ? { receipts: [] } : {}),
      note: 'no_match',
      degraded,
      filtered,
      ...(asOf === undefined ? {} : { as_of: asOf.toISOString() }),
      text: '没有找到相关记忆。',
    }
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

  /**
   * 逐库置信：abstain 只能因为「**所有**被检索的库都低置信」而拒答。
   *
   * 2026-11-02 审计实测的坑：scope=both 时只按个人库判，个人库两条窄候选就把
   * 团队库里那条 knn 0.95 / bm25 40 的强命中一起吞掉了。
   */
  const confidenceOf = (target: Scope): ReturnType<typeof judgeConfidence> => {
    if (target === primaryScope) return verdict
    const scores = settled
      .filter((item) => item.route === 'knn' && item.scope === target)
      .flatMap((item) => item.hits.map((hit) => hit.score))
      .sort((a, b) => b - a)
    const bm25 = settled
      .filter((item) => item.route === 'bm25' && item.scope === target)
      .flatMap((item) => item.hits.map((hit) => hit.score))
      .sort((a, b) => b - a)[0] ?? 0
    return judgeConfidence({ top1: scores[0] ?? null, top2: scores[1] ?? null, bm25Top1: bm25 }, deps.confidence)
  }
  const searchedScopes: Scope[] = scope === 'both' ? ['personal', 'team'] : [scope]
  const allScopesLow = searchedScopes.every((target) => confidenceOf(target).low)

  // 召回质量开关（默认关）：判成低置信就拒答，而不是「照给 5 条 + 一句提示」。
  // 2026-11-02 A/B：43 条契约里 should 失败 10 → 3（7 条噪声全修，零误伤）。
  // 仍记 search_log（note=no_match），面板的缺口清单会如实把它算成「问过但没答上」。
  if (verdict.low && allScopesLow && deps.retrieval.abstainOnLowConfidence === true) {
    // 三条出口（no_match / low_confidence / ok）都要有结构化日志，否则排查时少一条线索
    log({
      tool: 'search',
      user: deps.userId,
      event: 'abstained',
      hits: 0,
      degraded,
      margin,
      scopes: searchedScopes,
    })
    record('no_match', [], margin === undefined ? {} : { margin })
    return {
      hits: [],
      ...(wantExplain ? { receipts: [] } : {}),
      note: 'no_match',
      degraded,
      filtered,
      ...(asOf === undefined ? {} : { as_of: asOf.toISOString() }),
      text: '没有找到足够相关的记忆（候选区分度不足，已按配置拒答）。可以换个说法、加 domain / memory_type 收窄再试。',
    }
  }

  const topMerged = merged.slice(0, limit)
  const hits = topMerged.map((hit) => projectHit(hit, PROJECT_MAX_CHARS, hit.origin, { detail }))

  // 阶段 10：回执与 hits **逐条同序**，且不参与任何打分（纯解释）。
  const receipts = wantExplain
    ? buildHitReceipts({
        hits: topMerged,
        routes: routeSources,
        weights: { personal: PERSONAL_WEIGHT },
        identifiers,
      })
    : undefined
  const explainText = receipts === undefined || receipts.length === 0 ? '' : `\n\n${renderReceipts(receipts)}`

  // 阶段 9：把命中记进短期缓存（内存、TTL 30 分钟）。
  // 写入侧的「原样再摄取」判据靠它——不能拿全库比，全库高相似是值钱的同义改写。
  // 不 await、不抛：这是给下一次 save 用的旁路信息，失败也不影响本次检索。
  try {
    deps.recallCache?.record(
      deps.userId,
      hits.map((hit) => ({ memoryId: hit.memory_id, content: hit.content })),
    )
  } catch (err) {
    log({ tool: 'search', event: 'recall_cache_failed', error: String(err).slice(0, 200) })
  }

  // 命中回写：fire-and-forget，失败只记日志——观测通道的可用性不该拖累检索。
  // 三个信号一起写：hit_count（累计次数，永不衰减）、activation（累计强度，消费时衰减）、
  // last_hit_at（衰减的基准时刻）。阶段 9 之前 activation 只在写入时置 0、从没有人更新，
  // 于是扩散激活里的「强度加权」永远拿不到数据——现在在这里接上。
  if (deps.hitRecorder !== null && deps.hitRecorder !== undefined && topMerged.length > 0) {
    const stamp = now.toISOString()
    const recorder = deps.hitRecorder
    const updates = topMerged.map((hit) => ({
      index: hit.origin === 'team' ? deps.teamIndex : personalIndex,
      id: hit.id,
      script: { source: HIT_UPDATE_SCRIPT, params: { now: stamp } },
    }))
    if (typeof recorder.bulkUpdateScript === 'function') {
      // 阶段 20：一次 `_bulk` 写完。部分失败只记一条汇总日志——回写是观测通道，
      // 坏一条不该让整次检索失败，也不该刷 N 条日志把真错误淹掉。
      void recorder
        .bulkUpdateScript(updates)
        .then((results) => {
          const failed = results.filter((item) => !item.ok)
          if (failed.length > 0) {
            log({
              tool: 'search',
              event: 'hit_record_partial',
              failed: failed.length,
              total: results.length,
              first_error: failed[0]?.error ?? '',
            })
          }
        })
        .catch((err: unknown) => {
          log({ tool: 'search', event: 'hit_record_degraded', error: formatEsError(err) })
        })
    } else {
      // 没有 bulk 能力（测试里的手写 fake / 旧实现）：退回逐条，语义完全一致
      void Promise.all(
        updates.map((item) =>
          recorder.updateScript(item.index, item.id, item.script).catch((err: unknown) => {
            log({ tool: 'search', event: 'hit_record_degraded', error: formatEsError(err) })
          }),
        ),
      )
    }
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
    record('low_confidence', hits.map((hit) => hit.memory_id), margin === undefined ? {} : { margin })
    return {
      hits,
      ...(receipts === undefined ? {} : { receipts }),
      note: 'low_confidence',
      degraded,
      filtered,
      ...(asOf === undefined ? {} : { as_of: asOf.toISOString() }),
      text: `${LOW_CONFIDENCE_HINT}\n${renderText(hits)}${explainText}`,
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
  record('ok', hits.map((hit) => hit.memory_id), margin === undefined ? {} : { margin })
  return {
    hits,
    ...(receipts === undefined ? {} : { receipts }),
    note: 'ok',
    degraded,
    filtered,
    ...(asOf === undefined ? {} : { as_of: asOf.toISOString() }),
    text: `${renderText(hits)}${explainText}`,
  }
}

/**
 * 回执的文本形态。
 *
 * 模型只能看到 `render` 输出的 text，所以 `explain=true` 时必须把理由也写进 text，
 * 否则 receipts 只活在结构化返回值里、模型永远看不到——那等于没做。
 */
export function renderReceipts(receipts: readonly HitReceipt[]): string {
  const lines = receipts.map((item, index) => {
    const routes: string[] = []
    if (item.bm25_rank !== undefined) routes.push(`BM25 第${item.bm25_rank}`)
    if (item.knn_rank !== undefined) {
      const cos = item.knn_score === undefined ? '' : `（cos ${item.knn_score.toFixed(3)}）`
      routes.push(`kNN 第${item.knn_rank}${cos}`)
    }
    const weight = item.sourceWeight === 1 ? '' : ` ×${item.sourceWeight}`
    const flow = `rrf ${item.rrf.toFixed(4)}${weight} → ${item.final.toFixed(4)}`
    const ids = item.identifiers.length === 0 ? '' : ` · 标识符 ${item.identifiers.join(',')}`
    const agree = item.reasons.includes('agree') ? ' · 两路一致' : ''
    const ranked = item.reasons.includes('ranked-up')
      ? ' · 乘子上调'
      : item.reasons.includes('ranked-down')
        ? ' · 乘子下调'
        : ''
    return `${index + 1}. ${item.memory_id}（${item.source}）${routes.join(' · ')} · ${flow}${ids}${agree}${ranked}`
  })
  return `命中理由（explain）：\n${lines.join('\n')}`
}

const DESCRIPTION = [
  '按「一句事实」检索个人 + 团队记忆库：关键词与语义混合。',
  '—— 该用我：动手前确认「以前怎么定的」；用户说「之前说过 / 记过」；遇到似曾相识的报错；需要某条具体的约定、口径、踩坑。',
  '—— 别用我：找方案 / 复盘 / 开发文档这类长文（用 doc_search）；已知 memory_id 要读全文（用 memory_get）；还没查过就想存（先查再存，否则重复写会命中去重）。',
  '同一问题最多查一次，拿到结果就往前走；查不到就问人，不要凭印象编。',
  '返回正文截断 500 字、不带向量。note 含义：ok 正常；no_match 确实没有；low_confidence 候选区分度不足（结果照给，但要谨慎采信）；degraded 向量不可用、本轮只走了关键词。',
  '想省 context 传 detail=summary（摘要 + 120 字）；要全文用 memory_get 按 id 展开。',
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
        description:
          '按记忆类型收窄（可多选）：preference / fact / task_progress / decision / context / identity。**identity 默认不返回**，要读自述必须显式选它。',
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
      explain: {
        type: 'boolean',
        description:
          'true 时附「命中回执」：每条的各路名次与原始分、RRF 分、乘子前后分、入选原因（两路一致/仅关键词/标识符命中）。默认关（省 token）；想核对「为什么这条排第一」或怀疑排序有问题时再开。',
      },
      as_of: {
        type: 'string',
        description:
          '阶段 13 时间点回看：只返回该时间点之前创建的记忆（ISO 8601，如 2026-10-01 或 2026-10-01T12:00:00Z；只写日期时按 Asia/Shanghai 当天 00:00 解释）。近似语义——看到的是条目现在的内容，不是当时的旧版本。',
      },
      detail: {
        type: 'string',
        enum: [...DETAIL_LEVELS],
        description:
          '返回详略：full（默认，正文最多 500 字）/ summary（摘要 + 正文 120 字，省 token；要全文用 memory_get 展开）。',
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
                summary: { type: 'string' },
                has_more: { type: 'boolean' },
              },
            },
          },
          receipts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                memory_id: { type: 'string', required: true },
                source: { type: 'string', required: true },
                bm25_rank: { type: 'number' },
                bm25_score: { type: 'number' },
                knn_rank: { type: 'number' },
                knn_score: { type: 'number' },
                rrf: { type: 'number', required: true },
                sourceWeight: { type: 'number', required: true },
                final: { type: 'number', required: true },
                reasons: { type: 'array', required: true, items: { type: 'string' } },
                identifiers: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          note: { type: 'string', required: true },
          as_of: { type: 'string' },
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
