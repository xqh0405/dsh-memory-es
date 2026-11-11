#!/usr/bin/env node
/**
 * 回填 `content_sha256` / `content_exact`（2026-11-10 审查 #11）。
 *
 * 起因：`distillMemory` 改写正文时**只更新了 content/summary/keywords/向量**，
 * 没同步这两个派生字段 ——
 *  · `content_exact`（标识符精确匹配，dsl.ts 的 IDENTIFIER_FIELD）停在**旧正文**的 token 上，
 *    新正文里的标识符（接口名/路径/版本号）精确匹配永远不加分；
 *  · `content_sha256`（去重键，dsl.ts 的 dedupeBody）与内容脱钩：
 *    对「蒸馏后正文」再 memory_save 不去重 → 产生同内容副本；
 *    对「原始正文」保存却命中旧 sha 回「已存在」→ 回执不实。
 *
 * 口径与 `buildMemoryDoc` 完全一致（这是本脚本存在的理由，别各算各的）：
 *   content_exact   = content（原文）
 *   content_sha256  = sha256Hex(normalizeContent(content))（归一化后）
 *
 * 用法：
 *   node scripts/backfill-distill-keys.ts           # dry-run：只报告有多少条漂了
 *   node scripts/backfill-distill-keys.ts --apply   # 真的写回
 *
 * 幂等：算出来一致就不写；重跑第二次应当是 0 条。
 *
 * ⚠️ 索引名由 `user_id` 还原（`personalPrefix + user_id`）——
 * `EsClient.mapRawHits` 不透传 `_index`，而本脚本要跨全部 `personal_memory_*` 扫，
 * 文档必带 `user_id`（buildMemoryDoc 强制），所以这条路是精确的；缺 `user_id` 的直接跳过并报数。
 */
import { normalizeContent, sha256Hex } from '../src/fragment.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const apply = process.argv.includes('--apply')
const cfg = parsePluginConfig(DEFAULT_CONFIG_PATH)
const client = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})

/** 单页条数。ES 默认 size 上限 10000；本库量级（<1000）一页就够，留循环是防以后涨。 */
const PAGE = 500

interface Row {
  index: string
  id: string
  content: string
  storedSha: string
  storedExact: string
}

/** 取全部个人记忆（只要算 sha/exact 需要的字段，省带宽） */
const rows: Row[] = []
for (let from = 0; ; from += PAGE) {
  const page = await client.search(`${cfg.personalPrefix}*`, {
    from,
    size: PAGE,
    // created_at 全库都有（buildMemoryDoc / journal / traits / persona 都写），排序稳定
    sort: [{ created_at: 'asc' }],
    _source: ['content', 'content_sha256', 'content_exact', 'user_id'],
    query: { exists: { field: 'content' } },
  })
  for (const hit of page.hits) {
    const src = hit.source
    const userId = typeof src.user_id === 'string' ? src.user_id : ''
    const content = typeof src.content === 'string' ? src.content : ''
    if (userId === '' || content === '') continue
    rows.push({
      index: `${cfg.personalPrefix}${userId}`,
      id: hit.id,
      content,
      storedSha: typeof src.content_sha256 === 'string' ? src.content_sha256 : '',
      storedExact: typeof src.content_exact === 'string' ? src.content_exact : '',
    })
  }
  if (page.hits.length < PAGE) break
  if (rows.length >= 10_000) {
    console.log('⚠️ 超过 10000 条，只处理前 10000（请分批跑）')
    break
  }
}

/** 漂移判定：任一字段与「按正文重算」的结果不一致就算漂 */
const drifted = rows.filter((row) => {
  const wantSha = sha256Hex(normalizeContent(row.content))
  const wantExact = row.content
  return row.storedSha !== wantSha || row.storedExact !== wantExact
})

console.log(
  `扫描 ${rows.length} 条 · 漂移 ${drifted.length} 条`
  + `${apply ? '' : '（dry-run，加 --apply 才写）'}`,
)
if (drifted.length === 0) {
  console.log('✅ 无需回填')
  process.exit(0)
}

// 按索引分组：一次 update 一条，量级（几十到几百）不需要 bulk
const byIndex = new Map<string, Row[]>()
for (const row of drifted) {
  const bucket = byIndex.get(row.index)
  if (bucket) bucket.push(row)
  else byIndex.set(row.index, [row])
}
for (const [index, list] of byIndex) {
  console.log(`  ${index}: ${list.length} 条`)
}

if (!apply) {
  console.log('\n（预演结束。确认数量合理后加 --apply）')
  process.exit(0)
}

let updated = 0
let failed = 0
for (const row of drifted) {
  try {
    // 不带 refresh：回填不需要「写完立刻能读到」，而 wait_for 会让每次 update 都强制
    // 刷一遍分片 —— 290 条跑 300s 都跑不完（2026-11-10 实测 exit 124）。
    // 幂等靠「算出来一致就跳过」保证，不靠读己之写。
    await client.update(row.index, row.id, {
      content_sha256: sha256Hex(normalizeContent(row.content)),
      content_exact: row.content,
    })
    updated += 1
    if (updated % 50 === 0) console.log(`  … ${updated}/${drifted.length}`)
  } catch (err) {
    failed += 1
    console.error(`  写回失败 ${row.index}/${row.id}: ${String((err as Error).message ?? err).slice(0, 160)}`)
  }
}
console.log(`\n完成：写回 ${updated} 条 · 失败 ${failed} 条`)
console.log('复跑一次应当显示「漂移 0 条」——那就是幂等验证通过。')
