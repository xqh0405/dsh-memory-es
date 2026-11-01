#!/usr/bin/env node
/**
 * 调参脚本（阶段 13）：在**不改代码**的前提下扫检索参数，用两套评测同时看。
 *
 * 允许调：`rrfK`、`ranking.hitWeight`、`ranking.recencyWeight`。
 * 不允许调：准入/隔离规则、置信阈值以外的行为开关——那些是契约，不是旋钮
 * （路线原话：「tune 脚本调 rrfK/乘子（不许碰准入与隔离规则）」）。
 *
 * 为什么两套一起看：只盯 hit@5 会鼓励「把什么都往回捞」，而契约里的
 * `should` 失败数（噪声误报、不该出现的类型）会立刻涨上来。调参要看两边的平衡。
 *
 * 用法：
 *   node scripts/tune.ts                 # 默认 6 组（rrfK × hitWeight）
 *   node scripts/tune.ts --full          # 12 组（再叠加 recencyWeight）
 *   node scripts/tune.ts --config <path>
 *
 * @module scripts/tune
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_RANKING } from '../src/fragment.ts'
import { searchMemories, type SearchDeps } from '../src/memory/search.ts'
import { evaluateContract, parseContractLine, summarizeContracts } from './lib/contracts.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')

interface QueryRow {
  id: string
  kind: string
  query: string
  expect: string[]
}

function loadQueries(path: string): QueryRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as QueryRow)
}

function loadContracts(path: string) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, i) => parseContractLine(line, i + 1))
}

interface Score {
  hit1: number
  hit5: number
  mrr: number
  mustFailed: number
  shouldFailed: number
  /** 噪声 query 被误报的条数（should 里最值得盯的一项） */
  noiseFalsePositive: number
}

async function score(deps: SearchDeps, queries: QueryRow[], contracts: ReturnType<typeof loadContracts>): Promise<Score> {
  let hit1 = 0
  let hit5 = 0
  let mrr = 0
  let n = 0
  let noiseFalsePositive = 0
  for (const q of queries) {
    const res = await searchMemories(deps, { query: q.query, scope: 'both', limit: 5 })
    const ids = res.hits.map((hit) => hit.memory_id)
    if (q.expect.length === 0) {
      if (ids.length > 0 && res.note === 'ok') noiseFalsePositive += 1
      continue
    }
    n += 1
    const rank = ids.findIndex((id) => q.expect.includes(id)) + 1
    if (rank === 1) hit1 += 1
    if (rank > 0 && rank <= 5) hit5 += 1
    if (rank > 0) mrr += 1 / rank
  }

  const outcomes = new Map<string, ReturnType<typeof evaluateContract>>()
  for (const item of contracts) {
    const res = await searchMemories(deps, {
      query: item.query,
      scope: item.scope ?? 'both',
      limit: item.limit ?? 5,
      ...(item.require_receipts === true ? { explain: true } : {}),
    })
    outcomes.set(item.id, evaluateContract(item, res))
  }
  const summary = summarizeContracts(contracts, outcomes)
  return {
    hit1: n === 0 ? 0 : hit1 / n,
    hit5: n === 0 ? 0 : hit5 / n,
    mrr: n === 0 ? 0 : mrr / n,
    mustFailed: summary.mustFailed,
    shouldFailed: summary.shouldFailed,
    noiseFalsePositive,
  }
}

async function main() {
  const argv = process.argv
  const full = argv.includes('--full')
  const configArg = argv.indexOf('--config') >= 0 ? resolve(argv[argv.indexOf('--config') + 1]) : DEFAULT_CONFIG_PATH

  const cfg = parsePluginConfig(configArg)
  const queries = loadQueries(join(ROOT, 'tests/eval/queries.jsonl'))
  const contracts = loadContracts(join(ROOT, 'tests/eval/contracts.jsonl'))

  const reader = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: cfg.requestTimeoutMs,
    username: cfg.username,
    password: cfg.password,
  })
  const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
  const base = {
    userId: cfg.userId,
    personalPrefix: cfg.personalPrefix,
    teamIndex: cfg.teamIndex,
    reader,
    embed,
    dims: cfg.dims,
  }

  const combos: Array<{ rrfK: number; hitWeight: number; recencyWeight: number }> = []
  for (const rrfK of [30, 60, 100]) {
    for (const hitWeight of [0, 0.2]) {
      for (const recencyWeight of full ? [0.1, 0.3] : [0.1]) {
        combos.push({ rrfK, hitWeight, recencyWeight })
      }
    }
  }

  console.log(`配置：${configArg}`)
  console.log(`ES  ：${cfg.esUrl}`)
  console.log(`查询 ${queries.length} 条 · 契约 ${contracts.length} 条 · 组合 ${combos.length} 组`)
  console.log('只调 rrfK / hitWeight / recencyWeight；准入与隔离规则不在调参范围\n')

  const rows: Array<{ combo: string; score: Score }> = []
  for (const combo of combos) {
    const deps: SearchDeps = {
      ...base,
      retrieval: { topK: 20, rrfK: combo.rrfK, limit: 8 },
      ranking: { ...DEFAULT_RANKING, hitWeight: combo.hitWeight, recencyWeight: combo.recencyWeight },
    }
    const label = `rrfK=${String(combo.rrfK).padEnd(3)} hit=${String(combo.hitWeight).padEnd(3)} rec=${combo.recencyWeight}`
    process.stdout.write(`  ${label} … `)
    const scoreResult = await score(deps, queries, contracts)
    rows.push({ combo: label, score: scoreResult })
    console.log(`hit@5=${(scoreResult.hit5 * 100).toFixed(0)}%  MRR=${scoreResult.mrr.toFixed(3)}  must=${scoreResult.mustFailed}  should=${scoreResult.shouldFailed}`)
  }

  console.log('\n== 汇总（按 hit@5 降序，同分看 should 失败少）==')
  const sorted = [...rows].sort((a, b) => b.score.hit5 - a.score.hit5 || a.score.shouldFailed - b.score.shouldFailed)
  console.log('参数                               hit@1  hit@5  MRR    must  should  噪声误报')
  for (const row of sorted) {
    const s = row.score
    console.log(
      `${row.combo.padEnd(32)} ${(s.hit1 * 100).toFixed(0).padStart(5)}% ${(s.hit5 * 100).toFixed(0).padStart(5)}% ${s.mrr.toFixed(3)} ${String(s.mustFailed).padStart(5)} ${String(s.shouldFailed).padStart(7)} ${String(s.noiseFalsePositive).padStart(8)}`,
    )
  }

  const best = sorted[0]
  if (best !== undefined) {
    console.log(`\n建议：${best.combo}`)
    console.log('注意：调参只改配置/常量，改完仍要跑 `npm run eval:contracts:gate` 与 `npm run eval` 才能算数。')
  }
}

await main()
