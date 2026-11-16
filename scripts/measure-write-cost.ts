#!/usr/bin/env node
/**
 * 阶段 36b：写入成本（灵枢四项之一）。
 *
 * 度量 `memory_save` → `memory_search` 可见的耗时：写入侧记录 save 的总耗时
 * （含 refresh=wait_for，即写后立即可搜），再用同一段首句检索确认可见。
 *
 * 为什么单独一个脚本：它不是「检索质量」，跑一次要往库里写 N 条再删掉，
 * 不适合混在只读的 gold-set 评测里。
 *
 * 用法：
 *   node scripts/measure-write-cost.ts --config /path/cordis.patch.yml --count 10
 *
 * @module scripts/measure-write-cost
 */

import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_RANKING } from '../src/fragment.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { searchMemories } from '../src/memory/search.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

function parseArgs(argv: string[]) {
  const opts = { config: DEFAULT_CONFIG_PATH, count: 10 }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--config') opts.config = resolve(argv[++i])
    else if (a === '--count') opts.count = Math.max(1, Number(argv[++i]))
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

function p50p95(values: number[]): { p50: number; p95: number } {
  if (values.length === 0) return { p50: 0, p95: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)) }
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const reader = createEsClient({ url: cfg.esUrl, caCertPath: cfg.caCertPath, requestTimeoutMs: cfg.requestTimeoutMs, username: cfg.username, password: cfg.password })
  const writer = createEsClient({ url: cfg.esUrl, caCertPath: cfg.caCertPath, requestTimeoutMs: cfg.requestTimeoutMs, username: cfg.username, password: cfg.password })
  const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
  const index = `${cfg.personalPrefix}${cfg.userId}`
  const now = new Date('2026-11-16T00:00:00Z')
  const saveDeps: SaveDeps = {
    userId: cfg.userId,
    personalPrefix: cfg.personalPrefix,
    defaultDomain: 'general',
    reader,
    writer,
    embed,
    now: () => now,
  }
  const searchDeps = {
    userId: cfg.userId,
    personalPrefix: cfg.personalPrefix,
    teamIndex: cfg.teamIndex,
    reader,
    embed,
    dims: cfg.dims,
    now: () => now,
    retrieval: { topK: 20, rrfK: 60, limit: 8 },
    ranking: { ...DEFAULT_RANKING },
  }

  const saveMs: number[] = []
  const visibleMs: number[] = []
  const created: string[] = []
  for (let i = 0; i < opts.count; i += 1) {
    const marker = randomUUID().slice(0, 8)
    const content = `写入成本测量条目 ${marker}：北单同步必须逐位对拍赔率列，窗口内不要重跑`
    const t0 = Date.now()
    const saved = await saveMemory(saveDeps, { content })
    saveMs.push(Date.now() - t0)
    created.push(saved.memory_id)
    // 写后立刻用同一段话检索：命中即「可见」
    const res = await searchMemories(searchDeps, { query: `写入成本测量条目 ${marker}`, scope: 'personal', limit: 5 })
    if (res.hits.some((h) => h.memory_id === saved.memory_id)) visibleMs.push(Date.now() - t0)
  }

  // 清理自己造的数据
  for (const id of created) {
    await writer.delete(index, id, { refresh: 'wait_for' }).catch(() => {})
  }

  const save = p50p95(saveMs)
  const visible = p50p95(visibleMs)
  console.log(`写入成本（${opts.count} 次，含向量与 refresh=wait_for）：`)
  console.log(`  memory_save 耗时      p50=${save.p50}ms  p95=${save.p95}ms`)
  console.log(`  写入→可检索（含 save） p50=${visible.p50}ms  p95=${visible.p95}ms  （可见 ${visibleMs.length}/${created.length}）`)
}

await main()
