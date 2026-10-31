/**
 * 版本号一致性守卫。
 *
 * 版本号散在两个包里（主插件 + 面板），而面板页脚与 `/overview` 显示的是**服务端读到的**
 * 那份，所以两处必须永远同号。历史教训是「部署了新版，页脚还是旧号」——比没有版本号更误导。
 * 这组测试把「两处一致 + 格式是数字 semver + 能被运行时读到」钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { readVersion } from '../src/version.ts'

const SEMVER = /^\d+\.\d+\.\d+$/

function pkgVersion(relative: string): string {
  const pkg = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { version?: string }
  return pkg.version ?? ''
}

describe('版本号', () => {
  test('主插件与面板的 package.json 版本一致', () => {
    assert.equal(pkgVersion('../package.json'), pkgVersion('../panel/package.json'))
  })

  test('版本是 X.Y.Z 纯数字（不出现 -beta / 日期串）', () => {
    const version = pkgVersion('../package.json')
    assert.match(version, SEMVER, `版本号必须形如 0.2.0，当前是「${version}」`)
  })

  test('运行时能读到版本（ready 日志与 /overview 都靠它）', () => {
    // import.meta.url 在 tests/ 下，../package.json 指向包根——与 lib/index.js 的相对位置同构
    assert.equal(readVersion(import.meta.url), pkgVersion('../package.json'))
  })

  test('读不到时降级为 unknown，而不是抛错', () => {
    assert.equal(readVersion(import.meta.url, '../definitely-not-here.json'), 'unknown')
  })
})
