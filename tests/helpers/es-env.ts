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
 *
 * 两种账号形态都支持：
 *  · 单账号（2026-10 起，一人一账号 `mem-user-<uid>`）：`MEM_USERNAME` + `MEM_PASSWORD`，
 *    读写同一身份；缺团队写权限时相关用例会按权限失败，不会假装通过。
 *  · 旧的多身份：`MEM_READER_PASSWORD` / `MEM_WRITER_PASSWORD` / `MEM_CONSOLIDATOR_PASSWORD` + `ELASTIC_PASSWORD`。
 *
 * 2026-11-02 评审：原来只认旧多身份，单账号迁移后所有集成用例**永久 skip，且 skip 文案
 * 说「未找到 deploy/es/.env」——文件其实在**。现在缺项会把**具体缺哪个键**报出来。
 */
export function loadEsTestEnv(): EsTestEnv | null {
  const fileVars = existsSync(ES_ENV_PATH) ? parseDotEnv(readFileSync(ES_ENV_PATH, 'utf8')) : {}
  const pick = (key: string): string => process.env[key] ?? fileVars[key] ?? ''

  const userId = pick('MEM_USER_ID') === '' ? 'xqh' : pick('MEM_USER_ID')
  const adminPassword = pick('ELASTIC_PASSWORD')

  // 单账号形态优先：一个身份读写自己的索引
  const singleUser = pick('MEM_USERNAME')
  const singlePassword = pick('MEM_PASSWORD')
  if (singleUser !== '' && singlePassword !== '') {
    const single = { username: singleUser, password: singlePassword }
    return {
      url: pick('MEM_ES_URL') || 'https://127.0.0.1:9200',
      caCertPath: ES_CA_PATH,
      userId,
      reader: single,
      writer: single,
      consolidator: single,
      admin: { username: 'elastic', password: adminPassword === '' ? singlePassword : adminPassword },
      personalIndex: `personal_memory_${userId}`,
      teamIndex: 'team_knowledge',
    }
  }

  const readerPassword = pick('MEM_READER_PASSWORD')
  const writerPassword = pick('MEM_WRITER_PASSWORD')
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

/**
 * 集成为什么跑不了 —— 给 skip 文案用（**只列键名，不打印任何值**）。
 *
 * 旧文案「未找到 deploy/es/.env」在文件存在但账号形态变化时会指错方向，
 * 让人误以为环境没起。
 */
export function esSkipReason(): string {
  if (!existsSync(ES_ENV_PATH)) {
    return `未找到 ${ES_ENV_PATH}（先跑 scripts/es-up.sh 与 scripts/init-security.sh）`
  }
  const fileVars = parseDotEnv(readFileSync(ES_ENV_PATH, 'utf8'))
  const pick = (key: string): string => process.env[key] ?? fileVars[key] ?? ''
  const missing: string[] = []
  const singleOk = pick('MEM_USERNAME') !== '' && pick('MEM_PASSWORD') !== ''
  if (!singleOk) {
    for (const key of ['MEM_READER_PASSWORD', 'MEM_WRITER_PASSWORD', 'MEM_CONSOLIDATOR_PASSWORD', 'ELASTIC_PASSWORD']) {
      if (pick(key) === '') missing.push(key)
    }
    return `${ES_ENV_PATH} 在，但缺少凭据键：${missing.join(' / ')}（单账号形态可只填 MEM_USERNAME + MEM_PASSWORD）`
  }
  return '凭据齐了但 loadEsTestEnv 返回空（不应发生，请查 tests/helpers/es-env.ts）'
}
