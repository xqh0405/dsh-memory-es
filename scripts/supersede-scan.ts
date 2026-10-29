#!/usr/bin/env node
/**
 * 个人库冲突扫描 + supersede（阶段 3）。
 *
 * 做什么：找出「语义高度相似、但结论极性相反」的两条记忆，把**较早**的那条标记为
 * 被取代（`superseded_by`），于是它不再出现在检索结果里（`buildFilters` 会过滤），
 * 但仍可按 id 查出来——审计要能回答「当时为什么这么定」。
 *
 * 为什么是独立脚本而不是塞进 consolidate 主流程：
 *  · 主流程做的是「个人库 → 团队库晋升」，这条做的是「个人库内部失效」，两件事；
 *  · 主流程默认跑全量扫描，冲突扫描是 O(n) 次 kNN，量级不同，应该按需跑。
 *
 * **默认 dry-run，什么都不写**；真写必须 `--apply --older <memory_id>` 逐条指定。
 *
 * 为什么不提供「一键全标」：2026-10-29 在 267 条真实数据上跑出 39 对候选，
 * **全部是误判**——判据只做极性词对匹配（「要」vs「不要」），没有主题约束，
 * 于是「DSH skill 子系统」和「skills 扩到 24 个」这种无关条目也会被判成相反结论。
 * 批量写入会误杀 39 条记忆，所以人为增加一道「逐条点名」的门。
 *
 * 用法：
 *   node scripts/supersede-scan.ts                    # 只出候选
 *   node scripts/supersede-scan.ts --apply            # 真标 superseded_by
 *   node scripts/supersede-scan.ts --config ~/.dsh/profiles/web/cordis.patch.yml
 *
 * 判据是**规则版**（consolidate/conflict.ts 的极性词对），只认「必须 vs 禁止」这类
 * 明确相反；换说法的矛盾一律漏——所以它不会误杀，但会漏。漏的部分交给人工。
 *
 * @module scripts/supersede-scan
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { detectContradiction } from '../consolidate/conflict.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

interface Doc {
  id: string
  memoryId: string
  content: string
  created: string
  domain: string
  embedding?: number[]
}

interface Candidate {
  older: Doc
  newer: Doc
  score: number
  reason: string
}

function parseArgs(argv: string[]) {
  const opts = { apply: false, config: DEFAULT_CONFIG_PATH, maxPairs: 200, older: '' }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--config') opts.config = resolve(argv[++i])
    else if (a === '--max-pairs') opts.maxPairs = Number(argv[++i])
    else if (a === '--older') opts.older = argv[++i] ?? ''
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

/** 拉全量 active 文档（含向量，用于逐条 kNN） */
async function loadDocs(es: ReturnType<typeof createEsClient>, index: string): Promise<Doc[]> {
  const res = await es.search(index, {
    size: 1000,
    _source: ['memory_id', 'content', 'created_at', 'domain', 'embedding'],
    query: { term: { status: 'active' } },
  })
  return res.hits.map((hit) => {
    const src = hit.source
    return {
      id: hit.id,
      memoryId: typeof src.memory_id === 'string' ? src.memory_id : hit.id,
      content: typeof src.content === 'string' ? src.content : '',
      created: typeof src.created_at === 'string' ? src.created_at : '',
      domain: typeof src.domain === 'string' ? src.domain : '',
      embedding: Array.isArray(src.embedding) ? (src.embedding as number[]) : undefined,
    }
  })
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const index = `${cfg.personalPrefix}${cfg.userId}`
  const es = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: cfg.requestTimeoutMs,
    username: cfg.username,
    password: cfg.password,
  })

  const docs = await loadDocs(es, index)
  console.log(`扫描 ${docs.length} 条 active 记忆（${index}）`)
  const withVec = docs.filter((d) => d.embedding !== undefined && d.embedding.length === cfg.dims)
  console.log(`其中有可用向量 ${withVec.length} 条\n`)
  if (withVec.length === 0) {
    console.log('没有向量，无法找近邻；先补向量再跑。')
    return
  }

  const byId = new Map(withVec.map((d) => [d.id, d]))
  const seen = new Set<string>()
  const candidates: Candidate[] = []

  for (const doc of withVec) {
    // 每条查一次近邻（k=4：含自己，取前 3 个真邻居）
    const res = await es.search(index, {
      size: 4,
      _source: ['memory_id', 'content', 'created_at', 'domain'],
      knn: {
        field: 'embedding',
        query_vector: doc.embedding,
        k: 4,
        num_candidates: 20,
        filter: { term: { status: 'active' } },
      },
    })
    for (const hit of res.hits) {
      const other = byId.get(hit.id)
      if (other === undefined || other.id === doc.id) continue
      // 一对只判一次（按 id 排序去重）
      const pairKey = [doc.id, other.id].sort().join('|')
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      // 早的是「可能被取代」的那条
      const [older, newer] = doc.created <= other.created ? [doc, other] : [other, doc]
      const verdict = detectContradiction(newer.content, older.content)
      if (!verdict.contradiction) continue
      candidates.push({
        older,
        newer,
        score: typeof hit.score === 'number' ? hit.score : 0,
        reason: verdict.reason,
      })
      if (candidates.length >= opts.maxPairs) break
    }
    if (candidates.length >= opts.maxPairs) break
  }

  if (candidates.length === 0) {
    console.log('没有发现「高相似 + 极性相反」的组合。')
    console.log('这是预期结果：规则判据只认「必须 vs 禁止」这类明确词对，换说法的矛盾不在它的能力范围内。')
    return
  }

  console.log(`== 候选 ${candidates.length} 对（dry-run）==`)
  console.log('⚠️ 这些只是「可能」相反：判据没有主题约束，实测误判率极高，必须人工逐条确认。\n')
  for (const c of candidates) {
    console.log(`相似度 ${c.score.toFixed(3)}  ${c.reason}`)
    console.log(`  旧: ${c.older.memoryId.slice(0, 8)} ${c.older.content.slice(0, 60)}`)
    console.log(`  新: ${c.newer.memoryId.slice(0, 8)} ${c.newer.content.slice(0, 60)}`)
    console.log('')
  }

  if (!opts.apply) {
    console.log('未写入。这是有意的：候选误判率极高，确认某一条后再用 --apply --older <memory_id>。')
    return
  }
  if (opts.older === '') {
    throw new Error('--apply 必须配 --older <memory_id>：不支持批量写入（候选里误判占绝大多数）')
  }
  const picked = candidates.filter((c) => c.older.memoryId.startsWith(opts.older))
  if (picked.length === 0) throw new Error(`没有匹配 --older ${opts.older} 的候选`)
  if (picked.length > 1) throw new Error(`--older ${opts.older} 匹配到 ${picked.length} 条，请给更长的前缀`)

  const target = picked[0]
  await es.update(index, target.older.id, {
    superseded_by: target.newer.memoryId,
    superseded_at: new Date().toISOString(),
    // 保留 status=active：失效由 superseded_by 表达，不动 status，
    // 免得和 consolidate 的 promote_state/状态机混在一起。
  })
  console.log(`已标记 ${target.older.memoryId} 为被 ${target.newer.memoryId} 取代。`)
}

main().catch((err) => {
  console.error('扫描失败：', (err as Error).message)
  process.exit(1)
})
