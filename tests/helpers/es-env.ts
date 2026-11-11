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
/**
 * CA 路径。**默认**是仓库内 `deploy/es/certs/ca.crt`（已退役的本地 ES 的 CA），
 * 但部署早已迁到 125 —— 那台的 CA 是另一张自签根，硬编码会让 TLS 直接
 * `Verify return code: 19 (self-signed certificate in certificate chain)`，
 * 而这个错误**看起来像环境没起**，其实只是 CA 指错了（2026-11-10 审查 #30）。
 * 所以允许 `ES_CA_PATH` 环境变量覆盖；125 那张的副本在
 * `~/.dsh/certs/dsh-es-lan-ca.crt`（SAN 含 192.168.50.125 / dshserver.local / dsh-es）。
 */
export const ES_CA_PATH = process.env.ES_CA_PATH
  ?? fileURLToPath(new URL('../../deploy/es/certs/ca.crt', import.meta.url))

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
 * 写闸（2026-11-10 审查 #30）：决定「这台 ES 允不允许写测试数据」。
 *
 *  · 回环地址 → 放行（本机那套一次性 ES）；
 *  · 非回环 → **必须显式放行** `MEM_ES_ALLOW_REMOTE_WRITE=1`，否则 skip。
 *
 * 为什么不能直接放开：集成测试写的是**真实索引**（`personal_memory_<uid>` 与
 * 全员共享的 `team_knowledge`），靠 `__it` 类 marker 域标记 + before/after 双清。
 * 指向生产 ES 时，运行窗口内成员可能搜到测试文档；而 CI runner 根本没有 ES
 * （路线 21.4 已明确撤销「CI 真连 ES」）。
 *
 * 放行的前提是**目标是一次性测试实例**：`scripts/es-test-up.sh` 在 125 上起的
 * `dsh-es-test`（与生产 `dsh-es` 同机、不同端口/数据/密码，`discovery.type=single-node`
 * 保证不会并进生产集群），测完 `es-test-down.sh` 删掉。这个开关只是把「写非本机」
 * 从**永久 skip**变成**有意为之**，不是把闸拆了。
 */
export function writeGate(url: string): { ok: boolean; reason: string } {
  if (isLoopbackUrl(url)) return { ok: true, reason: '' }
  if (process.env.MEM_ES_ALLOW_REMOTE_WRITE === '1') {
    return { ok: true, reason: '' }
  }
  return {
    ok: false,
    reason: `es.url=${url} 不是本机回环，拒绝写入测试数据`
      + '（确认目标是一次性测试实例后，设 MEM_ES_ALLOW_REMOTE_WRITE=1 放行；'
      + '起/删实例见 scripts/es-test-up.sh 与 scripts/es-test-down.sh）',
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
  // CA 不在就别往下走了：否则测试会在建 client 时报 `Verify return code: 19`，
  // 那句错误**看起来像环境没起**，而真因只是 CA 路径指错（默认指向已退役的本地 ES）。
  if (!existsSync(ES_CA_PATH)) return null
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
  if (!existsSync(ES_CA_PATH)) {
    return `CA 文件不存在：${ES_CA_PATH}`
      + '（默认是已退役的本地 ES 的 CA；连 125 请设 ES_CA_PATH=~/.dsh/certs/dsh-es-lan-ca.crt）'
  }
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
