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

export interface EsRangeFilter {
  range: { updated_at: { gte: string } }
}

export type EsFilter = EsTermFilter | EsRangeFilter

export interface MetaFilterOptions {
  /** 状态；默认 'active'，传 null 表示不加状态条件（排障/审计时用） */
  status?: string | null
  memory_type?: string
  domain?: string
  /** updated_at >= now - N 天；不传就不加时间窗 */
  updatedWithinDays?: number
  /** 注入当前时间，便于测试断言（默认 new Date()） */
  now?: Date
}

// 用 type 而不是 interface：type 字面量类型能隐式满足 Record<string, unknown>，
// 这样 `client.search(idx, bm25Body(...))` 不需要额外断言。
export type SearchBody = {
  size: number
  _source: { excludes: string[] }
  query?: Record<string, unknown>
  knn?: Record<string, unknown>
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是 ≥1 的整数，收到 ${String(value)}`)
  }
}

/**
 * 组装过滤条件。顺序稳定（status → memory_type → domain → 时间窗），便于测试与日志比对。
 */
export function buildFilters(options: MetaFilterOptions = {}): EsFilter[] {
  const filters: EsFilter[] = []
  const status = options.status === undefined ? 'active' : options.status
  if (status !== null) {
    filters.push({ term: { status } })
  }
  if (options.memory_type) {
    filters.push({ term: { memory_type: options.memory_type } })
  }
  if (options.domain) {
    filters.push({ term: { domain: options.domain } })
  }
  if (options.updatedWithinDays !== undefined) {
    assertPositiveInt(options.updatedWithinDays, 'updatedWithinDays')
    const now = options.now ?? new Date()
    const gte = new Date(now.getTime() - options.updatedWithinDays * 86_400_000).toISOString()
    filters.push({ range: { updated_at: { gte } } })
  }
  return filters
}

/** BM25 一路：content 权重 2、semantic_keywords 权重 1.5（文档 §8.1 的字段权重） */
export function bm25Body(query: string, options: MetaFilterOptions = {}, topK = 20): SearchBody {
  const q = query.trim()
  if (q === '') throw new Error('bm25Body: query 不能为空')
  assertPositiveInt(topK, 'topK')
  return {
    size: topK,
    _source: { excludes: [...DEFAULT_SOURCE_EXCLUDES] },
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: q,
              fields: ['content^2', 'semantic_keywords^1.5'],
              type: 'best_fields',
            },
          },
        ],
        filter: buildFilters(options),
      },
    },
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
