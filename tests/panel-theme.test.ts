/**
 * 面板原生控件配色的结构守卫。
 *
 * 2026-11-20 用户实测：「人格」页预设下拉在暗色主题下深底深字，几乎看不清。
 * 根因是插件给 `<select>` 只写了内联 background/color —— Chrome 的 option 弹层是
 * UA 自己画的，不继承这套配色，主题又没声明 color-scheme，于是弹层按系统浅色取
 * 黑字、底色却用了 select 的深色。
 *
 * 这里不测渲染（本仓库没有浏览器跑测试），只钉住「三种兜底都还在」这个结构事实：
 * 少了任何一条，暗色下都会重新变成看不清。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const SRC = readFileSync(new URL('../panel/client.js', import.meta.url), 'utf8')

const css = (() => {
  const start = SRC.indexOf('const WORKSPACE_CSS = [')
  assert.ok(start > 0, '找不到 WORKSPACE_CSS')
  const end = SRC.indexOf('].join(', start)
  assert.ok(end > start, '找不到 WORKSPACE_CSS 的数组结尾')
  return SRC.slice(start, end)
})()

describe('面板原生控件配色', () => {
  test('主区声明了明暗两档 color-scheme', () => {
    assert.ok(
      /\[\\$\{WORKSPACE_ATTR\}\] \{ color-scheme: light; \}/.test(css)
        || css.includes('color-scheme: light'),
      '缺少亮色档 color-scheme：原生弹层/滚动条不会跟随主题',
    )
    assert.ok(
      css.includes('body[data-ds-dark-theme]') && css.includes('color-scheme: dark'),
      '缺少暗色档 color-scheme：下拉弹层在暗色下仍是浅色画布',
    )
  })

  test('select option 显式给了底色与文字色（亮/暗各一条）', () => {
    const optionRules = css
      .split('\n')
      .filter((line) => line.includes('select option {') || line.includes('select option:checked {'))
    assert.ok(
      optionRules.length >= 3,
      `select option 规则不足 3 条（实际 ${optionRules.length}）：亮色、暗色、选中态各需要一条`,
    )
    for (const rule of optionRules) {
      assert.ok(rule.includes('color:'), `option 规则缺少 color：${rule.trim()}`)
    }
  })

  test('暗色档的字色与底色不是同一组 token（否则对比度会归零）', () => {
    const dark = css
      .split('\n')
      .find((line) => line.includes('body[data-ds-dark-theme]') && line.includes('select option {'))
    assert.ok(dark !== undefined, '找不到暗色档的 select option 规则')
    const tokens = [...dark.matchAll(/--dsw-static-neutral-bluish-\d+/g)].map((m) => m[0])
    assert.equal(new Set(tokens).size, tokens.length, `暗色档底色与字色用了同一个 token：${dark.trim()}`)
  })
})
