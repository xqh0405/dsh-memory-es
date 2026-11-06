/**
 * 真注入的观测报告（阶段 17）。
 *
 * 读 `recall-inject.jsonl`，回答一个问题：**注入在工作吗、代价多大、有没有被队列饿死？**
 *
 * 口径（与影子报告对称，但重点不同）：
 *  · 影子问「值不值得开」，这里问「开了之后跑得怎么样」；
 *  · **timeout 率是第一指标**：125 上 11 个容器共享一个 `-np 1` 的 Ollama，
 *    队列被批量补向量占住时 500ms 超时会把整轮注入吃掉——这个比例高说明要调超时或加闸；
 *  · 注入体积看 injected 的 chars 中位数（估算 token ≈ 字符 / 2）；
 *  · `no_match` / `low_confidence` 不是故障，是「本来就没东西可注入」。
 *
 * 用法：
 *   node scripts/inject-report.mjs
 *   node scripts/inject-report.mjs --path /tmp/x.jsonl --days 7
 *   node scripts/inject-report.mjs --json
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
  ? join(process.env.DSH_HOME.trim(), 'memory-es', 'recall-inject.jsonl')
  : join(homedir(), '.dsh', 'memory-es', 'recall-inject.jsonl')
const path = pickArg('--path', defaultPath)

if (!existsSync(path)) {
  console.log(`没有注入记录：${path}`)
  console.log('（说明 recallInject.enabled 还是 false，或者插件版本低于 v0.6.29、或者还没人发过消息）')
  process.exit(0)
}

const since = days > 0 ? Date.now() - days * 86_400_000 : 0
const rows = []
for (const line of readFileSync(path, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (trimmed === '') continue
  try {
    const row = JSON.parse(trimmed)
    if (since > 0 && Date.parse(row.ts) < since) continue
    rows.push(row)
  } catch {
    // 坏行跳过：文件是追加写的，一行坏掉不影响其余
  }
}

function quantile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

const byOutcome = {}
for (const row of rows) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1

const injected = rows.filter((row) => row.outcome === 'injected')
const searched = rows.filter((row) => row.outcome !== 'timeout' && row.outcome !== 'error')
const msAll = rows.map((row) => row.ms).filter((n) => typeof n === 'number')
const charsInjected = injected.map((row) => row.chars).filter((n) => typeof n === 'number')

const report = {
  path,
  window: days > 0 ? `最近 ${days} 天` : '全部',
  total: rows.length,
  byOutcome,
  timeoutRate: rows.length === 0 ? 0 : (byOutcome.timeout ?? 0) / rows.length,
  injectRate: searched.length === 0 ? 0 : injected.length / searched.length,
  latencyMs: { p50: quantile(msAll, 0.5), p90: quantile(msAll, 0.9), max: msAll.length === 0 ? 0 : Math.max(...msAll) },
  injectedChars: {
    p50: quantile(charsInjected, 0.5),
    p90: quantile(charsInjected, 0.9),
    avgItems: injected.length === 0 ? 0 : injected.reduce((sum, row) => sum + (row.items?.length ?? 0), 0) / injected.length,
  },
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const pct = (value) => `${(value * 100).toFixed(1)}%`
console.log(`真注入观测：${path}`)
console.log(`窗口：${report.window}`)
console.log('')
console.log(`注入尝试        ${report.total} 次`)
console.log(
  `真正注入         ${injected.length} 次（占有效检索 ${pct(report.injectRate)}，占全部尝试 ${pct(report.total === 0 ? 0 : injected.length / report.total)}）`,
)
console.log(`超时             ${byOutcome.timeout ?? 0} 次（${pct(report.timeoutRate)}）← 队列争用的直接指标`)
console.log(`检索延迟         p50 ${report.latencyMs.p50} ms / p90 ${report.latencyMs.p90} ms / max ${report.latencyMs.max} ms`)
console.log(`注入体积         p50 ${report.injectedChars.p50} 字符 ≈ ${Math.round(report.injectedChars.p50 / 2)} token，平均 ${report.injectedChars.avgItems.toFixed(1)} 条`)
console.log('')
console.log('结果分布：')
for (const [outcome, count] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(15)} ${count}`)
}
if (report.timeoutRate > 0.3) {
  console.log('')
  console.log('⚠️ 超时超过 30%：说明 Ollama 队列长期被占。先调大 timeoutMs 或加并发闸，别急着关注入。')
}