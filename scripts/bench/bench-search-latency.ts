/**
 * 检索延迟剖分（2026-11-05）——「真注入」的准入基线。
 *
 * 为什么要它：影子召回实测 p50 = 2484 ms、timeout 占 38%（74 条观测）。
 * 而注入体积只有 363 字符 ≈ 181 token，收益侧完全不是问题——**卡在速度**。
 * 不先把延迟压下来，真注入等于给每个回合凭空加 2 秒白等。
 *
 * 这个 bench 只读、不改业务代码：它包装 `deps.reader.search` 与 `deps.embed.embed`
 * 计时，跑法与影子召回**完全一致**（`limit: maxItems+2`、`detail: summary`、
 * 不给 hitRecorder/recorder/recallCache），所以数字可以直接和
 * `recall-shadow.jsonl` 里的 ms 对齐。
 *
 * 用法：
 *   node scripts/bench/bench-search-latency.ts
 *   node scripts/bench/bench-search-latency.ts --queries 20 --verbose
 *   node scripts/bench/bench-search-latency.ts --path /tmp/x.jsonl --config ~/.dsh/profiles/web/cordis.patch.yml
 *
 * 口径提醒：`embed` 是串行前置，4 路 ES（2 scope × bm25/knn）是并发，
 * 所以总耗时 ≈ embed + max(ES 各路)，不是四者相加。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEmbedder } from '../../src/embedding.ts'
import { createEsClient } from '../../src/es/http.ts'
import { DEFAULT_RANKING } from '../../src/fragment.ts'
import { searchMemories } from '../../src/memory/search.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from '../lib/plugin-config.ts'

const args = process.argv.slice(2)
const pickArg = (name: string, fallback: string): string => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const verbose = args.includes('--verbose')
const maxQueries = Number(pickArg('--queries', '15'))
/**
 * 并发度：影子召回是「每条用户消息即发即忘」，多个会话同时活跃时会同时打检索。
 * 单条热路径只要 159 ms，但若 Ollama 是单队列，20 条并发就会排到秒级——
 * 这正是影子记录里 p50 1484 ms / 38% timeout 的最可能来源。
 * 默认 1（串行，测单次能力）；传 --concurrency 8 才能复现当时的形态。
 */
const concurrency = Math.max(1, Number(pickArg('--concurrency', '1')))
const defaultShadow = process.env.DSH_HOME?.trim()
  ? join(process.env.DSH_HOME.trim(), 'memory-es', 'recall-shadow.jsonl')
  : join(homedir(), '.dsh', 'memory-es', 'recall-shadow.jsonl')
const shadowPath = pickArg('--path', defaultShadow)
const configPath = pickArg('--config', DEFAULT_CONFIG_PATH)

interface Row {
  query: string
  outcome?: string
}

function loadQueries(path: string): string[] {
  if (!existsSync(path)) {
    console.error(`找不到影子观测文件：${path}`)
    process.exit(2)
  }
  const rows: Row[] = []
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as Row
      if (typeof row.query === 'string' && row.query.trim() !== '') rows.push(row)
    } catch {
      // 坏行跳过：观测文件是追加写的，不能因为一行坏掉整份不可用
    }
  }
  // 去重（同一句话可能被观察多次），保留首现顺序
  const seen = new Set<string>()
  const unique: string[] = []
  for (const row of rows) {
    const text = row.query.trim()
    if (seen.has(text)) continue
    seen.add(text)
    unique.push(text)
  }
  return unique.slice(0, maxQueries)
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

function fmt(ms: number): string {
  return `${ms.toFixed(0)} ms`
}

function table(title: string, series: Record<string, number[]>): void {
  console.log(`\n== ${title} ==`)
  console.log('阶段'.padEnd(14) + 'n'.padStart(5) + 'p50'.padStart(10) + 'p90'.padStart(10) + 'max'.padStart(10))
  for (const [name, values] of Object.entries(series)) {
    if (values.length === 0) continue
    console.log(
      name.padEnd(14) +
        String(values.length).padStart(5) +
        fmt(percentile(values, 0.5)).padStart(10) +
        fmt(percentile(values, 0.9)).padStart(10) +
        fmt(Math.max(...values)).padStart(10),
    )
  }
}

async function main() {
  const cfg = parsePluginConfig(configPath)
  const queries = loadQueries(shadowPath)

  console.log(`配置：${configPath}`)
  console.log(`ES  ：${cfg.esUrl}  索引：${cfg.personalPrefix}${cfg.userId} / ${cfg.teamIndex}`)
  console.log(`query 来源：${shadowPath}（去重后取 ${queries.length} 条）`)
  if (queries.length === 0) {
    console.error('没有可用的 query')
    process.exit(2)
  }

  // 真实客户端 + 计时包装（不改业务代码，只观测）
  const realReader = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: cfg.requestTimeoutMs,
    username: cfg.username,
    password: cfg.password,
  })
  const realEmbed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })

  const embedMs: number[] = []
  const bm25Ms: number[] = []
  const knnMs: number[] = []
  const totalMs: number[] = []
  const firstCall: number[] = []

  const reader = {
    search: async (index: string, body: unknown, options?: unknown) => {
      const isKnn = typeof body === 'object' && body !== null && 'knn' in body
      const startedAt = performance.now()
      try {
        return await realReader.search(index, body as never, options as never)
      } finally {
        const elapsed = performance.now() - startedAt
        ;(isKnn ? knnMs : bm25Ms).push(elapsed)
      }
    },
  }
  const embed = {
    embed: async (text: string, options?: unknown) => {
      const startedAt = performance.now()
      try {
        return await realEmbed.embed(text, options as never)
      } finally {
        embedMs.push(performance.now() - startedAt)
      }
    },
  }

  const deps = {
    userId: cfg.userId,
    personalPrefix: cfg.personalPrefix,
    teamIndex: cfg.teamIndex,
    reader: reader as never,
    embed: embed as never,
    dims: cfg.dims,
    // 与运行时默认一致；改这里等于改评测口径
    retrieval: { topK: 20, rrfK: 60, limit: 8 },
    ranking: { ...DEFAULT_RANKING },
  }

  let wallClockMs = 0
  const wallStartedAt = performance.now()

  const runOne = async (index: number, query: string): Promise<void> => {
    const startedAt = performance.now()
    let hits = 0
    try {
      const result = await searchMemories(deps, { query, limit: 5, detail: 'summary' })
      hits = result.hits.length
    } catch (err) {
      console.error(`  ✗ 第 ${index + 1} 条失败：${String(err).slice(0, 160)}`)
    }
    const elapsed = performance.now() - startedAt
    totalMs.push(elapsed)
    if (index === 0) firstCall.push(elapsed)
    if (verbose) {
      console.log(`  ${String(index + 1).padStart(2)}. ${fmt(elapsed).padStart(9)}  hits=${hits}  ${query.slice(0, 40)}`)
    }
  }

  if (concurrency === 1) {
    for (const [index, query] of queries.entries()) await runOne(index, query)
  } else {
    // 按 concurrency 分批并发：每批全部同时发出，测「排队后单条要等多久」
    for (let start = 0; start < queries.length; start += concurrency) {
      const batch = queries.slice(start, start + concurrency)
      await Promise.all(batch.map((query, offset) => runOne(start + offset, query)))
    }
  }
  wallClockMs = performance.now() - wallStartedAt

  table('各阶段耗时', { embed: embedMs, 'es.bm25': bm25Ms, 'es.knn': knnMs, 总计: totalMs })

  const totalP50 = percentile(totalMs, 0.5)
  const embedP50 = percentile(embedMs, 0.5)
  console.log('\n== 结论 ==')
  console.log(`并发度：${concurrency}（墙面时间 ${fmt(wallClockMs)}，${queries.length} 条）`)
  console.log(`embed 占 p50 总耗时：${((embedP50 / Math.max(totalP50, 1)) * 100).toFixed(1)}%（${fmt(embedP50)} / ${fmt(totalP50)}）`)
  // 并发下按「全局长度差」记账会串号，所以用总量相除（结构上是 2 scope × (bm25+knn) = 4）
  const avgEs = (bm25Ms.length + knnMs.length) / Math.max(totalMs.length, 1)
  console.log(`每次检索的 ES 请求数：${avgEs.toFixed(1)} 个（2 scope × bm25/knn）`)
  if (firstCall.length > 0) console.log(`第 1 次（含冷启动）：${fmt(firstCall[0])}`)
  console.log(`总耗时 p50 ${fmt(totalP50)} / p90 ${fmt(percentile(totalMs, 0.9))}`)
  if (concurrency > 1) {
    const throughput = (queries.length / wallClockMs) * 1000
    console.log(`吞吐：${throughput.toFixed(1)} 次/秒（若明显低于 1/p50，说明模型侧在串行排队）`)
  }
}

await main()