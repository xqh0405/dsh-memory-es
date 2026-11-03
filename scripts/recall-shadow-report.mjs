/**
 * 影子召回的观测报告（阶段 16 P0）。
 *
 * 读 `recall-shadow.jsonl`，回答一个问题：**如果开启自动注入，值不值得？**
 * 判断口径（别混成一句「命中率」）：
 *  · 有效观测 = ok / low_confidence / no_match —— 排掉 throttled（主动跳过）、
 *    empty（空消息）、timeout / error（通道问题），否则分母被稀释，看起来「命中率低」
 *    其实是通道没跑起来；
 *  · 注入体积只看 ok 与 low_confidence：no_match 没有东西可注入；
 *  · 估算 token ≈ 字符 / 2（中文场景的粗口径，够用来判断「会不会太贵」）。
 *
 * 用法：
 *   node scripts/recall-shadow-report.mjs
 *   node scripts/recall-shadow-report.mjs --path /tmp/x.jsonl --days 7
 *   node scripts/recall-shadow-report.mjs --json    # 机器可读
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const pickArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const asJson = args.includes('--json')
const days = Number(pickArg('--days', '0'))
const defaultPath = process.env.DSH_HOME?.trim()
  ? join(process.env.DSH_HOME.trim(), 'memory-es', 'recall-shadow.jsonl')
  : join(homedir(), '.dsh', 'memory-es', 'recall-shadow.jsonl')
const path = pickArg('--path', defaultPath)

if (!existsSync(path)) {
  console.log(`没有观测文件：${path}`)
  console.log('（影子召回默认开，但只有在插件进程收到过用户消息之后才会有记录）')
  process.exit(0)
}

const since = days > 0 ? Date.now() - days * 86_400_000 : 0
const rows = []
let malformed = 0
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  try {
    const record = JSON.parse(line)
    if (Date.parse(record.ts) >= since) rows.push(record)
  } catch {
    malformed += 1
  }
}

const VALID = new Set(['ok', 'low_confidence', 'no_match'])
const USED = new Set(['ok', 'low_confidence'])
const outcomes = new Map()
const byAgent = new Map()
const durations = []
const chars = []
for (const row of rows) {
  outcomes.set(row.outcome, (outcomes.get(row.outcome) ?? 0) + 1)
  const agent = byAgent.get(row.agent) ?? { total: 0, hit: 0 }
  agent.total += 1
  if (USED.has(row.outcome)) agent.hit += 1
  byAgent.set(row.agent, agent)
  if (VALID.has(row.outcome)) durations.push(row.ms ?? 0)
  if (USED.has(row.outcome)) chars.push(row.chars ?? 0)
}

const valid = rows.filter((row) => VALID.has(row.outcome)).length
const hit = rows.filter((row) => USED.has(row.outcome)).length
const avg = (list) => (list.length === 0 ? 0 : list.reduce((sum, value) => sum + value, 0) / list.length)
const pct = (numerator, denominator) =>
  denominator === 0 ? '—' : `${((numerator / denominator) * 100).toFixed(1)}%`

const report = {
  path,
  windowDays: days > 0 ? days : 'all',
  total: rows.length,
  malformed,
  outcomes: Object.fromEntries(outcomes),
  valid,
  hit,
  hitRate: valid === 0 ? null : Number((hit / valid).toFixed(4)),
  avgHitsPerQuery: Number(avg(rows.filter((row) => VALID.has(row.outcome)).map((row) => row.hits ?? 0)).toFixed(2)),
  avgCharsWhenInjected: Number(avg(chars).toFixed(1)),
  estimatedTokensPerInjection: Number((avg(chars) / 2).toFixed(0)),
  avgMs: Number(avg(durations).toFixed(1)),
  byAgent: Object.fromEntries(byAgent),
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

console.log(`影子召回观测：${path}`)
console.log(`窗口：${days > 0 ? `最近 ${days} 天` : '全部'}`)
console.log('')
console.log(`观测条数        ${rows.length}${malformed > 0 ? `（另有 ${malformed} 行解析失败）` : ''}`)
console.log(`有效观测        ${valid}（ok / low_confidence / no_match）`)
console.log(`有候选可注入    ${hit}  → 命中率 ${pct(hit, valid)}`)
console.log(`平均命中条数    ${report.avgHitsPerQuery} 条/次`)
console.log(`注入体积        平均 ${report.avgCharsWhenInjected} 字符 ≈ ${report.estimatedTokensPerInjection} token/次`)
console.log(`检索耗时        平均 ${report.avgMs} ms（只算有效观测）`)
console.log('')
console.log('结果分布：')
for (const [outcome, count] of [...outcomes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(14)} ${count}`)
}
if (byAgent.size > 1) {
  console.log('')
  console.log('按 agent：')
  for (const [agent, stat] of byAgent) {
    console.log(`  ${agent.slice(0, 24).padEnd(26)} ${stat.total} 次，命中 ${stat.hit}`)
  }
}
console.log('')
console.log('判读提示：命中率明显偏低时先看 timeout / error 占比——通道没跑起来和「真的没记忆」是两件事。')
