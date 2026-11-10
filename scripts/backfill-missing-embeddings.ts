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
 *
 * `sort` 是必须的（2026-11-10 审查 M6/#25）：`must_not` 没有打分子句，所有命中分数相同，
 * 不 sort 时 ES 按**内部文档序**返回 —— 而段合并、并发写入会让这个顺序在两次请求之间
 * 漂移，`from=500` 就会**跳过新结果集的前 500 条**：中间一段永远补不到，脚本还报成功。
 * 用 keyword 字段排序后页边界跨请求稳定；`memory_id` 缺失的文档按 ES 默认 `_first`
 * 排，顺序同样确定。
 *
 * `status=mood` 要排除（2026-11-10 实测发现）：`__mood__` 是**内部状态文档**
 * （content 写着「不参与检索」），按设计就永远不会有向量。不排除的话，下面的
 * 「复查仍缺 N 条」会把它算进去 → **有 mood 文档的索引每次跑都 exit 1**，
 * 又是一个假失败。它也确实不需要向量：检索那一路过滤的是 `status='active'`。
 */
const missingBody = {
  size: 500,
  _source: ['content', 'memory_id'],
  sort: [{ memory_id: 'asc' as const }],
  query: {
    bool: {
      must_not: [{ exists: { field: 'embedding' } }, { term: { status: 'mood' } }],
    },
  },
}

/**
 * 翻页取全量：ES 默认 `size` 上限 10000，单页固定 500 会在「缺向量很多」时静默截断
 * （2026-11-02 审计指出：旧版只取一页，超 500 条就只补 500 条还说成功了）。
 *
 * ⚠️ **收集与写回必须是两个循环，不许合并成一个**：下面的写回会让文档离开
 * `must_not exists` 这个结果集，一旦边收边写，下一页 `from=500` 就是在一个
 * 不断缩小的结果集上取偏移 —— 中间那段会被整段跳过。先收完再写，
 * 收集期间结果集才是静态的。
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
// 已补的会离开 `must_not exists` 结果集 → 这里的 total 就是「还剩几条没补上」。
// **不复查就报「已补 N 条」是这类脚本最典型的假成功**：翻页漏掉的中间那段、
// 或者写失败的那批，从输出里完全看不出来（2026-11-10 审查 M6/#25）。
// 复查非 0 就非 0 退出 —— 调用方（cron / 人）据此知道还有活没干完。
if (apply) {
  if (done > 0) {
    // 刚写完的文档要等一次 refresh 才会被检索到（本脚本只动 personal_memory_*，
    // 模板 refresh_interval=5s），**不等就会把「刚补上的」误报成「仍缺」→ 假失败**。
    // 不能改用逐条 `refresh:'wait_for'`：那会让每次写都等最多 5s，1200 条要跑 100 分钟；
    // 也不能在 search 上传 refresh（createEsClient.search 不接该参数）。
    // 若哪天把 personal_memory_* 的 refresh_interval 调大，这个常量要跟着改。
    await new Promise((resolve) => setTimeout(resolve, 5_500))
  }
  const remain = await client.search(index, { ...missingBody, size: 0 })
  const left = remain.total
  console.log(`\n已补 ${done} 条，失败 ${failed} 条；复查仍缺 ${left} 条`)
  if (left > 0) {
    console.error(`✗ 还有 ${left} 条缺向量 —— 不能算成功（多半是上面失败的那批，先看失败原因再重跑）`)
    process.exitCode = 1
  }
}
