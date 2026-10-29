/**
 * 评测脚本共用的配置读取：从 dsh profile 的 `cordis.patch.yml` 里取 `dsh-memory-es` 段。
 *
 * 为什么不用 YAML 库：整份文件里混着 `!!js` 标签，标准 YAML 解析会直接失败；
 * 而这里只需要几个标量，按文本切段取值更稳。凭据也不进命令行（避免进 ps）。
 *
 * @module scripts/lib/plugin-config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PluginConfig {
  esUrl: string
  caCertPath: string
  requestTimeoutMs: number
  username: string
  password: string
  userId: string
  personalPrefix: string
  teamIndex: string
  embedUrl: string
  embedModel: string
  dims: number
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')

export function parsePluginConfig(path: string = DEFAULT_CONFIG_PATH): PluginConfig {
  const text = readFileSync(path, 'utf8')
  const m = /- id: dsh-memory-es\n([\s\S]*?)(?=\n- id: |\n# |\Z)/.exec(text)
  if (m === null) throw new Error(`${path} 里没有 dsh-memory-es 配置段`)
  const seg = m[1]
  const first = (re: RegExp, src: string) => {
    const hit = re.exec(src)
    return hit?.[1].trim().replace(/^['"]|['"]$/g, '')
  }
  // `url` 有两处（es 与 embedding），embedding 的必须从 embedding 段之后再找；
  // `model` 也有两处（distill 是空串），同理。
  const embSeg = seg.slice(seg.indexOf('embedding:'))
  const cfg: PluginConfig = {
    esUrl: first(/^\s*url:\s*(.+)$/m, seg) ?? '',
    caCertPath: first(/^\s*caCertPath:\s*(.+)$/m, seg) ?? '',
    requestTimeoutMs: Number(first(/^\s*requestTimeoutMs:\s*(.+)$/m, seg) ?? '8000'),
    username: first(/^\s*username:\s*(.+)$/m, seg) ?? '',
    password: first(/^\s*password:\s*(.+)$/m, seg) ?? '',
    userId: first(/^\s*userId:\s*(.+)$/m, seg) ?? 'xqh',
    personalPrefix: first(/^\s*personalPrefix:\s*(.+)$/m, seg) ?? 'personal_memory_',
    teamIndex: first(/^\s*team:\s*(.+)$/m, seg) ?? 'team_knowledge',
    embedUrl: first(/^\s*url:\s*(.+)$/m, embSeg) ?? 'http://127.0.0.1:11434',
    embedModel: first(/^\s*model:\s*(.+)$/m, embSeg) ?? 'bge-m3',
    dims: Number(first(/^\s*dims:\s*(.+)$/m, embSeg) ?? '1024'),
  }
  for (const k of ['esUrl', 'username', 'password'] as const) {
    if (cfg[k] === '') throw new Error(`配置缺少 ${k}（${path}）`)
  }
  return cfg
}
