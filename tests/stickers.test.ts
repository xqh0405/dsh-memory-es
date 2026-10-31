/**
 * 阶段 9.2：表情包段。
 *
 * 两条硬要求：
 *  1. **定义不可信**——`stickers.json` 是部署者手写的，缺 `when` 的条目会让模型乱贴，
 *     所以逐项校验、坏项直接丢；
 *  2. **缺失不是故障**——图片不进仓库，多数部署一开始就没有这个目录，
 *     此时必须安静地不注入，而不是报错或留下半个段。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildStickersSection,
  parseStickerPack,
  STICKERS_SECTION_NAME,
  STICKERS_SECTION_ORDER,
} from '../src/prompt.ts'

const OK_JSON = JSON.stringify({
  version: 1,
  items: [
    { id: 'happy', label: '超开心', file: '超开心.png', when: '事情成了' },
    { id: 'nice', label: '点赞', file: '点赞.jpeg', when: '认可一个判断' },
  ],
})

describe('parseStickerPack：定义校验', () => {
  test('合法定义解析出条目', () => {
    const pack = parseStickerPack(OK_JSON, '/tmp/stickers')
    assert.ok(pack !== null)
    assert.equal(pack.items.length, 2)
    assert.equal(pack.dir, '/tmp/stickers')
    assert.equal(pack.items[0]?.file, '超开心.png')
  })

  test('缺 when 的条目被丢掉（没有判断依据，模型会乱贴）', () => {
    const json = JSON.stringify({
      items: [
        { id: 'a', label: 'A', file: 'a.png', when: '该贴的时候' },
        { id: 'b', label: 'B', file: 'b.png' },
      ],
    })
    const pack = parseStickerPack(json, '/tmp/s')
    assert.equal(pack?.items.length, 1)
    assert.equal(pack?.items[0]?.id, 'a')
  })

  test('一条都不合法时返回 null（宁可不注入）', () => {
    assert.equal(parseStickerPack(JSON.stringify({ items: [{ id: 'x' }] }), '/tmp/s'), null)
    assert.equal(parseStickerPack(JSON.stringify({ items: [] }), '/tmp/s'), null)
    assert.equal(parseStickerPack(JSON.stringify({}), '/tmp/s'), null)
  })

  test('JSON 坏了返回 null，不抛错', () => {
    assert.equal(parseStickerPack('{ 不是 json', '/tmp/s'), null)
  })
})

describe('buildStickersSection：提示段', () => {
  const pack = parseStickerPack(OK_JSON, '/tmp/stickers')

  test('没有表情包时不注入（空串，宿主整段丢弃）', () => {
    assert.equal(buildStickersSection(null, 1, true), '')
  })

  test('enabled=false 时不注入', () => {
    assert.equal(buildStickersSection(pack, 1, false), '')
  })

  test('带上张数上限、每条 label/when 与绝对路径', () => {
    const text = buildStickersSection(pack, 1, true)
    assert.equal(text.includes('一次回复最多贴 1 张'), true)
    assert.equal(text.includes('超开心｜事情成了'), true)
    assert.equal(text.includes('![超开心](</tmp/stickers/超开心.png>)'), true)
    assert.equal(text.includes('![点赞](</tmp/stickers/点赞.jpeg>)'), true)
  })

  test('目录带尾斜杠时不会拼出双斜杠', () => {
    const p = parseStickerPack(OK_JSON, '/tmp/stickers/')
    const text = buildStickersSection(p, 2, true)
    assert.equal(text.includes('//超开心.png'), false)
    assert.equal(text.includes('/tmp/stickers/超开心.png'), true)
  })

  test('段名与排序：排在心情段之后', () => {
    assert.equal(STICKERS_SECTION_NAME, 'dsh-memory-es-stickers')
    assert.equal(STICKERS_SECTION_ORDER, 3202)
  })
})
