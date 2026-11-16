#!/usr/bin/env node
/**
 * 阶段 36b：LongMemEval（cleaned）离线评测。
 *
 * 口径（施工图 36.2 第 5 条）：
 *  · 每个 session 一个记忆文档（`_id = session_id`）；
 *  · 保留 `haystack_dates`（作为文档的 created_at）；
 *  · IK 分词 + bge-m3 向量，与生产索引同一套字段（content / summary / semantic_keywords）；
 *  · 关掉 pinned 与自动召回注入——本脚本直接调 ES，不经过插件注入链路；
 *  · 报 R@5 / MRR，`flat-bm25`（只走 BM25）同口径对拍。
 *
 * 为什么分两段：
 *  · `--prepare` 只写文档（不 embed），19195 个 session 约 1 分钟；
 *  · `--embed` 才补向量（共享 Ollama，1 万字符约 1 秒/条，全量要几小时）——
 *    所以默认只对 `--sample` 抽样题目的 session 补，BM25 全量照跑。
 *
 * 索引与账号：`longmemeval_eval`（125 上新建，见 36.5），专用账号 `mem-eval-xqh`。
 * 密码不进仓库：从环境变量 `LONGMEVAL_ES_PASS` 或 `--pass-file`（默认 /tmp/eval-es.pass）读。
 *
 * 用法：
 *   node scripts/eval-longmemeval.ts --prepare
 *   node scripts/eval-longmemeval.ts --run --mode bm25
 *   node scripts/eval-longmemeval.ts --embed --sample 100
 *   node scripts/eval-longmemeval.ts --run --mode hybrid --sample 100
 *
 * @module scripts/eval-longmemeval
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedder, type Embedder } from '../src/embedding.ts'
import { createEsClient, type EsClient } from '../src/es/http.ts'
import { bm25Body, knnBody } from '../src/es/dsl.ts'
import { rrfFuse, type Hit } from '../src/fragment.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const INDEX = 'longmemeval_eval'

interface Turn {
  role?: string
  content?: string
}

interface QuestionRow {
  question_id: string
  question: string
  question_type?: string
  answer_session_ids: string[]
  haystack_session_ids: string[]
  haystack_sessions: Turn[][]
  haystack_dates: string[]
}

interface SessionDoc {
  sessionId: string
  questionId: string
  text: string
  date: string
}

function parseArgs(argv: string[]) {
  const opts = {
    data: join(ROOT, 'scratch-eval/longmemeval_s_cleaned.json'),
    config: DEFAULT_CONFIG_PATH,
    mode: 'bm25' as 'bm25' | 'hybrid',
    sample: 0,
    stratified: 0,
    isolated: false,
    topK: 50,
    limit: 5,
    prepare: false,
    embed: false,
    passFile: '/tmp/eval-es.pass',
    concurrency: 8,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--data') opts.data = resolve(argv[++i])
    else if (a === '--config') opts.config = resolve(argv[++i])
    else if (a === '--mode') opts.mode = argv[++i] as 'bm25' | 'hybrid'
    else if (a === '--sample') opts.sample = Number(argv[++i])
    else if (a === '--stratified') opts.stratified = Number(argv[++i])
    else if (a === '--isolated') opts.isolated = true
    else if (a === '--topK') opts.topK = Number(argv[++i])
    else if (a === '--limit') opts.limit = Number(argv[++i])
    else if (a === '--prepare') opts.prepare = true
    else if (a === '--embed') opts.embed = true
    else if (a === '--pass-file') opts.passFile = resolve(argv[++i])
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i])
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

function loadData(path: string, sample: number, stratified: number): QuestionRow[] {
  const rows = JSON.parse(readFileSync(path, 'utf8')) as QuestionRow[]
  if (stratified > 0) {
    // 按 question_type 分层取：平铺前 N 题会全是同一类型（实测前 60 题全是 single-session-user）
    const byType = new Map<string, QuestionRow[]>()
    for (const row of rows) {
      const type = row.question_type ?? 'unknown'
      const list = byType.get(type) ?? []
      if (list.length < stratified) list.push(row)
      byType.set(type, list)
    }
    return [...byType.values()].flat()
  }
  return sample > 0 ? rows.slice(0, sample) : rows
}

/** 把一题里的 session 展平成「一个 session 一个文档」；同一 id 只留一份（首见为准） */
function collectSessions(rows: readonly QuestionRow[]): Map<string, SessionDoc> {
  const out = new Map<string, SessionDoc>()
  for (const row of rows) {
    row.haystack_sessions.forEach((turns, i) => {
      const sid = row.haystack_session_ids[i] ?? `${row.question_id}-s${i}`
      if (out.has(sid)) return
      const text = turns
        .map((t) => `${t.role ?? 'user'}: ${String(t.content ?? '')}`)
        .join('\n')
        .trim()
      out.set(sid, {
        sessionId: sid,
        questionId: row.question_id,
        text,
        date: normalizeDate(row.haystack_dates[i]),
      })
    })
  }
  return out
}

/** haystack_dates 形如 `2023/04/10 (Mon) 17:50`：只为保留时间信息，解析失败就退回当前时间 */
function normalizeDate(raw: string | undefined): string {
  if (raw === undefined) return new Date().toISOString()
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{2}):(\d{2})$/.exec(raw.trim())
  if (m === null) return new Date().toISOString()
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`
}

async function pool<T>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
}

async function prepare(client: EsClient, sessions: Map<string, SessionDoc>, concurrency: number): Promise<void> {
  const list = [...sessions.values()]
  let done = 0
  const started = Date.now()
  await pool(list, concurrency, async (doc) => {
    await client.index(
      INDEX,
      {
        session_id: doc.sessionId,
        question_id: doc.questionId,
        dataset: 'longmemeval_s_cleaned',
        content: doc.text,
        content_exact: doc.text,
        created_at: doc.date,
      },
      { id: doc.sessionId },
    )
    done += 1
    if (done % 1000 === 0) {
      const ms = Date.now() - started
      console.log(`  已写入 ${done}/${list.length}（${(ms / 1000).toFixed(0)}s，约 ${((ms / done) * (list.length - done) / 1000).toFixed(0)}s 剩余）`)
    }
  })
  console.log(`写入完成：${list.length} 个 session（${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

async function embedSessions(
  client: EsClient,
  embed: Embedder,
  sessions: Map<string, SessionDoc>,
  concurrency: number,
): Promise<void> {
  const list = [...sessions.values()]
  let done = 0
  const started = Date.now()
  await pool(list, concurrency, async (doc) => {
    const vector = await embed.embed(doc.text)
    await client.update(INDEX, doc.sessionId, { embedding: vector })
    done += 1
    if (done % 100 === 0) {
      const ms = Date.now() - started
      console.log(`  向量 ${done}/${list.length}（${(ms / 1000).toFixed(0)}s，约 ${((ms / done) * (list.length - done) / 1000).toFixed(0)}s 剩余）`)
    }
  })
  console.log(`向量补齐完成：${list.length} 条（${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

interface ModeStats {
  mode: string
  questions: number
  r5: number
  mrr: number
  byType: Record<string, { total: number; r5: number }>
}

async function runEval(
  client: EsClient,
  embed: Embedder,
  rows: readonly QuestionRow[],
  mode: 'bm25' | 'hybrid',
  topK: number,
  limit: number,
  isolated: boolean,
): Promise<ModeStats> {
  const stats: ModeStats = { mode, questions: 0, r5: 0, mrr: 0, byType: {} }
  for (const row of rows) {
    // 隔离口径：每题只在它自己的 haystack 里找（LongMemEval 原始设定）；
    // 不隔离 = 全部 session 混在一个库（更接近真实使用，也更难）。
    const scopeFilter = isolated ? [{ terms: { session_id: row.haystack_session_ids } }] : []
    const bm25Query = bm25Body(row.question, { status: null }, topK)
    if (isolated) {
      const bool = (bm25Query as unknown as { query: { bool: { filter?: unknown[] } } }).query.bool
      bool.filter = [...(bool.filter ?? []), ...scopeFilter]
    }
    const bm25 = await client.search(INDEX, bm25Query)
    let hits: Hit[] = bm25.hits
    if (mode === 'hybrid') {
      const vector = await embed.embed(row.question)
      const knnQuery = knnBody(vector, 1024, { status: null }, topK)
      if (isolated) {
        // knn 查询的过滤条件在顶层 `knn.filter`，不是 query.bool
        const knn = (knnQuery as unknown as { knn: { filter?: unknown[] } }).knn
        knn.filter = [...(knn.filter ?? []), ...scopeFilter]
      }
      const knn = await client.search(INDEX, knnQuery)
      hits = rrfFuse([bm25.hits, knn.hits], 60)
    }
    const gold = new Set(row.answer_session_ids)
    const rank = hits.findIndex((h) => gold.has(h.id)) + 1
    stats.questions += 1
    if (rank > 0 && rank <= limit) stats.r5 += 1
    if (rank > 0) stats.mrr += 1 / rank
    const type = row.question_type ?? 'unknown'
    const bucket = stats.byType[type] ?? { total: 0, r5: 0 }
    bucket.total += 1
    if (rank > 0 && rank <= limit) bucket.r5 += 1
    stats.byType[type] = bucket
  }
  return stats
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const pass = process.env.LONGMEVAL_ES_PASS ?? readFileSync(opts.passFile, 'utf8').trim()
  const es = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: 30_000,
    username: process.env.LONGMEVAL_ES_USER ?? 'mem-eval-xqh',
    password: pass,
  })
  const rows = loadData(opts.data, opts.sample, opts.stratified)
  console.log(`数据：${opts.data}（${rows.length} 题）`)

  if (opts.prepare) {
    const sessions = collectSessions(rows)
    console.log(`去重后 session：${sessions.size}`)
    await prepare(es, sessions, opts.concurrency)
    return
  }

  if (opts.embed) {
    const sessions = collectSessions(rows)
    console.log(`要补向量的 session：${sessions.size}`)
    const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
    await embedSessions(es, embed, sessions, opts.concurrency)
    return
  }

  const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
  const stats = await runEval(es, embed, rows, opts.mode, opts.topK, opts.limit, opts.isolated)
  console.log(`\n模式 ${stats.mode}${opts.isolated ? ' · 每题限定自身 haystack' : ' · 全库混检'}（topK=${opts.topK}，评测 ${stats.questions} 题）`)
  console.log(`R@${opts.limit}: ${pct(stats.r5, stats.questions)}  MRR: ${(stats.mrr / Math.max(1, stats.questions)).toFixed(3)}`)
  for (const [type, bucket] of Object.entries(stats.byType)) {
    console.log(`  ${type}: ${pct(bucket.r5, bucket.total)}（${bucket.total} 题）`)
  }
}

await main()
