/**
 * `doc_search` —— 检索个人文档库（`personal_doc_<uid>`）。
 *
 * 与 `memory_search` 分开是刻意的：
 *  · 记忆是「一句能独立成立的事实」，文档是长文切成 chunk 的片段；
 *  · 混在一个索引里，要么被 4000 字符上限截断，要么让记忆检索被碎片淹掉。
 *
 * 检索方式与记忆一致（BM25 + kNN → RRF），但**结果按 doc_id 聚合**：
 * 同一篇命中多个 chunk 时，用户要的是「哪篇相关 + 最相关的那段」，不是一屏同名碎片。
 *
 * @module dsh-memory-es/memory/doc-search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Embedder } from '../embedding.ts'
import type { EsClient } from '../es/http.ts'
import { rrfFuse, type Fused, type Hit } from '../fragment.ts'
import type { RetrievalConfig } from './search.ts'

export const MAX_DOC_RESULT_LIMIT = 20
const PROJECT_SNIPPET_CHARS = 600
/** 阶段 23 分级读取：summary 时每个片段只给这么多字（只够判断「是不是这篇」） */
const SUMMARY_SNIPPET_CHARS = 120

/**
 * 阶段 28：命中回写的 painless 脚本。只动 `last_accessed_at` 一个字段——
 * 回写不碰检索用到的任何字段，所以不会因为并发写把内容改坏。
 */
const DOC_HIT_SCRIPT = 'ctx._source.last_accessed_at = params.now'

export interface DocSearchInput {
  /** 阶段 31：留空 = 按更新时间浏览最近 N 篇（不再报错） */
  query?: string
  /**
   * 阶段 29：连归档文档一起查。缺省 false = 只查 active
   * （归档的意义就是退出日常检索；要找回时才显式深查）。
   */
  includeArchived?: boolean
  domain?: string[]
  limit?: number
  /**
   * 阶段 23 分级读取：`full`（默认，每段 600 字）/ `summary`（每段 120 字）。
   * 默认仍是 full——切默认值是行为变更，要先过契约评测与 token 对比。
   */
  detail?: 'full' | 'summary'
}

export interface DocSearchDeps {
  signal?: AbortSignal
  userId: string
  /** 文档索引前缀，实际索引 = 前缀 + userId */
  docPrefix: string
  reader: Pick<EsClient, 'search'>
  /**
   * 阶段 28：命中回写 `last_accessed_at`（热度）。可选——不给就不记。
   * 有 `bulkUpdateScript` 时一次 `_bulk` 写完，否则退回逐条 `updateScript`。
   * **失败只记日志**：热度是观测信号，不能因为它挂了把检索一起弄失败
   * （与 `search.ts` 的 hitRecorder 同一条纪律）。
   */
  writer?:
    | (Pick<EsClient, 'updateScript'> & { bulkUpdateScript?: EsClient['bulkUpdateScript'] })
    | null
  embed?: Pick<Embedder, 'embed'> | null
  /** 索引 mapping 的向量维度；与 embedder 输出不一致时抛错（换模型必须重建索引） */
  dims: number
  retrieval: RetrievalConfig
  log?: (event: Record<string, unknown>) => void
}

export type DocSearchNote = 'ok' | 'no_match' | 'degraded'

export interface DocHit {
  doc_id: string
  title: string
  score: number
  /** 命中的 chunk 数 */
  hits: number
  section_path: string
  snippet: string
}

export interface DocSearchResult {
  docs: DocHit[]
  note: DocSearchNote
  /** true = 向量不可用，本次只走了 BM25 */
  degraded: boolean
  text: string
}

function clampLimit(requested: number | undefined, fallback: number): number {
  const value = requested === undefined ? fallback : requested
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(MAX_DOC_RESULT_LIMIT, Math.trunc(value)))
}

/**
 * 关键词路：标题与描述权重高于正文。
 * 不用 dsl.ts 的 bm25Body —— 那个按「记忆」的字段（memory_type/status）构造过滤，
 * 文档索引里没有这些字段，套上去会静默筛成 0 条。
 */
/**
 * 阶段 29：默认只查 active。归档的意义就是「不再出现在日常检索里」——
 * 如果默认还查得到，「归档」只是给文档贴了个标签。
 * `includeArchived` 时**完全不加 status 条件**（不是 status: [active, archived]）：
 * 后者会让本来没有 status 字段的老文档永远漏掉。
 */
function docStatusFilter(includeArchived: boolean): Record<string, unknown>[] {
  return includeArchived ? [] : [{ term: { status: 'active' } }]
}

/**
 * 阶段 31：空 query = 浏览（对齐 mnemon「空查询 = 最近文档」）。
 *
 * 为什么不做成「空 query 走 BM25」：没有查询词时 BM25 无意义（match_all 的分数恒为 1），
 * 排序只能靠时间——那还不如把 sort 显式写出来，让「最近更新」这件事在代码里可见。
 * 取 `limit * 5` 个 chunk：同一篇会被切成多块，按 doc_id 聚合后会缩水。
 */
function docRecentBody(domain: string[] | undefined, limit: number, includeArchived: boolean) {
  const filter: Record<string, unknown>[] = [...docStatusFilter(includeArchived)]
  if (domain && domain.length > 0) filter.push({ terms: { domain } })
  return {
    size: limit * 5,
    query: { bool: { filter } },
    sort: [{ updated_at: { order: 'desc' } }],
    _source: { excludes: ['embedding'] },
  }
}

function docBm25Body(query: string, domain: string[] | undefined, topK: number, includeArchived: boolean) {
  const filter: Record<string, unknown>[] = [...docStatusFilter(includeArchived)]
  if (domain && domain.length > 0) filter.push({ terms: { domain } })
  return {
    size: topK,
    _source: { excludes: ['embedding'] },
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query,
              fields: ['title^3', 'description^2', 'content^2', 'section_path'],
            },
          },
        ],
        ...(filter.length > 0 ? { filter } : {}),
      },
    },
  }
}

/** 向量路：knn.filter 没有条件时**整个字段都不给**（传 null 会 400） */
function docKnnBody(
  vector: readonly number[],
  dims: number,
  domain: string[] | undefined,
  topK: number,
  includeArchived: boolean,
) {
  if (vector.length !== dims) {
    throw new Error(`doc_search: 向量维度 ${vector.length} 与索引 dims ${dims} 不一致（换模型必须重建索引）`)
  }
  const filter: Record<string, unknown>[] = [...docStatusFilter(includeArchived)]
  if (domain && domain.length > 0) filter.push({ terms: { domain } })
  return {
    size: topK,
    _source: { excludes: ['embedding'] },
    knn: {
      field: 'embedding',
      query_vector: [...vector],
      k: topK,
      num_candidates: topK * 5,
      // knn.filter 没有条件时**整个字段都不给**（传 null 或空 filter 会 400）
      ...(filter.length > 0 ? { filter: { bool: { filter } } } : {}),
    },
  }
}

/**
 * 阶段 31：把「命中 chunk」聚合成「文档」并渲染成给模型看的文本。
 *
 * 抽成独立函数是为了让**浏览模式**（空 query）与**检索模式**共用同一套聚合与排版：
 * 两条路只是「怎么拿到 hits」不同，后面「同一篇多块合并、取最佳片段、截断」完全一样。
 * 分开写两份的话，将来改 snippet 长度或排序会只改到一条路。
 */
function assembleDocs(
  deps: DocSearchDeps,
  fused: Fused[],
  opts: { startedAt: number; limit: number; detail: DocSearchInput['detail']; degraded: boolean; browseMode: boolean; log: (event: Record<string, unknown>) => void },
): DocSearchResult {
  const { limit, detail, degraded, log } = opts
// 按 doc_id 聚合：同一篇的多个 chunk 合并成一条，取最相关的片段做摘要
const perDoc = new Map<
  string,
  { doc_id: string; title: string; score: number; hits: number; best: { score: number; section: string; content: string } }
>()
for (const f of fused) {
  const src = f.source as Record<string, unknown>
  const docId = typeof src.doc_id === 'string' ? src.doc_id : f.id
  const entry = perDoc.get(docId) ?? {
    doc_id: docId,
    title: typeof src.title === 'string' ? src.title : '',
    score: 0,
    hits: 0,
    best: { score: -1, section: '', content: '' },
  }
  entry.score += f.fusedScore
  entry.hits += 1
  const chunkScore = f.fusedScore
  if (chunkScore > entry.best.score) {
    entry.best = {
      score: chunkScore,
      section: typeof src.section_path === 'string' ? src.section_path : '',
      content: typeof src.content === 'string' ? src.content : '',
    }
  }
  perDoc.set(docId, entry)
}

const docs: DocHit[] = [...perDoc.values()]
  .sort((a, b) => b.score - a.score)
  .slice(0, limit)
  .map((d) => ({
    doc_id: d.doc_id,
    title: d.title,
    score: Number(d.score.toFixed(5)),
    hits: d.hits,
    section_path: d.best.section,
    snippet: d.best.content.slice(0, detail === 'summary' ? SUMMARY_SNIPPET_CHARS : PROJECT_SNIPPET_CHARS),
  }))

log({
  tool: 'doc_search',
  user: deps.userId,
  ms: Date.now() - opts.startedAt,
  docs: docs.length,
  chunks: fused.length,
  degraded,
})

if (docs.length === 0) {
    return {
      docs: [],
      note: opts.browseMode ? 'ok' : degraded ? 'degraded' : 'no_match',
      degraded,
      text: opts.browseMode ? '还没有任何文档。' : '没有找到相关文档。',
    }
  }

const lines = docs.map((d, i) => {
  const where = d.section_path ? `\n   位置：${d.section_path}` : ''
  return `[${i + 1}] ${d.title}（命中 ${d.hits} 块）${where}\n    ${d.snippet.replace(/\n/g, '\n    ')}`
})
return {
  docs,
  note: degraded ? 'degraded' : 'ok',
  degraded,
  text: `相关文档 ${docs.length} 篇（${degraded ? '仅关键词' : '关键词+向量'}）：\n\n${lines.join('\n\n')}`,
}
}

export async function searchDocs(deps: DocSearchDeps, input: DocSearchInput): Promise<DocSearchResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const query = (input.query ?? '').trim()
  // 阶段 31：空 query 不再是错误，而是「按更新时间浏览最近文档」。
  // 注意浏览**不记热度**（不动 last_accessed_at）——否则 daily-report 的
  // 「90 天冷文档」会被自己翻一遍就洗白，那条指标就失去意义。
  const browseMode = query === ''

  const limit = clampLimit(input.limit, deps.retrieval.limit)
  const index = `${deps.docPrefix}${deps.userId}`
  const topK = Math.max(deps.retrieval.topK, limit * 4)
  const domain = input.domain && input.domain.length > 0 ? input.domain : undefined
  const includeArchived = input.includeArchived === true

  if (browseMode) {
    const recent = await deps.reader.search(index, docRecentBody(domain, limit, includeArchived), { signal: deps.signal })
    // 浏览模式没有「相关性」可言，给一个随名次递减的合成分，让下游聚合/排序有确定的次序
    const ranked: Fused[] = recent.hits.map((h, i) => ({
      ...h,
      routeRanks: [i + 1],
      fusedScore: 1 / (deps.retrieval.rrfK + i + 1),
    }))
    return assembleDocs(deps, ranked, { startedAt, limit, detail: input.detail, degraded: false, browseMode: true, log })
  }

  let vector: number[] | null = null
  let degraded = false
  if (deps.embed) {
    try {
      vector = await deps.embed.embed(query, { signal: deps.signal })
    } catch (err) {
      degraded = true
      log({ tool: 'doc_search', user: deps.userId, event: 'embedding_degraded', kind: (err as { kind?: string })?.kind ?? 'unknown' })
    }
  } else {
    degraded = true
  }

  const routes: Array<Promise<Hit[]>> = [
    deps.reader.search(index, docBm25Body(query, domain, topK, includeArchived), { signal: deps.signal }).then((r) => r.hits),
  ]
  if (vector) {
    routes.push(
      deps.reader
        .search(index, docKnnBody(vector, deps.dims, domain, topK, includeArchived), { signal: deps.signal })
        .then((r) => r.hits),
    )
  }

  const hits = await Promise.all(routes)
  const fused = rrfFuse(hits, deps.retrieval.rrfK)

  // 阶段 28：命中回写热度。fire-and-forget，失败只记日志——
  // 热度是观测信号，它的可用性不该拖累检索（与 search.ts 的命中回写同一纪律）。
  // 回写 fused（本次检索的命中候选），不是最终截断后的那几条：热度记的是
  // 「检索路径碰过它」，埋点口径要看的是命中面，不是展示面。
  if (deps.writer !== null && deps.writer !== undefined && fused.length > 0) {
    const stamp = new Date().toISOString()
    const writer = deps.writer
    const updates = fused.map((f) => ({
      index,
      id: f.id,
      script: { source: DOC_HIT_SCRIPT, params: { now: stamp } },
    }))
    if (typeof writer.bulkUpdateScript === 'function') {
      void writer
        .bulkUpdateScript(updates)
        .then((results) => {
          const failed = results.filter((item) => !item.ok)
          if (failed.length > 0) {
            log({
              tool: 'doc_search',
              event: 'doc_hit_record_partial',
              failed: failed.length,
              total: results.length,
              first_error: failed[0]?.error ?? '',
            })
          }
        })
        .catch((err: unknown) => {
          log({ tool: 'doc_search', event: 'doc_hit_record_degraded', error: String(err).slice(0, 200) })
        })
    } else {
      // 没有 bulk 能力（测试里的手写 fake / 旧实现）：退回逐条，语义一致
      void Promise.all(
        updates.map((item) =>
          writer.updateScript(item.index, item.id, item.script).catch((err: unknown) => {
            log({ tool: 'doc_search', event: 'doc_hit_record_degraded', error: String(err).slice(0, 200) })
          }),
        ),
      )
    }
  }

  return assembleDocs(deps, fused, { startedAt, limit, detail: input.detail, degraded, browseMode: false, log })
}

const DESCRIPTION = [
  '按「整篇长文」检索个人文档库（方案、复盘、开发文档、路线）：关键词 + 语义混合，按文档聚合返回小节路径与片段。',
  '—— 该用我：要查某个项目的方案细节 / 踩坑记录 / 接口契约 / 设计取舍，而记忆里只有一句话线索；需要一整段论述，而不是一句结论。',
  '—— 别用我：找具体约定、口径、踩坑（用 memory_search，它给「一句事实」更省 token）；想读整篇正文（这里给的是命中片段）。',
  'note：no_match 表示没有；degraded 表示向量不可用、本次只走关键词。',
  'query 留空 = 按更新时间浏览最近 N 篇（浏览**不记热度**，不会把冷文档洗白）。',
  '想省 token 传 detail=summary（每段 120 字）；要判断值不值得读原文时先用它。',
].join(' ')

export function defineDocSearchTool(deps: DocSearchDeps) {
  return defineTool({
    name: 'doc_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: '自然语言或关键词；换成用户可能的问法比堆同义词更有效。留空 = 按更新时间浏览最近 N 篇。',
      },
      domain: {
        type: 'array',
        items: { type: 'string' },
        description: '按业务域收窄（可多选），如 lottery-cloud、huoxin-data、backup-server。',
      },
      includeArchived: {
        type: 'boolean',
        description:
          '连归档文档一起查（默认 false = 只查 active）。归档文档平时不出现——'
          + '只有「我记得写过但搜不到」时才打开它；配合冷引用记忆里的 doc_id 精确定位更省。',
      },
      limit: {
        type: 'integer',
        description: `返回的文档篇数，默认取配置，上限 ${MAX_DOC_RESULT_LIMIT}。`,
      },
      detail: {
        type: 'string',
        enum: ['full', 'summary'],
        description: '详略：full（默认，每段 600 字）/ summary（每段 120 字，只够判断是不是这篇，能明显省 token）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          docs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                doc_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                score: { type: 'number', required: true },
                hits: { type: 'integer', required: true },
                section_path: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string', required: true },
          degraded: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 15_000,
    async execute(args, exec) {
      return await searchDocs({ ...deps, signal: exec.signal }, args)
    },
  })
}
