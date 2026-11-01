#!/usr/bin/env node
/**
 * 补建边：给「建边功能上线之前」写入的历史记忆补上 `related`。
 *
 * 背景（2026-11-01 实测）：
 *  · `related` 字段有 mapping，但全库 0 条有值——318 条 active 记忆都是在
 *    save 的建边步骤存在之前写进去的；
 *  · 新写入是好的：探针那条一落库就拿到两条边（0.7956 / 0.7916）。
 *  星图要能看，历史这批必须先补齐，否则图上是 300 个孤点。
 *
 * 口径与 save 完全一致（复用 src/ 里的同一批纯函数，不另写一套）：
 *   kNN topK*3 候选 → pickNeighbors（[minScore, maxScore) 区间）→ mergeEdges 合并。
 *
 * 用法：
 *   node scripts/backfill-edges.ts                 # 预演，只报告不写
 *   node scripts/backfill-edges.ts --apply         # 真写
 *   node scripts/backfill-edges.ts --apply --index personal
 *
 * @module scripts/backfill-edges
 */

import { createEsClient } from '../src/es/http.ts'
import { knnBody } from '../src/es/dsl.ts'
import { mergeEdges, pickNeighbors, readEdges } from '../src/edges.ts'
import { parsePluginConfig } from './lib/plugin-config.ts'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const only = (() => {
  const idx = process.argv.indexOf('--index')
  return idx === -1 ? undefined : process.argv[idx + 1]
})()

/** 与 save.ts 一致的建边区间：低于下限是噪声，到上限算重复（判重带）。 */
const TOP_K = 5
const MIN_SCORE = 0.55
const MAX_SCORE = 0.85
const PAGE = 50

const cfg = parsePluginConfig()
const reader = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})
const writer = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})

const indexes = only === undefined
  ? [`${cfg.personalPrefix}${cfg.userId}`, cfg.teamIndex]
  : only === 'personal'
    ? [`${cfg.personalPrefix}${cfg.userId}`]
    : [cfg.teamIndex]

console.log(`模式：${apply ? '**写入**' : '预演（加 --apply 才写）'}`)
console.log(`索引：${indexes.join(', ')}`)

for (const index of indexes) {
  console.log(`\n=== ${index} ===`)
  let from = 0
  let scanned = 0
  let withEdges = 0
  let planned = 0
  let added = 0
  let failed = 0

  for (;;) {
    let page
    try {
      page = await reader.search(index, {
        from,
        size: PAGE,
        query: {
          bool: {
            filter: [{ term: { status: 'active' } }, { exists: { field: 'embedding' } }],
          },
        },
        _source: ['memory_id', 'embedding', 'related'],
        sort: [{ updated_at: 'desc' }],
      })
    } catch (error) {
      console.error(`  读取失败（${index} from=${from}）：${(error as Error).message}`)
      break
    }
    if (page.hits.length === 0) break

    for (const hit of page.hits) {
      scanned += 1
      const memoryId = typeof hit.source.memory_id === 'string' ? hit.source.memory_id : hit.id
      const vector = hit.source.embedding
      if (!Array.isArray(vector) || vector.length === 0) continue

      let found
      try {
        found = await reader.search(index, knnBody(vector as number[], cfg.dims, { status: 'active' }, TOP_K * 3))
      } catch (error) {
        failed += 1
        console.error(`  kNN 失败 ${memoryId}: ${(error as Error).message}`)
        continue
      }

      const picked = pickNeighbors(
        found.hits.map((h) => ({
          id: typeof h.source.memory_id === 'string' ? h.source.memory_id : h.id,
          score: h.score,
        })),
        { excludeId: memoryId, minScore: MIN_SCORE, maxScore: MAX_SCORE, topK: TOP_K },
      )
      const existing = readEdges(hit.source.related)
      if (existing.length > 0) withEdges += 1
      const merged = mergeEdges(existing, picked, TOP_K)
      if (merged.length === existing.length) continue

      planned += 1
      added += merged.length - existing.length
      if (!apply) continue
      try {
        await writer.update(index, memoryId, { related: merged })
      } catch (error) {
        failed += 1
        console.error(`  写回失败 ${memoryId}: ${(error as Error).message}`)
      }
    }

    from += page.hits.length
    if (page.hits.length < PAGE) break
  }

  console.log(`  扫描 ${scanned} 条 · 原本有边 ${withEdges} 条`)
  console.log(`  需要补边 ${planned} 条（新增 ${added} 条边${apply ? '，已写入' : ''}）`)
  if (failed > 0) console.log(`  失败 ${failed} 次`)
}

console.log('\n完成。')
