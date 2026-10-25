/**
 * 集成测试的环境装配：从 `deploy/es/.env`（gitignore、600）读真实凭证。
 *
 * 纪律：本文件**只负责取值，不负责打印**。任何人往测试输出里塞 password 都会
 * 落到 CI 日志里，所以这里导出的结构体不会被 assert 消息引用（断言只比对 kind/status）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 仓库根目录下的 .env（相对本文件：tests/helpers → ../../） */
export const ES_ENV_PATH = fileURLToPath(new URL('../../deploy/es/.env', import.meta.url))
/** 默认 CA 路径（与 scripts/*.sh 一致） */
export const ES_CA_PATH = fileURLToPath(new URL('../../deploy/es/certs/ca.crt', import.meta.url))

export interface EsCredential {
  username: string
  password: string
}

export interface EsTestEnv {
  url: string
  caCertPath: string
  userId: string
  reader: EsCredential
  writer: EsCredential
  /** 整理任务身份：读个人库 + 写团队库（mem_consolidator） */
  consolidator: EsCredential
  /** elastic 超级用户：只用于清理测试数据与读取健康状态（受限身份连 GET / 都是 403） */
  admin: EsCredential
  personalIndex: string
  teamIndex: string
}

/** 极简 .env 解析：跳过空行与 # 注释，值里的 = 原样保留 */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** es.url 是否指向本机（写测试数据的硬前提：别的机器上的 ES 不该被我们写） */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * 读测试环境。返回 null 表示“这台机器没准备好”（.env 不存在或缺关键项），
 * 调用方据此 skip —— 但 skip 的原因必须打印出来，不能静默变绿。
 */
export function loadEsTestEnv(): EsTestEnv | null {
  const fileVars = existsSync(ES_ENV_PATH) ? parseDotEnv(readFileSync(ES_ENV_PATH, 'utf8')) : {}
  const pick = (key: string): string => process.env[key] ?? fileVars[key] ?? ''

  const userId = pick('MEM_USER_ID') === '' ? 'xqh' : pick('MEM_USER_ID')
  const readerPassword = pick('MEM_READER_PASSWORD')
  const writerPassword = pick('MEM_WRITER_PASSWORD')
  const adminPassword = pick('ELASTIC_PASSWORD')
  const consolidatorPassword = pick('MEM_CONSOLIDATOR_PASSWORD')
  if (readerPassword === '' || writerPassword === '' || adminPassword === '' || consolidatorPassword === '') {
    return null
  }

  return {
    url: process.env.MEM_ES_URL ?? 'https://127.0.0.1:9200',
    caCertPath: ES_CA_PATH,
    userId,
    reader: { username: `mem-reader-${userId}`, password: readerPassword },
    writer: { username: 'mem-writer', password: writerPassword },
    consolidator: { username: 'mem-consolidator', password: consolidatorPassword },
    admin: { username: 'elastic', password: adminPassword },
    personalIndex: `personal_memory_${userId}`,
    teamIndex: 'team_knowledge',
  }
}
