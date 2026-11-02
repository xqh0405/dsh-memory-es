#!/usr/bin/env node
/**
 * 回填缺失向量（`embedding` 字段缺失或为空数组）。
 *
 * 为什么需要：kNN 那一路对没有向量的条目是**物理缺席**的——它只剩 BM25 单路，
 * 在 RRF 融合里天然吃亏（实测 `cjk-alert-owner` 的 BM25 排第 1，却因为没向量被挤到第 13）。
 * 2026-11-02 评审时个人库 420 条里有 10 条缺向量。
 *
 * 用法：
 *   node scripts/backfill-missing-embeddings.ts             # 只看有多少条要补
 *   node scripts/backfill-missing-embeddings.ts --apply     # 真的补
 *
 * 只动 `embedding` 一个字段（部分更新），不碰正文/状态/计数。
 */
import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const apply = process.argv.includes('--apply')
const cfg = parsePluginConfig(DEFAULT_CONFIG_PATH)
const index = `${cfg.personalPrefix}${cfg.userId}`

const client = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})
const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })

/**
 * 缺字段 或 空数组 都算缺。
 * ES 里空数组与缺失在 `exists` 上等价（都不会有值），所以一条 `must_not exists` 就够。
 */
const missingBody = {
  size: 500,
  _source: ['content', 'memory_id'],
  query: { bool: { must_not: [{ exists: { field: 'embedding' } }] } },
}

/**
 * 翻页取全量：ES 默认 `size` 上限 10000，单页固定 500 会在「缺向量很多」时静默截断
 * （2026-11-02 审计指出：旧版只取一页，超 500 条就只补 500 条还说成功了）。
 */
const PAGE = 500
const docs: Array<{ id: string; source: Record<string, unknown> }> = []
for (let from = 0; ; from += PAGE) {
  const page = await client.search(index, { ...missingBody, from, size: PAGE })
  docs.push(...page.hits.map((hit) => ({ id: hit.id, source: hit.source as Record<string, unknown> })))
  if (page.hits.length < PAGE) break
  if (docs.length >= 10_000) {
    console.log('⚠️ 缺向量超过 10000 条，只处理前 10000 条（请分批跑）')
    break
  }
}
console.log(`索引 ${index}：缺向量 ${docs.length} 条${apply ? '' : '（dry-run，加 --apply 才写）'}`)

let done = 0
let failed = 0
for (const doc of docs) {
  const content = typeof doc.source.content === 'string' ? doc.source.content : ''
  if (content === '') {
    failed += 1
    continue
  }
  if (!apply) continue
  try {
    const vector = await embed.embed(content)
    await client.update(index, doc.id, { embedding: vector })
    done += 1
    process.stdout.write('.')
  } catch (err) {
    failed += 1
    console.log(`\n  失败 ${doc.id}：${String(err).slice(0, 160)}`)
  }
}
if (apply) console.log(`\n已补 ${done} 条，失败 ${failed} 条`)
