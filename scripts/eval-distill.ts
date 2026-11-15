#!/usr/bin/env node
/**
 * 蒸馏的本地模型 JSON 稳定性评测（阶段 D3）。
 *
 * 判据（docs/本地模型扩展.md D3）：用真实记忆跑 20~30 条，统计 `parseDistillOutput`
 * 的失败率；**失败率 >5% 不接**。
 *
 * 只读 ES、不写任何东西；模型调用走本地网关（不烧云端 token）。
 *
 * 用法：
 *   node scripts/eval-distill.ts --gateway http://192.168.50.127:8080/v1 --api-ref LLAMA_SWAP_KEY --model qwen3-30b --limit 30
 *   node scripts/eval-distill.ts --gateway ... --model qwen3-4b --limit 30     # 速度档对照
 *
 * @module scripts/eval-distill
 */

import { createEsClient } from '../src/es/http.ts'
import { createLocalChat } from '../src/local-chat.ts'
import { buildDistillPrompt, DISTILL_SYSTEM, parseDistillOutput } from '../src/memory/distillRunner.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const gateway = arg('gateway', '')
const apiRef = arg('api-ref', 'LLAMA_SWAP_KEY')
const model = arg('model', 'qwen3-30b')
const limit = Number(arg('limit', '30'))
const configPath = arg('config', DEFAULT_CONFIG_PATH)
if (gateway === '') {
  console.error('需要 --gateway（如 http://192.168.50.127:8080/v1）')
  process.exit(2)
}

const cfg = parsePluginConfig(configPath)
const reader = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})

/** 取真实的 active 记忆正文（只要 content/summary，按最近更新倒序，可复跑） */
async function loadSamples(): Promise<Array<{ id: string; content: string; domain: string }>> {
  const index = `${cfg.personalPrefix}${cfg.userId}`
  const body = {
    size: limit,
    _source: ['content', 'domain', 'created_at', 'updated_at'],
    sort: [{ updated_at: 'desc' }],
    query: { bool: { filter: [{ term: { status: 'active' } }, { exists: { field: 'content' } }] } },
  }
  const result = await reader.search(index, body as never)
  return result.hits
    .map((hit) => ({
      id: String((hit.source as Record<string, unknown>).memory_id ?? hit.id),
      content: String((hit.source as Record<string, unknown>).content ?? ''),
      domain: String((hit.source as Record<string, unknown>).domain ?? 'general'),
    }))
    .filter((row) => row.content.trim() !== '')
}

const chat = createLocalChat(
  { enabled: true, model, timeoutMs: 60_000 },
  { baseUrl: gateway, apiKeyEnv: apiRef },
  { log: (event) => console.error(`[local-chat] ${JSON.stringify(event)}`) },
)

const samples = await loadSamples()
console.log(`模型：${model} @ ${gateway}`)
console.log(`样本：${samples.length} 条真实 active 记忆\n`)

let parsed = 0
let failed = 0
let empty = 0
let error = 0
const durations: number[] = []
const failures: string[] = []

for (const [i, sample] of samples.entries()) {
  const attempt = await chat.complete({
    system: DISTILL_SYSTEM,
    user: buildDistillPrompt(sample.content, sample.domain),
    maxTokens: 1200,
  })
  if (!('text' in attempt)) {
    if (attempt.error === 'empty_content') empty += 1
    else error += 1
    durations.push(attempt.ms)
    failures.push(`${sample.id} → ${attempt.error}`)
    continue
  }
  durations.push(attempt.ms)
  const output = parseDistillOutput(attempt.text)
  if (output === null) {
    failed += 1
    failures.push(`${sample.id} → unparsable（${attempt.text.slice(0, 80).replace(/\n/g, ' ')}）`)
  } else {
    parsed += 1
  }
  if ((i + 1) % 10 === 0) console.log(`  已跑 ${i + 1}/${samples.length}（成功 ${parsed}）`)
}

const total = samples.length
const bad = failed + empty + error
const rate = total === 0 ? 0 : (failed + empty) / total
const sorted = [...durations].sort((a, b) => a - b)
const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0

console.log('\n== 结果 ==')
console.log(`成功解析 ${parsed}/${total}`)
console.log(`不可解析 ${failed} · 空正文 ${empty} · 请求失败 ${error}`)
console.log(`失败率（不可解析+空正文）= ${(rate * 100).toFixed(1)}%（判据 >5% 不接）`)
console.log(`耗时：P50=${at(0.5)}ms P95=${at(0.95)}ms max=${sorted[sorted.length - 1] ?? 0}ms`)
if (failures.length > 0) {
  console.log('\n失败样例：')
  for (const line of failures.slice(0, 10)) console.log(`  ${line}`)
}
if (bad > 0 && error > 0) console.log('\n⚠️ 有请求级失败（网关/超时），这轮失败率不等于模型质量')
