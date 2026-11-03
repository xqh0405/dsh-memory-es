/**
 * 补边脚本：给漏建 related 的记忆补邻接边。
 *
 * 背景：.chat-inspect/ingest.ts 调 saveMemory 时没传 edges 配置（src/index.ts:159 才传），
 * 导致巡检蒸馏写入的记忆只有向量、related 恒为 []。本脚本按插件默认参数
 * （topK=5 / minScore=0.55 / maxScore=0.85 / dims=1024）走同一套
 * knnBody → pickNeighbors → 读回 mergeEdges → update，幂等可重跑。
 *
 * 用法：
 *   node scripts/link-backfill.ts --user <uid> [--since '2026-11-03'] [--dry]
 *   凭据取 .chat-inspect/creds/<uid>.env（MEM_USERNAME / MEM_PASSWORD）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { pickNeighbors, mergeEdges, readEdges } from '../src/edges.ts'
import { knnBody } from '../src/es/dsl.ts'
import { createEsClient } from '../src/es/http.ts'
import type { EsClient } from '../src/es/http.ts'

// 连接信息一律走环境变量：本仓库是公开的，不能把内网地址与家目录写死。
// 本机用法：export MEM_ES_URL=https://<内网地址>:9200 MEM_ES_CA=/path/to/ca.crt
const ES_URL = process.env.MEM_ES_URL ?? 'https://127.0.0.1:9200'
const CA = process.env.MEM_ES_CA ?? join(homedir(), '.dsh', 'certs', 'es-ca.crt')
const PERSONAL_PREFIX = 'personal_memory_'

// 与 src/config.ts 的 edges 默认值、embedding.dims(bge-m3) 对齐
const EDGE_CFG = { topK: 5, minScore: 0.55, maxScore: 0.85, dims: 1024 } as const

interface Doc {
  id: string
  related: unknown
  embedding?: number[]
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const uid = args.user ?? ''
  if (!uid) {
    console.error('用法: node scripts/link-backfill.ts --user <uid> [--since ...] [--index team_knowledge --time-field updated_at] [--dry]')
    process.exit(2)
  }
  const since = args.since ?? '2026-01-01'
  const dry = args.dry !== undefined

  const creds = loadCreds(uid)
  const es: EsClient = createEsClient({
    url: ES_URL,
    caCertPath: CA,
    username: creds.username,
    password: creds.password,
    requestTimeoutMs: 20_000,
  })
  // --index 可覆盖目标索引（团队库传 team_knowledge），--time-field 配时间字段
  // （个人库按 created_at、团队库没有该字段要按 updated_at/promoted_at）
  const index = args.index ?? `${PERSONAL_PREFIX}${uid}`
  const timeField = args['time-field'] ?? 'created_at'

  // 1. 找出该时间窗内 active 且 related 为空的条目（先不取 embedding，省流量）
  const found = await es.search(index, {
    query: {
      bool: {
        filter: [
          { range: { [timeField]: { gte: since } } },
          { term: { status: 'active' } },
          // related 是 enabled:false 的 object，空数组查不出来，用 exists 反选 + 人工筛
        ],
      },
    },
    sort: [{ [timeField]: 'asc' }],
    size: 200,
    _source: { excludes: ['embedding'] },
  })

  const todo: Doc[] = found.hits
    .map((h) => ({ id: h.id, related: (h.source as { related?: unknown }).related }))
    .filter((d) => !Array.isArray(d.related) || d.related.length === 0)

  console.log(
    `user=${uid} index=${index} 窗口内 active=${found.total} 待补边=${todo.length}` +
      `${dry ? '（dry-run 不写）' : ''}`,
  )
  if (todo.length === 0) return

  let linked = 0
  let skipped = 0
  let failed = 0

  for (const doc of todo) {
    try {
      // 2. 单独取 embedding（kNN 查询向量）
      const full = await es.get(index, doc.id)
      const embedding = (full.source as { embedding?: number[] }).embedding
      if (!Array.isArray(embedding) || embedding.length !== EDGE_CFG.dims) {
        console.log(`  skip ${doc.id.slice(0, 8)}：embedding 缺失或维度≠${EDGE_CFG.dims}`)
        skipped++
        continue
      }

      // 3. kNN 找邻居（多取 3 倍候选过区间过滤，与 probeNeighbors 一致）
      // 候选广度：topK*3 只够「库里同主题稀疏」的场景；同批晋升几十条后，
      // kNN 前 15 名会被判重带（≥0.85）的兄弟挤满，[0.55,0.85) 的邻居进不了候选 → 0 边。
      // 补边不是热路径，直接取 50 个候选再过区间过滤。
      const topKProbe = Math.max(EDGE_CFG.topK * 10, 50)
      const neighbors = await es.search(index, knnBody(embedding, EDGE_CFG.dims, { status: 'active' }, topKProbe))
      const scored = neighbors.hits.map((h) => ({
        id: typeof (h.source as { memory_id?: string }).memory_id === 'string'
          ? ((h.source as { memory_id: string }).memory_id)
          : h.id,
        score: h.score,
      }))

      const picked = pickNeighbors(scored, {
        excludeId: doc.id,
        minScore: EDGE_CFG.minScore,
        maxScore: EDGE_CFG.maxScore,
        topK: EDGE_CFG.topK,
      })
      if (picked.length === 0) {
        console.log(`  -   ${doc.id.slice(0, 8)}：区间内无邻居（噪声/判重带外）`)
        skipped++
        continue
      }

      if (dry) {
        console.log(`  dry ${doc.id.slice(0, 8)}：将加 ${picked.length} 条边 → ${picked.map((e) => `${e.id.slice(0, 8)}(${e.weight})`).join(', ')}`)
        linked++
        continue
      }

      // 4. 读回再合并（幂等，重跑不冲掉已有边）→ 写回
      const current = await es.get(index, doc.id)
      const next = mergeEdges(readEdges((current.source as { related?: unknown }).related), picked, EDGE_CFG.topK)
      await es.update(index, doc.id, { related: next }, { refresh: 'wait_for' })
      console.log(`  +   ${doc.id.slice(0, 8)}：${picked.length} 条边（共 ${next.length}）`)
      linked++
    } catch (err) {
      failed++
      console.error(`  x   ${doc.id.slice(0, 8)}：${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    }
  }

  console.log(`done: linked=${linked} skipped=${skipped} failed=${failed}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
