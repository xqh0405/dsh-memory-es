#!/usr/bin/env node
/**
 * 阶段 31：文档 ↔ 记忆建边（语义近邻），**默认不写**。
 *
 * 为什么做：文档库 5000+ 切片、记忆库 489 条，两边各自可搜，但「这条记忆见过的那份方案在哪」
 * 只能靠人再搜一次。建边的价值是把这个跳转变成一次查询。
 *
 * 为什么默认关、且只有脚本这一个入口：建边质量依赖阈值，而阈值只能靠抽样看。先把候选打出来
 * 人工判几条，再决定写不写；插件运行时路径完全不碰这件事，所以「默认关 = 行为与 31 之前一致」。
 *
 * 边的落点是**记忆侧的 `related`**（`{id, weight}`，已有字段，不需要改映射）：
 * 文档切片 id 作为普通 id 记在记忆的邻接表里，与记忆↔记忆的边同构。
 *
 * 用法：
 *   node scripts/link-docs.ts --limit=40 --show     # 抽 40 篇看候选（默认 dry-run）
 *   node scripts/link-docs.ts --limit=200 --apply   # 真的写
 */
import { createEsClient } from '../src/es/http.ts'
import { mergeEdges, readEdges } from '../src/edges.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const MIN_SCORE_DEFAULT = 0.55
const TOPK_DEFAULT = 3

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const show = argv.includes('--show')
const num = (flag: string, fallback: number): number => {
  const hit = argv.find((a) => a.startsWith(`${flag}=`))
  if (hit === undefined) return fallback
  const v = Number(hit.slice(flag.length + 1))
  return Number.isFinite(v) ? v : fallback
}
const limit = num('--limit', 50)
const minScore = num('--min-score', MIN_SCORE_DEFAULT)
const topk = num('--topk', TOPK_DEFAULT)

const cfg = parsePluginConfig(DEFAULT_CONFIG_PATH)
const es = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})
const docIndex = `${cfg.docPrefix ?? 'personal_doc_'}${cfg.userId}`
const memIndex = `${cfg.personalPrefix}${cfg.userId}`

interface DocChunk {
  id: string
  docId: string
  title: string
  section: string
  domain: string
  embedding: number[]
}

async function loadChunks(): Promise<DocChunk[]> {
  const res = await es.search(docIndex, {
    size: limit,
    query: { bool: { filter: [{ term: { status: 'active' } }, { exists: { field: 'embedding' } }] } },
    sort: [{ updated_at: { order: 'desc' } }],
    _source: ['doc_id', 'title', 'section_path', 'domain', 'embedding'],
  })
  const out: DocChunk[] = []
  for (const hit of res.hits) {
    const src = hit.source as Record<string, unknown>
    const vector = src.embedding
    if (!Array.isArray(vector) || vector.length === 0) continue
    out.push({
      id: String(hit.id ?? ''),
      docId: typeof src.doc_id === 'string' ? src.doc_id : String(hit.id ?? ''),
      title: typeof src.title === 'string' ? src.title : '',
      section: typeof src.section_path === 'string' ? src.section_path : '',
      domain: typeof src.domain === 'string' ? src.domain : 'general',
      embedding: vector as number[],
    })
  }
  return out
}

interface EdgeHit {
  memoryId: string
  score: number
  content: string
}

async function knnMemories(chunk: DocChunk): Promise<EdgeHit[]> {
  const res = await es.search(memIndex, {
    size: Math.max(topk * 3, 10),
    knn: {
      field: 'embedding',
      query_vector: chunk.embedding,
      k: 10,
      num_candidates: 50,
      // 归档/隔离/心情不进检索，也就不该被建边
      filter: { term: { status: 'active' } },
    },
    _source: ['memory_id', 'content'],
  })
  const out: EdgeHit[] = []
  for (const hit of res.hits) {
    const src = hit.source as Record<string, unknown>
    const score = typeof hit.score === 'number' ? hit.score : 0
    if (score < minScore) continue
    const memoryId = typeof src.memory_id === 'string' ? src.memory_id : String(hit.id ?? '')
    if (memoryId === '') continue
    out.push({ memoryId, score, content: String(src.content ?? '') })
  }
  return out
}

async function main(): Promise<void> {
  const chunks = await loadChunks()
  console.log(`扫描文档切片：${chunks.length} 片（阈值 ${minScore} / 每片取 ${topk} 条）${apply ? '' : '（dry-run，不写）'}`)

  // memoryId → 候选边（同一记忆被多片命中取最高分）
  const incoming = new Map<string, Map<string, number>>()
  const samples: string[] = []
  let candidateEdges = 0

  for (const chunk of chunks) {
    const hits = await knnMemories(chunk)
    for (const hit of hits.slice(0, topk)) {
      const bucket = incoming.get(hit.memoryId) ?? new Map<string, number>()
      const prev = bucket.get(chunk.id)
      if (prev === undefined || hit.score > prev) bucket.set(chunk.id, hit.score)
      incoming.set(hit.memoryId, bucket)
      candidateEdges += 1
      if (show && samples.length < 5) {
        samples.push(
          `  文档《${chunk.title}》/ ${chunk.section}\n    ↔ 记忆：${hit.content.slice(0, 60)}…（score ${hit.score.toFixed(3)}）`,
        )
      }
    }
  }

  console.log(`候选边：${candidateEdges} 条，涉及记忆 ${incoming.size} 条`)
  if (samples.length > 0) {
    console.log('\n抽样（人工判断这几对是否讲同一件事）：')
    for (const s of samples) console.log(s)
  }

  if (!apply) {
    console.log('\n（dry-run 未写入；确认质量后加 --apply）')
    return
  }

  let written = 0
  for (const [memoryId, bucket] of incoming) {
    const current = await es.get(memIndex, memoryId)
    const existing = readEdges((current.source as Record<string, unknown>).related)
    // 关键：上限必须 ≥ 已有条数 + 本次新增条数，**不允许挤掉记忆↔记忆的边**。
    // 2026-11-09 第一版用固定 12，结果 8 条记忆的原有边被文档边整组顶掉（已回滚重修）。
    // 文档边是「补充线索」，不该以删除既有邻接为代价。
    const next = mergeEdges(
      existing,
      [...bucket.entries()].map(([id, weight]) => ({ id, weight })),
      existing.length + bucket.size,
    )
    if (next.length === existing.length) continue
    await es.update(memIndex, memoryId, { related: next })
    written += 1
  }
  console.log(`已写入：${written} 条记忆的 related 有变化`)
}

await main()
