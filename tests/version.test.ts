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

  test('README 的版本声明与 package.json 一致（防对外版本漂移）', () => {
    // 对外第一印象就在 README。2026-11-05 实测它停在 0.6.15 而包已是 0.6.26，
    // 漂了 11 个版本没人发现 —— 所以钉在这里。
    // 只钉「声明式」的两处（页首 + 「版本」节）；命令示例里的数字是说明性举例，不参与比对。
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const expected = pkgVersion('../package.json')

    const declared = [
      ...readme.matchAll(/当前版本[：:]\s*\**(\d+\.\d+\.\d+)/g),
      ...readme.matchAll(/当前\s+\*\*(\d+\.\d+\.\d+)\*\*/g),
    ].map((match) => match[1])

    assert.equal(declared.length, 2, `README 应有 2 处版本声明，实际 ${declared.length} 处：${declared.join('、')}`)
    for (const found of declared) {
      assert.equal(found, expected, `README 写 ${found}，package.json 是 ${expected}`)
    }
  })
})
