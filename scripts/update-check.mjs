#!/usr/bin/env node
/**
 * 手动检查有没有新版本（**只读**，不下载、不安装、不改索引）。
 *
 * 用途：
 *  · 第一次部署后确认「GitHub 可达 + 版本号能对上」；
 *  · 排障时看一眼本地版与 Release 版谁更新（升级后版本没变多半是没重启）。
 *
 * 完整链路（下载/体检/安装/重启）由插件自己的定时器执行，见 `src/update.ts`。
 *
 * 用法：
 *   node scripts/update-check.mjs
 *   node scripts/update-check.mjs --repo owner/repo
 */

import { readFileSync } from 'node:fs'

import { compareVersions } from '../src/update.ts'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  return process.argv[index + 1] ?? fallback
}

const repo = arg('repo', 'xqh0405/dsh-memory-es')
const localVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

console.log(`本地版本：v${localVersion}`)
console.log(`仓库     ：${repo}`)

let release = null
try {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-memory-es-update' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  release = await response.json()
} catch (err) {
  console.error(`查最新版本失败：${String(err)}`)
  process.exit(1)
}

const tag = String(release?.tag_name ?? '').replace(/^v/i, '')
if (!/^\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`Release tag 不合法：「${String(release?.tag_name ?? '')}」`)
  process.exit(1)
}

const names = (release.assets ?? []).map((item) => item.name)
const archive = `dsh-memory-es-${tag}.tar.gz`
const hasArchive = names.includes(archive)
const hasSha = names.includes(`${archive}.sha256`)

console.log(`最新版本：v${tag}`)
console.log(`发行包  ：${archive} ${hasArchive ? '✓' : '✗'} / sha256 ${hasSha ? '✓' : '✗'}`)

const diff = compareVersions(tag, localVersion)
if (diff <= 0) {
  console.log('结论：已是最新（或本地版本更新），不需要升级')
  process.exit(0)
}
if (!hasArchive || !hasSha) {
  console.log('结论：有新版本，但 Release 缺发行包或 sha256 —— 插件会自动跳过这类版本')
  process.exit(0)
}
console.log('结论：可以升级。插件会在下一个检查点（默认 06:00）执行；'
  + '管理员实例先补索引字段，成员实例只换代码。')
