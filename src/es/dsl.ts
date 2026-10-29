/**
 * 检索 DSL 组装：只拼 JSON，不发请求（发请求在 `es/http.ts`）。
 *
 * 为什么双路分开成两个 body：ES 8.x 里 `knn` 是**顶层参数**，塞进 `query.bool.should`
 * 语法上能过但排序语义不明（文档 §8.1）。宁可两次请求，融合在应用侧做（RRF，见 fragment.ts）。
 *
 * 两个默认值别随手改：
 *  · `_source.excludes: ['embedding']` —— M2 判据要求 `_source` 不返回向量（省带宽、也免得把
 *    向量塞进模型的上下文）；
 *  · 过滤一律放 `filter` 而不是 `must` —— filter 不参与打分、可被缓存。
 *
 * @module dsh-memory-es/es/dsl
 */

/** 命中里不回传的字段（向量只用于检索，不给模型看） */
export const DEFAULT_SOURCE_EXCLUDES: readonly string[] = ['embedding']

/** 团队库的兜底时间窗（文档 §8.2：缺过滤条件时按最近 365 天收窄） */
export const DEFAULT_TEAM_WINDOW_DAYS = 365

export interface EsTermFilter {
  term: Record<string, string>
}

export interface EsTermsFilter {
  terms: Record<string, string[]>
}

export interface EsRangeFilter {
  range: Record<string, { gte?: string; lte?: string; lt?: string; gt?: string }>
}

export interface EsExistsFilter {
  exists: { field: string }
}

/** `must_not` 里可以放任意过滤（阶段 3 用它表达「字段不存在」「未过期」） */
export interface EsBoolFilter {
  bool: { must_not: EsFilter[] }
}

export type EsFilter = EsTermFilter | EsTermsFilter | EsRangeFilter | EsExistsFilter | EsBoolFilter

/** 单值写 string，多值写 string[] —— 多值走 `terms`（命中任一即可） */
export type FilterValue = string | string[]

export interface MetaFilterOptions {
  /** 状态；默认 'active'，传 null 表示不加状态条件（排障/审计时用） */
  status?: string | null
  memory_type?: FilterValue
  domain?: FilterValue
  /** updated_at >= now - N 天；不传就不加时间窗 */
  updatedWithinDays?: number
  /**
   * 只取这些 review_state（**只在团队库用**）。
   * 个人索引没有 `review_state` 字段，`dynamic: strict` 下拿它查询不会报错但会查空，
   * 所以调用方要按索引区分（见 search.ts 的 teamMeta）。
   * 传 null/undefined = 不加这个条件（审核台、迁移排查时用）。
   */
  review_state?: FilterValue | null
  /** 注入当前时间，便于测试断言（默认 new Date()） */
  now?: Date
}

// 用 type 而不是 interface：type 字面量类型能隐式满足 Record<string, unknown>，
// 这样 `client.search(idx, bm25Body(...))` 不需要额外断言。
export type SearchBody = {
  size: number
  _source: { excludes: string[]; includes?: string[] }
  query?: Record<string, unknown>
  knn?: Record<string, unknown>
  sort?: Array<Record<string, 'asc' | 'desc'>>
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是 ≥1 的整数，收到 ${String(value)}`)
  }
}

/**
 * 组装过滤条件。顺序稳定（status → memory_type → domain → 时间窗），便于测试与日志比对。
 */
/** 单值 → `term`，多值 → `terms`；空数组直接跳过（“一个都不选”不等于“不筛”） */
function pushValueFilter(filters: EsFilter[], field: string, value: FilterValue | null | undefined): void {
  if (value === undefined || value === null) return
  const values = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter((v) => v !== '')
  if (values.length === 0) return
  if (values.length === 1) filters.push({ term: { [field]: values[0] } })
  else filters.push({ terms: { [field]: values } })
}

/**
 * 阶段 3 的两条「时效」过滤：被取代的条目、已过期的条目都不返回。
 *
 * 为什么抽成函数：测试要能原样引用这两条，否则每加一条过滤就得在 6 个用例里
 * 手抄一遍期望值，抄错一次就是假绿。
 */
export function freshOnlyFilters(now: Date): EsFilter[] {
  return [
    // 用 `must_not exists` 而不是 `term: null`：字段缺失与字段为 null 是两回事，
    // 前者才是「没有值」的稳妥判据。
    { bool: { must_not: [{ exists: { field: 'superseded_by' } }] } },
    // 不存在的 expires_at 不会被 range 匹配，所以 must_not range 天然保留它们
    { bool: { must_not: [{ range: { expires_at: { lt: now.toISOString() } } }] } },
  ]
}

export function buildFilters(options: MetaFilterOptions = {}): EsFilter[] {
  const filters: EsFilter[] = []
  const now = options.now ?? new Date()
  const status = options.status === undefined ? 'active' : options.status
  if (status !== null) {
    filters.push({ term: { status } })
  }
  pushValueFilter(filters, 'memory_type', options.memory_type)
  pushValueFilter(filters, 'domain', options.domain)
  pushValueFilter(filters, 'review_state', options.review_state ?? null)

  if (options.updatedWithinDays !== undefined) {
    assertPositiveInt(options.updatedWithinDays, 'updatedWithinDays')
    const gte = new Date(now.getTime() - options.updatedWithinDays * 86_400_000).toISOString()
    filters.push({ range: { updated_at: { gte } } })
  }
  // 时效过滤放最后：语义上它们是「兜底排除」，与业务维度（status/type/domain/时间窗）分开
  filters.push(...freshOnlyFilters(now))
  return filters
}

/**
 * 标识符专用字段：用 `standard` 分析器存一份正文。
 * IK 会把 `lot.bd_write_sync` 切碎（实测 BM25 只有 13.9），standard 按 UAX#29
 * 保留完整 token，中文仍逐字可搜。
 */
export const IDENTIFIER_FIELD = 'content_exact'

/** 标识符提权倍数：实测 q20 的 BM25 从 13.6 → 38.0（boost=5），刚好越过放行门槛 */
export const IDENTIFIER_BOOST = 5

/**
 * 从查询里挑出「像标识符」的片段，用于 content_exact 的精确短语匹配。
 *
 * 判定刻意保守——只有下面任一条成立才算：
 *  · 含分隔符 `._:/@#`（lot.bd_write_sync、docker-compose.yml、ssh.example.com）
 *  · 驼峰（ZooKeeper、createOrder）
 *  · 字母数字混合（E101、PM2、HTTP2）
 *
 * **纯字母缩写（TLS / CLI / API / TTL / OSD）不算**：它们是通用术语，不是标识符。
 * 实测把 TLS 当标识符时，库里 SSL 证书相关的记忆被 phrase 命中、boost 5，
 * 让一条 Kubernetes 噪声查询的 BM25 从 25.8 冲到 65.6，直接放行。
 * 排除的办法不是维护黑名单（会漂移），而是要求「缩写必须含数字」。
 *
 * 普通英文单词（docker、lazy）同样不算：IK 下已能正常召回，加进 should 只会引入噪声。
 */
export function extractIdentifiers(text: string, max = 5): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9_.:/@#-]{2,}/g) ?? []) {
    const token = raw.replace(/[._:/@#-]+$/, '') // 去掉尾部分隔符
    if (token.length < 3 || seen.has(token)) continue
    const hasLetter = /[A-Za-z]/.test(token)
    const looksLike =
      /[._:/@#]/.test(token) || // 分隔符
      /[a-z][A-Z]/.test(token) || // 驼峰
      (hasLetter && /\d/.test(token)) // 字母数字混合（含 E101 / PM2）
    if (!looksLike) continue
    seen.add(token)
    out.push(token)
    if (out.length >= max) break
  }
  return out
}

/** BM25 一路：content 权重 2、semantic_keywords 权重 1.5（文档 §8.1 的字段权重） */
export function bm25Body(
  query: string,
  options: MetaFilterOptions = {},
  topK = 20,
  identifiers: readonly string[] = [],
): SearchBody {
  const q = query.trim()
  if (q === '') throw new Error('bm25Body: query 不能为空')
  assertPositiveInt(topK, 'topK')
  const bool: Record<string, unknown> = {
    must: [
      {
        multi_match: {
          query: q,
          // summary 是蒸馏产出的一句话，检索时也要吃（否则辛苦蒸馏的摘要白存）
          fields: ['content^2', 'summary^1.5', 'semantic_keywords^1.5'],
          type: 'best_fields',
        },
      },
    ],
    filter: buildFilters(options),
  }
  // 标识符精确匹配作为加分项：must 里已经有主查询，should 不命中也不影响召回，
  // 命中则把「精确问到某个函数/任务名」的结果顶上来。
  if (identifiers.length > 0) {
    bool.should = identifiers.map((token) => ({
      match_phrase: { [IDENTIFIER_FIELD]: { query: token, boost: IDENTIFIER_BOOST } },
    }))
  }
  return {
    size: topK,
    _source: { excludes: [...DEFAULT_SOURCE_EXCLUDES] },
    query: { bool },
  }
}

/**
 * kNN 一路：`num_candidates` 取 k 的 5 倍（ES 推荐区间；只在过滤后的集合里展开）。
 * `dims` 必须与索引 mapping 一致——换 embedding 模型（维度变了）必须重建索引，
 * 这里提前抛错比让 ES 返回 400 更容易看懂。
 */
export function knnBody(
  vector: readonly number[],
  dims: number,
  options: MetaFilterOptions = {},
  topK = 20,
): SearchBody {
  assertPositiveInt(dims, 'dims')
  assertPositiveInt(topK, 'topK')
  if (vector.length !== dims) {
    throw new Error(`knnBody: 向量维度 ${vector.length} 与索引 dims ${dims} 不一致（换模型必须重建索引）`)
  }
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`knnBody: 向量第 ${i} 维不是有限数（${String(v)}）`)
    }
  }
  return {
    size: topK,
    _source: { excludes: [...DEFAULT_SOURCE_EXCLUDES] },
    knn: {
      field: 'embedding',
      query_vector: [...vector],
      k: topK,
      num_candidates: topK * 5,
      filter: buildFilters(options),
    },
  }
}

/**
 * 精确去重查询：按 `content_sha256` + 状态命中至多一条，给 `memory_save` 的幂等闸用。
 *
 * 为什么用 term 而不是 BM25 相似度：内容完全相同才算重复（§7.4 的幂等口径是
 * “归一化后正文哈希”），相似度召回会把「改了一个词的新事实」判成重复，那是错的。
 */
export function dedupeBody(sha256: string, options: { status?: string | null } = {}): SearchBody {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('dedupeBody: 需要 64 位小写十六进制 sha256')
  }
  return {
    size: 1,
    _source: { excludes: [...DEFAULT_SOURCE_EXCLUDES] },
    query: {
      bool: {
        filter: [{ term: { content_sha256: sha256 } }, ...buildFilters({ status: options.status })],
      },
    },
  }
}

/**
 * 解析 `time_range` 形态的表达式（文档 §6.3：`now-180d`）成「多少天」，喂给 `updatedWithinDays`。
 *
 * 只支持 `now-<数字><单位>`，单位 d/h/m：小时/分钟不足一天时向上取整为 1 天
 * （宁可多取一点，也不要因为 floor 掉成 0 天而把时间窗收成「此刻」）。
 * 非法输入直接抛错——静默忽略会让模型以为过滤生效了。
 */
export function parseTimeRangeDays(expression: string): number {
  const matched = /^now-(\d+)([dhm])$/.exec(expression.trim())
  if (!matched) {
    throw new Error(`time_range 只支持 now-<数字><d|h|m> 形式（收到「${expression}」）`)
  }
  const amount = Number(matched[1])
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error(`time_range 的数字必须 ≥1（收到「${expression}」）`)
  }
  const unit = matched[2]
  if (unit === 'd') return amount
  const days = amount / (unit === 'h' ? 24 : 1440)
  return Math.max(1, Math.ceil(days))
}
