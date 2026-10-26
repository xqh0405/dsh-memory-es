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
import { rrfFuse, type Hit } from '../fragment.ts'
import type { RetrievalConfig } from './search.ts'

export const MAX_DOC_RESULT_LIMIT = 20
const PROJECT_SNIPPET_CHARS = 600

export interface DocSearchInput {
  query: string
  domain?: string[]
  limit?: number
}

export interface DocSearchDeps {
  signal?: AbortSignal
  userId: string
  /** 文档索引前缀，实际索引 = 前缀 + userId */
  docPrefix: string
  reader: Pick<EsClient, 'search'>
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
function docBm25Body(query: string, domain: string[] | undefined, topK: number) {
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
        ...(domain && domain.length > 0 ? { filter: [{ terms: { domain } }] } : {}),
      },
    },
  }
}

/** 向量路：knn.filter 没有条件时**整个字段都不给**（传 null 会 400） */
function docKnnBody(vector: readonly number[], dims: number, domain: string[] | undefined, topK: number) {
  if (vector.length !== dims) {
    throw new Error(`doc_search: 向量维度 ${vector.length} 与索引 dims ${dims} 不一致（换模型必须重建索引）`)
  }
  return {
    size: topK,
    _source: { excludes: ['embedding'] },
    knn: {
      field: 'embedding',
      query_vector: [...vector],
      k: topK,
      num_candidates: topK * 5,
      ...(domain && domain.length > 0
        ? { filter: { bool: { filter: [{ terms: { domain } }] } } }
        : {}),
    },
  }
}

export async function searchDocs(deps: DocSearchDeps, input: DocSearchInput): Promise<DocSearchResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const query = (input.query ?? '').trim()
  if (query === '') throw new Error('doc_search: query 不能为空')

  const limit = clampLimit(input.limit, deps.retrieval.limit)
  const index = `${deps.docPrefix}${deps.userId}`
  const topK = Math.max(deps.retrieval.topK, limit * 4)
  const domain = input.domain && input.domain.length > 0 ? input.domain : undefined

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
    deps.reader.search(index, docBm25Body(query, domain, topK), { signal: deps.signal }).then((r) => r.hits),
  ]
  if (vector) {
    routes.push(
      deps.reader
        .search(index, docKnnBody(vector, deps.dims, domain, topK), { signal: deps.signal })
        .then((r) => r.hits),
    )
  }

  const hits = await Promise.all(routes)
  const fused = rrfFuse(hits, deps.retrieval.rrfK)

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
      snippet: d.best.content.slice(0, PROJECT_SNIPPET_CHARS),
    }))

  log({
    tool: 'doc_search',
    user: deps.userId,
    ms: Date.now() - startedAt,
    docs: docs.length,
    chunks: fused.length,
    degraded,
  })

  if (docs.length === 0) {
    return { docs: [], note: degraded ? 'degraded' : 'no_match', degraded, text: '没有找到相关文档。' }
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

const DESCRIPTION = [
  '查个人文档库（长文：方案、复盘、开发文档），关键词与语义混合检索。',
  '与 memory_search 的区别：那边是「一句事实」，这里是「整篇文档」；返回按文档聚合，带命中的小节路径与片段。',
  '时机：要查某个项目的方案/踩坑记录/接口契约，而记忆里只有一句话线索时。',
  'note=no_match 表示没有；note=degraded 表示向量不可用、本次只走了关键词。',
].join(' ')

export function defineDocSearchTool(deps: DocSearchDeps) {
  return defineTool({
    name: 'doc_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '自然语言或关键词；换成用户可能的问法比堆同义词更有效。',
      },
      domain: {
        type: 'array',
        items: { type: 'string' },
        description: '按业务域收窄（可多选），如 lottery-cloud、huoxin-data、backup-server。',
      },
      limit: {
        type: 'integer',
        description: `返回的文档篇数，默认取配置，上限 ${MAX_DOC_RESULT_LIMIT}。`,
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
