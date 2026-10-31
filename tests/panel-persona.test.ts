/**
 * 面板「人格」页的结构守卫。
 *
 * 2026-10-31 踩过：四个 card(...) 写在一个 `h('div', null, a, b, c, d)` 里时，
 * 括号层级错位让前三个变成**逗号表达式**，`return (a, b, c, d)` 只返回最后一个 ——
 * 页面只剩「日记」一块，语法检查却完全通过。
 * 所以这里不测渲染，只钉住「四块都被显式列进 return」这个结构事实。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const SRC = readFileSync(new URL('../panel/client.js', import.meta.url), 'utf8')

const personaSegment = (() => {
  const start = SRC.indexOf('function Persona({ t })')
  assert.ok(start > 0, '找不到 Persona 组件')
  const end = SRC.indexOf('function Identity({ t })', start)
  assert.ok(end > start, '找不到 Persona 之后的 Identity 组件')
  return SRC.slice(start, end)
})()

const CARDS = ['kernelCard', 'learnedCard', 'stickersCard', 'diaryCard']

describe('面板人格页结构', () => {
  test('四块各自先赋给变量', () => {
    for (const name of CARDS) {
      assert.ok(
        personaSegment.includes(`const ${name} = card(`),
        `${name} 应写成独立变量，而不是塞进深层嵌套`,
      )
    }
  })

  test('四块都显式列在 return 里（否则会被逗号表达式吃掉）', () => {
    const ret = personaSegment.slice(personaSegment.lastIndexOf('return h('))
    for (const name of CARDS) {
      assert.ok(ret.includes(name), `return 里缺少 ${name}`)
    }
  })

  test('return 里没有再出现裸的 card( 调用（说明都已变量化）', () => {
    const ret = personaSegment.slice(personaSegment.lastIndexOf('return h('))
    assert.equal(ret.includes('card('), false, 'return 段不应直接调用 card()')
  })
})

describe('面板配置合并', () => {
  const indexSrc = readFileSync(new URL('../panel/index.js', import.meta.url), 'utf8')

  test('mergeConfig 取两边的键并集（不能只遍历 DEFAULTS）', () => {
    const start = indexSrc.indexOf('function mergeConfig(')
    assert.ok(start > 0, '找不到 mergeConfig')
    const body = indexSrc.slice(start, indexSrc.indexOf('\n}', start))
    assert.ok(
      body.includes('Object.keys(inherited') && body.includes('Object.keys(override'),
      'mergeConfig 必须把配置里出现的组也纳入合并，否则 persona/stickers 这类新组会被静默丢弃',
    )
  })

  test('DEFAULTS 收录 persona 与 stickers', () => {
    assert.ok(indexSrc.includes('persona: { enabled: true, seed: \'\' }'))
    assert.ok(indexSrc.includes('stickers: {'))
  })
})

describe('人格内核可在面板编辑', () => {
  const indexSrc2 = readFileSync(new URL('../panel/index.js', import.meta.url), 'utf8')

  test('persona.seed 进了可编辑白名单（否则 /config 会 400）', () => {
    assert.ok(
      indexSrc2.includes("{ path: ['persona', 'seed'], label: '人格内核'"),
      'EDITABLE 必须收录 persona.seed',
    )
    assert.ok(indexSrc2.includes("{ path: ['persona', 'enabled'], label: '启用人格'"))
  })

  test('写盘前有长度上限（自由文本也要拦一下）', () => {
    assert.ok(indexSrc2.includes("change.key === 'persona.seed'"))
    assert.ok(indexSrc2.includes('20000'))
  })

  test('客户端通过既有 /config 通道保存，不另开写接口', () => {
    assert.ok(personaSegment.includes('saveSeed'))
    assert.ok(personaSegment.includes("apiPost('/config'"))
    assert.ok(personaSegment.includes("key: 'persona.seed'"))
  })
})

describe('人格内核保存不被折叠标量毁掉', () => {
  const indexSrc3 = readFileSync(new URL('../panel/index.js', import.meta.url), 'utf8')

  test('写入前把单换行加倍（折叠后正好还原）', () => {
    assert.ok(
      indexSrc3.includes('\\n(?!\\n)') && indexSrc3.includes("'\\n\\n'"),
      'configEditor 会把多行串写成折叠标量 >，单换行折成空格；写入前必须加倍',
    )
  })

  test('写后有读回校验，不一致要如实报 warn', () => {
    assert.ok(indexSrc3.includes('人格内核读回不一致'))
  })
})
