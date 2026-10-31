/**
 * 版本号守卫。
 *
 * 0.3.0 起插件与面板是**同一个包**，版本号只在 `package.json` 里写一次：
 * 主插件的 `ready` 日志与面板的 `/overview`（页脚）都读它。
 * 这组测试把「格式是数字 semver + 主插件与面板读的是同一处」钉住。
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
  test('包根 package.json 有版本，且是 X.Y.Z 纯数字', () => {
    const version = pkgVersion('../package.json')
    assert.match(version, SEMVER, `版本号必须形如 0.3.0，当前是「${version}」`)
  })

  test('面板读的是包根的版本（合并后不再有 panel/package.json）', () => {
    const panel = readFileSync(new URL('../panel/index.js', import.meta.url), 'utf8')
    assert.match(panel, /new URL\('\.\.\/package\.json', import\.meta\.url\)/)
    // 反向断言：如果哪天又出现独立的 panel/package.json，这里会红
    assert.throws(() => readFileSync(new URL('../panel/package.json', import.meta.url)))
  })

  test('运行时能读到版本（ready 日志与 /overview 都靠它）', () => {
    // import.meta.url 在 tests/ 下，../package.json 指向包根——与 lib/index.js 的相对位置同构
    assert.equal(readVersion(import.meta.url), pkgVersion('../package.json'))
  })

  test('读不到时降级为 unknown，而不是抛错', () => {
    assert.equal(readVersion(import.meta.url, '../definitely-not-here.json'), 'unknown')
  })
})
