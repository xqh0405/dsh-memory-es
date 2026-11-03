/**
 * 批量晋升：把筛过的「团队通用」候选从个人库推进 team_knowledge。
 *
 * 走正门而非裸写：团队文档的 topic_key / content_sha256 / embedding / importance 等
 * 全部从个人库原条目继承（同源才可溯源），source_memory_id 指回原条目，
 * 写完回写个人库 promote_state='promoted' —— 与历史 268 条的形态一致（review_state=auto，
 * 检索过滤只认 auto/approved）。
 *
 * 一次 kNN 两用：对 team_knowledge 查邻居 → cos≥0.85 判重跳过；[0.55,0.85) 直接当边写入
 * （新条目尚未入库，结果里必然没有自己，无需 exclude）。
 *
 * 用法：
 *   node scripts/promote-team.ts --file cand-team-merged.json [--dry]
 *   候选格式：{ memories: [{ ...原 cand 字段, source_user: "xqh", source_id: "个人库完整id" }] }
 *   凭据取 .chat-inspect/creds/<source_user>.env
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { pickNeighbors } from '../src/edges.ts'
import type { Edge } from '../src/edges.ts'
import { knnBody } from '../src/es/dsl.ts'
import { createEsClient } from '../src/es/http.ts'
import type { EsClient } from '../src/es/http.ts'

// 连接信息一律走环境变量：本仓库是公开的，不能把内网地址与家目录写死。
// 本机用法：export MEM_ES_URL=https://<内网地址>:9200 MEM_ES_CA=/path/to/ca.crt
const ES_URL = process.env.MEM_ES_URL ?? 'https://127.0.0.1:9200'
const CA = process.env.MEM_ES_CA ?? join(homedir(), '.dsh', 'certs', 'es-ca.crt')
const TEAM_INDEX = 'team_knowledge'
const PERSONAL_PREFIX = 'personal_memory_'
const DIMS = 1024
// 与 src/config.ts 的 edges 默认值对齐
const EDGE_CFG = { topK: 5, minScore: 0.55, maxScore: 0.85 } as const
// 团队库判重带：与 memory_promote 的 maxScore 同源
const DUP_SCORE = 0.85
// 字面复核阈值（字符 bigram dice）：≥ 视为真重复；实测主题相近但内容新的一对仅 0.12
const DUP_TEXT_SIM = 0.45

/** 字符 bigram dice 相似度：对中文有效，0（完全不同）~1（全同） */
function textSim(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const t = new Set<string>()
    const n = s.replace(/\s+/g, '')
    for (let i = 0; i < n.length - 1; i++) t.add(n.slice(i, i + 2))
    return t
  }
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

interface Candidate {
  content: string
  content_exact?: string
  memory_type?: string
  importance?: string
  domain?: string
  summary?: string
  semantic_keywords?: string[]
  source_user: string
  /** 个人库完整 memory_id（溯源用） */
  source_id: string
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next
      i++
    } else {
      out[a.slice(2)] = 'true'
    }
  }
  return out
}

function loadCreds(uid: string): { username: string; password: string } {
  const raw = readFileSync(new URL(`../.chat-inspect/creds/${uid}.env`, import.meta.url), 'utf8')
  const get = (k: string): string => (raw.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
  const username = get('MEM_USERNAME')
  const password = get('MEM_PASSWORD')
  if (!username || !password) throw new Error(`creds/${uid}.env 缺 MEM_USERNAME/MEM_PASSWORD`)
  return { username, password }
}

const clientCache = new Map<string, EsClient>()
function clientFor(uid: string): EsClient {
  const hit = clientCache.get(uid)
  if (hit) return hit
  const creds = loadCreds(uid)
  const client = createEsClient({
    url: ES_URL,
    caCertPath: CA,
    username: creds.username,
    password: creds.password,
    requestTimeoutMs: 20_000,
  })
  clientCache.set(uid, client)
  return client
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file ?? ''
  const dry = args.dry !== undefined
  if (!file) {
    console.error('用法: node scripts/promote-team.ts --file <merged.json> [--dry]')
    process.exit(2)
  }

  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const list: Candidate[] = Array.isArray(parsed) ? parsed : parsed.memories
  if (!Array.isArray(list)) throw new Error('候选文件必须是数组或 {memories:[...]}')

  // 团队库读写固定用 xqh 身份：mem_team_write 只授给了 xqh，
  // 其他成员的凭据读团队库可以（mem_team_read 全员有）、写必 403。
  // 个人库侧仍按 source_user 各用各的账号（mem_personal_rw_<uid> 只精确到自己索引）。
  const teamClient = clientFor('xqh')

  let promoted = 0
  let skippedDup = 0
  let skippedAlready = 0
  let skippedNoSource = 0
  let failed = 0

  for (const [i, c] of list.entries()) {
    const tag = `#${i}[${c.source_user}/${(c.source_id ?? '').slice(0, 8)}]`
    try {
      if (!c.source_id || !c.source_user) {
        console.log(`  -   ${tag} 缺 source_id/source_user，跳过`)
        skippedNoSource++
        continue
      }
      const personal = clientFor(c.source_user)
      const pIndex = `${PERSONAL_PREFIX}${c.source_user}`

      // 1. 读个人库原条目：继承 topic_key / sha / embedding / created_at
      const orig = await personal.get(pIndex, c.source_id)
      const o = orig.source as {
        topic_key?: string
        content_sha256?: string
        embedding?: number[]
        created_at?: string
        content?: string
        content_exact?: string
        status?: string
        promote_state?: string
      }
      if (o.status !== 'active') {
        console.log(`  -   ${tag} 原条目 status=${o.status}，跳过`)
        skippedNoSource++
        continue
      }
      // 第一层防重复：已晋升过的直接跳过（团队库侧 kNN+字面判重是第二层兜底）
      if (o.promote_state === 'promoted') {
        console.log(`  -   ${tag} promote_state=promoted，已晋升过，跳过`)
        skippedAlready++
        continue
      }
      if (!Array.isArray(o.embedding) || o.embedding.length !== DIMS) {
        console.log(`  x   ${tag} 原条目无有效向量，无法判重/建边`)
        failed++
        continue
      }
      const content = c.content ?? String(o.content ?? '')

      // 2. 一次 kNN：对团队库判重 + 拿建边候选
      const probe = Math.max(EDGE_CFG.topK * 3, EDGE_CFG.topK)
      const neighbors = await teamClient.search(TEAM_INDEX, knnBody(o.embedding, DIMS, { status: 'active' }, probe))
      const scored = neighbors.hits.map((h) => ({
        id: typeof (h.source as { memory_id?: string }).memory_id === 'string'
          ? ((h.source as { memory_id: string }).memory_id)
          : h.id,
        score: h.score,
      }))
      const best = scored.reduce((m, s) => Math.max(m, s.score), 0)
      if (best >= DUP_SCORE) {
        // 主题相近 ≠ 内容重复：向量把同项目同主题的增量事实也判到 0.85+
        // （实测 cos=0.904 的一对，字面相似仅 0.12）。二次字面复核（字符 bigram dice）：
        // 真重复必然字面也像（≥0.45）；字面低 = 主题相近但内容全新 → 放行。
        const near = scored.find((s) => s.score >= DUP_SCORE)
        const nearDoc = near ? await teamClient.get(TEAM_INDEX, near.id).catch(() => null) : null
        const nearContent = String((nearDoc?.source as { content?: string })?.content ?? '')
        const ratio = nearContent === '' ? 0 : textSim(content, nearContent)
        if (ratio >= DUP_TEXT_SIM) {
          console.log(`  ~   ${tag} 真重复：cos=${best.toFixed(3)} 字面=${ratio.toFixed(2)} vs ${near?.id.slice(0, 8)}，跳过`)
          skippedDup++
          continue
        }
        console.log(`  +?  ${tag} 主题相近但内容新：cos=${best.toFixed(3)} 字面=${ratio.toFixed(2)}，放行`)
      }
      const edges: Edge[] = pickNeighbors(scored, {
        minScore: EDGE_CFG.minScore,
        maxScore: EDGE_CFG.maxScore,
        topK: EDGE_CFG.topK,
      })

      if (dry) {
        console.log(`  dry ${tag} 可晋升（最高相似 ${best.toFixed(3)}，将带 ${edges.length} 条边）`)
        promoted++
        continue
      }

      // 3. 构造团队文档（字段与 team_knowledge strict mapping 对齐，全部同源继承）
      const now = new Date().toISOString()
      const docId = crypto.randomUUID()
      const doc = {
        doc_id: docId,
        content,
        content_exact: c.content_exact ?? String(o.content_exact ?? content),
        content_sha256: o.content_sha256 ?? '',
        memory_type: c.memory_type ?? 'fact',
        domain: c.domain ?? 'general',
        topic_key: o.topic_key ?? `${c.domain ?? 'general'}:${docId.slice(0, 16).replace(/-/g, '')}`,
        importance: c.importance ?? 'normal',
        ...(Array.isArray(c.semantic_keywords) && c.semantic_keywords.length > 0
          ? { semantic_keywords: c.semantic_keywords.join(' ') }
          : {}),
        source_user: c.source_user,
        source_memory_id: c.source_id,
        source_created_at: o.created_at ?? now,
        promoted_at: now,
        updated_at: now,
        status: 'active',
        review_state: 'auto',
        embedding: o.embedding,
        related: edges,
      }
      await teamClient.index(TEAM_INDEX, doc, { id: docId, refresh: 'wait_for' })

      // 4. 回写个人库 promote_state
      await personal.update(pIndex, c.source_id, { promote_state: 'promoted', updated_at: now }, { refresh: 'wait_for' })

      promoted++
      console.log(`  +   ${tag} 已晋升 team_knowledge/${docId.slice(0, 8)}（边 ${edges.length}，相似 ${best.toFixed(3)}）`)
    } catch (err) {
      failed++
      console.error(`  x   ${tag} ${String(err instanceof Error ? err.message : err).slice(0, 220)}`)
    }
  }

  console.log(`done: promoted=${promoted} skippedAlready=${skippedAlready} skippedDup=${skippedDup} skippedNoSource=${skippedNoSource} failed=${failed}${dry ? '（dry-run）' : ''}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
