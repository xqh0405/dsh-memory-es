/**
 * 恢复被准入隔离的记忆，并补齐恢复后的三件事。
 *
 * 面板 POST /memories/restore 只改 status（面板侧没有 embedding 服务，恢复后只能关键词检索）；
 * 本脚本比它多做两步：用 Ollama(bge-m3) 补写向量、再走 link-backfill 同款逻辑建边，
 * 让恢复后的条目与正常写入的条目完全同构（可向量检索、可图遍历）。
 *
 * 用法：
 *   node scripts/restore-quarantine.ts --user <uid> --id <完整ES _id> [--dry]
 *   凭据取 .chat-inspect/creds/<uid>.env；跑完建议再执行 link-backfill 补边
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import type { EsClient } from '../src/es/http.ts'

// 连接信息一律走环境变量：本仓库是公开的，不能把内网地址与家目录写死。
// 本机用法：export MEM_ES_URL=https://<内网地址>:9200 MEM_ES_CA=/path/to/ca.crt
const ES_URL = process.env.MEM_ES_URL ?? 'https://127.0.0.1:9200'
const CA = process.env.MEM_ES_CA ?? join(homedir(), '.dsh', 'certs', 'es-ca.crt')
const EMBED_URL = process.env.MEM_EMBED_URL ?? 'http://127.0.0.1:11434'
const PERSONAL_PREFIX = 'personal_memory_'
const DIMS = 1024

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
  const id = args.id ?? ''
  const dry = args.dry !== undefined
  if (!uid || !id) {
    console.error('用法: node scripts/restore-quarantine.ts --user <uid> --id <完整id> [--dry]')
    process.exit(2)
  }

  const creds = loadCreds(uid)
  const es: EsClient = createEsClient({
    url: ES_URL,
    caCertPath: CA,
    username: creds.username,
    password: creds.password,
    requestTimeoutMs: 20_000,
  })
  const index = `${PERSONAL_PREFIX}${uid}`

  const current = await es.get(index, id)
  const source = current.source as {
    status?: string
    content?: string
    embedding?: number[]
    quarantine_reason?: string
    /** 隔离时被写成 `skipped`；恢复要置回 `pending` 才能重新蒸馏（#16） */
    distill_state?: string
  }
  console.log(`id=${id} status=${source.status} reason=${source.quarantine_reason ?? '-'}`)
  if (source.status !== 'quarantine') {
    console.log('不是 quarantine 状态，无需恢复')
    return
  }

  // 存局部变量而不是反复读 source.embedding：TS 不会因为 hasVec 为 true 就收窄可选字段，
  // 直接写 source.embedding.length 会报 TS18048（2026-11-03 类型闸门抓到）
  const existingVector = Array.isArray(source.embedding) ? source.embedding : undefined
  const hasVec = existingVector !== undefined && existingVector.length === DIMS
  console.log(`现有向量: ${hasVec ? `len=${existingVector.length}` : '无（按设计隔离不写向量）'}`)
  if (dry) {
    console.log('dry-run：将置 active + 清 reason + 补向量（隔离条目本就无向量）')
    return
  }

  // 1. 恢复状态（与面板 POST /memories/restore 同语义）
  //    外加把 distill_state 从 `skipped` 重置回 `pending`（2026-11-10 审查 #16）：
  //    隔离时 saveMemory 写的是 `skipped`，不重置的话清扫只查 pending，这条**永不蒸馏**。
  //    （下面第 2 步的向量是**按当前原文**算的；置回 pending 后，蒸馏改写正文时会按新正文重建一次，
  //     两段向量都指向真实正文，不会出现「内容变了向量还是旧的」。）
  const requeue = String(source.distill_state ?? '') === 'skipped'
  const now = new Date().toISOString()
  await es.update(index, id, {
    status: 'active',
    quarantine_reason: null,
    ...(requeue ? { distill_state: 'pending' } : {}),
    updated_at: now,
  }, { refresh: 'wait_for' })
  console.log(`① status → active，quarantine_reason 已清${requeue ? '，distill_state → pending（重新排队蒸馏）' : '（distill_state 保持原样）'}`)

  // 2. 补向量（面板做不到的那步；隔离条目 embedding 恒为 null）
  const embed = createEmbedder({ url: EMBED_URL, model: 'bge-m3', dims: DIMS, timeoutMs: 30_000 })
  const content = String(source.content ?? '')
  if (content === '') throw new Error('content 为空，无法补向量')
  const vector = await embed.embed(content)
  if (vector.length !== DIMS) throw new Error(`向量维度 ${vector.length} ≠ ${DIMS}`)
  await es.update(index, id, { embedding: vector }, { refresh: 'wait_for' })
  console.log(`② 向量已补（len=${vector.length}，bge-m3）`)

  console.log('③ 下一步：跑 link-backfill 补边（本条 status 已 active，会被窗口查询捞到）')
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
