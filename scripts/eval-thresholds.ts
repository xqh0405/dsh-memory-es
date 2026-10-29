#!/usr/bin/env node
/**
 * 置信判定的阈值试算：不猜常数，用真实数据把候选组合全跑一遍。
 *
 * 背景：`marginFloor=0.05` 来自「库里只有三条记忆」时的实测，候选池变大后
 * top2 必然逼近 top1，margin 整体下移，导致 30/30 全被判空（见 docs/优化路线.md 阶段 0.5）。
 *
 * 试算的分层规则（方案 B）：
 *   1. top1 < tLow            → 低置信（直接空）
 *   2. top1 >= tHigh          → 直接返回（绝对相似度够高，不再看 margin）
 *   3. 中间区：margin >= mMin 或 bm25Top1 >= bMin → 返回，否则空
 *
 * 输出：每条 query 的原始信号 + 帕累托前沿（误杀 / 误放）。
 * 误杀的代价高于误放：漏掉一条真记忆，模型就会去「凭印象编」；误放最多让模型多看两条无关内容。
 *
 * 用法：node scripts/eval-thresholds.ts [--queries path] [--config path]
 *
 * @module scripts/eval-thresholds
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedder } from '../src/embedding.ts'
import { bm25Body, extractIdentifiers, knnBody } from '../src/es/dsl.ts'
import { createEsClient } from '../src/es/http.ts'
import { judgeConfidence, type ConfidenceConfig } from '../src/memory/search.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

interface QueryRow {
  id: string
  kind: string
  query: string
  expect: string[]
}

/** 单条 query 的原始信号（都是「未融合」的一手分数） */
interface Signal {
  id: string
  kind: string
  top1: number
  top2: number | null
  /** kNN top1 − top2；不足两条时视为「无法判断」 */
  margin: number | null
  bm25Top1: number
  /** 两路 top5 里是否至少有一路含期望条目（试算假设：能返回就大概率能命中） */
  canHit: boolean
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')

function parseArgs(argv: string[]) {
  const opts = { queries: join(ROOT, 'tests/eval/queries.jsonl'), config: DEFAULT_CONFIG_PATH }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--queries') opts.queries = resolve(argv[++i])
    else if (argv[i] === '--config') opts.config = resolve(argv[++i])
    else throw new Error(`未知参数：${argv[i]}`)
  }
  return opts
}

function loadQueries(path: string): QueryRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as QueryRow)
}

/** 一条 query 的三项信号 */
async function probe(deps: { reader: ReturnType<typeof createEsClient>; embed: ReturnType<typeof createEmbedder>; index: string; dims: number }, q: QueryRow): Promise<Signal> {
  const vector = await deps.embed.embed(q.query)
  const [knn, bm25] = await Promise.all([
    deps.reader.search(deps.index, knnBody(vector, deps.dims, { status: 'active' }, 5)),
    deps.reader.search(deps.index, bm25Body(q.query, { status: 'active' }, 5, extractIdentifiers(q.query))),
  ])
  const knnIds = knn.hits.map((h) => String(h.source.memory_id ?? h.id))
  const bm25Ids = bm25.hits.map((h) => String(h.source.memory_id ?? h.id))
  const contains = (ids: string[]) => q.expect.some((id) => ids.includes(id))
  const s0 = knn.hits[0]?.score
  const s1 = knn.hits[1]?.score
  return {
    id: q.id,
    kind: q.kind,
    top1: s0 ?? 0,
    top2: s1 ?? null,
    margin: s0 !== undefined && s1 !== undefined ? s0 - s1 : null,
    bm25Top1: bm25.hits[0]?.score ?? 0,
    canHit: q.expect.length === 0 ? false : contains(knnIds) || contains(bm25Ids),
  }
}

/**
 * 返回 true = 判定「不是低置信」。
 * 直接复用线上的 judgeConfidence：试算规则一旦和实现漂移，试算结论就作废了。
 */
function decide(s: Signal, cfg: ConfidenceConfig): boolean {
  return !judgeConfidence({ top1: s.top1, top2: s.top2, bm25Top1: s.bm25Top1 }, cfg).low
}

interface Score {
  tLow: number
  tHigh: number
  mMin: number
  bMin: number
  /** 真命中被判空的条数（代价最高） */
  missed: number
  /** noise 被判有结果的条数 */
  falsePositive: number
  /** 真命中被正确返回的条数，用于在 tie 时进一步区分 */
  kept: number
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const queries = loadQueries(opts.queries)

  const reader = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: cfg.requestTimeoutMs,
    username: cfg.username,
    password: cfg.password,
  })
  const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
  const index = `${cfg.personalPrefix}${cfg.userId}`

  const signals: Signal[] = []
  for (const q of queries) signals.push(await probe({ reader, embed, index, dims: cfg.dims }, q))

  console.log('== 每条 query 的原始信号 ==')
  console.log('id    kind         top1    margin   bm25    canHit')
  for (const s of signals) {
    console.log(
      `${s.id}  ${s.kind.padEnd(10)}  ${s.top1.toFixed(4)}  ${(s.margin === null ? '  n/a ' : s.margin.toFixed(4))}  ${s.bm25Top1.toFixed(1).padStart(5)}   ${s.canHit ? '✓' : '✗'}   ${s.margin === null ? '' : s.margin < 0.005 ? '← margin 极低' : ''}`,
    )
  }

  const real = signals.filter((s) => s.kind !== 'noise')
  const noise = signals.filter((s) => s.kind === 'noise')
  const unseparated = real.filter((s) => !s.canHit)
  if (unseparated.length > 0) {
    console.log(`\n⚠️ 有 ${unseparated.length} 条真命中在 kNN/BM25 的 top5 里都找不到期望条目，无论怎么调阈值都救不回来：${unseparated.map((s) => s.id).join(', ')}`)
  }

  // 网格扫描：范围刻意放宽，让数据自己决定边界在哪
  const grid: Score[] = []
  for (const tLow of [0.5, 0.55, 0.6, 0.65, 0.7])
    for (const tHigh of [0.75, 0.76, 0.78, 0.79, 0.8, 0.81, 0.82, 0.85, 0.88])
      for (const mMin of [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03])
        for (const bMin of [0, 10, 12, 13, 14, 15, 18, 20, 25, 30, 40]) {
          let missed = 0
          let kept = 0
          let fp = 0
          const cfg: ConfidenceConfig = { floorTop1: tLow, autoPassTop1: tHigh, minMargin: mMin, minBm25: bMin }
          for (const s of real) {
            const ok = decide(s, cfg)
            if (ok && s.canHit) kept += 1
            else if (!ok && s.canHit) missed += 1
            else if (ok && !s.canHit) missed += 1 // 返回了也命中不了，等同漏
          }
          for (const s of noise) if (decide(s, cfg)) fp += 1
          grid.push({ tLow, tHigh, mMin, bMin, missed, falsePositive: fp, kept })
        }

  // 帕累托前沿：不存在「误杀和误放都不比它差」的另一个组合
  const pareto = grid.filter(
    (a) => !grid.some((b) => b !== a && b.missed <= a.missed && b.falsePositive <= a.falsePositive && (b.missed < a.missed || b.falsePositive < a.falsePositive)),
  )
  // 同一个 (误杀, 误放) 往往对应上百组等价参数（阈值落在两段数据之间的空档），
  // 对读的人没有意义；每组只保留「信号余量最大」的那一个：tHigh 高、tLow 低、阈值离数据边界远。
  const bestByScore = new Map<string, Score>()
  for (const c of pareto) {
    const key = `${c.missed}-${c.falsePositive}`
    const prev = bestByScore.get(key)
    // 余量 heuristic：tHigh 越高越宽松、tLow 越低越宽松，同 (missed,fp) 下取最保守的边界
    const margin = (x: Score) => x.tHigh - x.tLow + x.mMin + (x.bMin === 0 ? 0 : x.bMin / 100)
    if (prev === undefined || margin(c) < margin(prev)) bestByScore.set(key, c)
  }
  const front = [...bestByScore.values()].sort((a, b) => (a.missed - b.missed) || (a.falsePositive - b.falsePositive))

  console.log(`\n== 帕累托前沿（真命中 ${real.length} 条 / noise ${noise.length} 条）==`)
  console.log('missed  fp   kept  tLow  tHigh  mMin   bMin')
  for (const f of front) {
    console.log(`${String(f.missed).padEnd(6)}  ${String(f.falsePositive).padEnd(4)} ${String(f.kept).padEnd(5)} ${f.tLow.toFixed(2)}  ${f.tHigh.toFixed(2)}   ${f.mMin.toFixed(3)}  ${f.bMin}`)
  }

  const best = front[0]
  if (best !== undefined) {
    console.log('\n== 推荐（误杀优先，再看误放）==')
    console.log(`tLow=${best.tLow}  tHigh=${best.tHigh}  mMin=${best.mMin}  bMin=${best.bMin}`)
    console.log(`真命中返回 ${best.kept}/${real.length}，误杀 ${best.missed}，noise 误放 ${best.falsePositive}/${noise.length}`)
    const bestCfg: ConfidenceConfig = { floorTop1: best.tLow, autoPassTop1: best.tHigh, minMargin: best.mMin, minBm25: best.bMin }
    const broken = real.filter((s) => !decide(s, bestCfg))
    if (broken.length > 0) console.log(`被误杀：${broken.map((s) => s.id).join(', ')}`)
    const leaked = noise.filter((s) => decide(s, bestCfg))
    if (leaked.length > 0) console.log(`被误放：${leaked.map((s) => s.id).join(', ')}`)
  }
}

main().catch((err) => {
  console.error('试算失败：', (err as Error).message)
  process.exit(1)
})
