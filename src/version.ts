/**
 * 插件版本号：**唯一来源是 `package.json` 的 `version`**。
 *
 * 为什么运行时读文件而不是写常量：
 *  · 常量会和 package.json 漂移，而漂移只在「升级后看不出是哪一版」时才暴露；
 *  · `lib/index.js` 与包根的 `package.json` 相对位置固定（dsh 把整个包复制进 profile，
 *    `files` 里也包含 package.json），所以 `../package.json` 在仓库内运行与安装后运行都成立。
 *
 * 读不到就返回 `unknown`——版本是观测信息，不能成为启动失败的原因。
 *
 * @module dsh-memory-es/version
 */

import { readFileSync } from 'node:fs'

/** 从 `import.meta.url` 所在的模块往上找 package.json（默认上一级） */
export function readVersion(metaUrl: string, relative = '../package.json'): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL(relative, metaUrl), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version.trim() : 'unknown'
  } catch {
    return 'unknown'
  }
}
