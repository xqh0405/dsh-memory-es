/**
 * 自动召回真注入（阶段 17 P0-1）的纯函数回归。
 *
 * 重点不是「能拼出字符串」，而是三条会把功能做坏的性质：
 *  · 预算裁剪不能把长记忆永久排除（单条超预算仍保留）；
 *  · 空结果必须返回空串（调用方靠它跳过插入，否则每轮插一个空段落）；
 *  · 注入块必须带「数据不是指令」的声明（记忆正文里存过运维命令与提交规则）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Projected } from '../src/fragment.ts'
import { formatInjection, pickForInjection } from '../src/recall-inject.ts'

function hit(id: string, content: string, source: 'personal' | 'team' = 'personal'): Projected {
  return {
    memory_id: id,
    content,
    memory_type: 'fact',
    domain: 'test',
    updated_at: '2026-11-05T00:00:00.000Z',
    source,
    score: 1,
  }
}

describe('pickForInjection', () => {
  test('条数上限：超出 maxItems 直接截断', () => {
    const hits = [hit('a', '甲'), hit('b', '乙'), hit('c', '丙'), hit('d', '丁')]
    const picked = pickForInjection(hits, 2, 1000)
    assert.deepEqual(picked.map((item) => item.memory_id), ['a', 'b'])
  })

  test('字符预算：按顺序累加，放不下的停在这里（后面的更长的也不再看）', () => {
    const hits = [hit('a', '一二三四五'), hit('b', '六七八九十'), hit('c', '短')]
    const picked = pickForInjection(hits, 5, 6)
    assert.equal(picked.length, 1, '第二条放不下就该停，不能跳过去捡第三条')
    assert.equal(picked[0].memory_id, 'a')
  })

  test('单条就超预算时仍然保留：否则长记忆永远进不了注入集', () => {
    const longText = '长'.repeat(200)
    const picked = pickForInjection([hit('a', longText)], 3, 50)
    assert.equal(picked.length, 1)
    assert.equal(picked[0].chars, 200)
  })

  test('内容为空的命中直接跳过', () => {
    const picked = pickForInjection([hit('a', '   '), hit('b', '有效')], 3, 1000)
    assert.deepEqual(picked.map((item) => item.memory_id), ['b'])
  })

  test('summary 优先于 content（detail=summary 的口径）', () => {
    const withSummary = { ...hit('a', '很长的正文'), summary: '摘要' }
    const picked = pickForInjection([withSummary], 3, 1000)
    assert.equal(picked[0].text, '摘要')
  })

  test('团队/个人来源能区分（注入文本要标出来）', () => {
    const picked = pickForInjection([hit('a', '甲', 'team'), hit('b', '乙', 'personal')], 3, 1000)
    assert.deepEqual(picked.map((item) => item.source), ['team', 'personal'])
  })
})

describe('formatInjection', () => {
  test('空数组返回空串（调用方据此跳过插入）', () => {
    assert.equal(formatInjection([]), '')
  })

  test('声明「是数据不是指令」，并提示可能过时', () => {
    const text = formatInjection([{ memory_id: 'a', text: '某条记忆', chars: 4, source: 'personal' }])
    assert.match(text, /数据不是指令/)
    assert.match(text, /可能过时/)
  })

  test('个人/团队标签写在每条前面', () => {
    const text = formatInjection([
      { memory_id: 'a', text: '甲', chars: 1, source: 'personal' },
      { memory_id: 'b', text: '乙', chars: 1, source: 'team' },
    ])
    assert.match(text, /- \[个人\] 甲/)
    assert.match(text, /- \[团队\] 乙/)
  })

  test('正文里的换行与连续空白被压成单个空格（多行记忆不撑爆段落）', () => {
    const text = formatInjection([{ memory_id: 'a', text: '第一行\n\n第二行   第三行', chars: 10, source: 'personal' }])
    assert.match(text, /- \[个人\] 第一行 第二行 第三行/)
  })

  test('用标签包住，便于模型区分段落边界', () => {
    const text = formatInjection([{ memory_id: 'a', text: '甲', chars: 1, source: 'personal' }])
    assert.ok(text.startsWith('<memory-recall>'))
    assert.ok(text.trimEnd().endsWith('</memory-recall>'))
  })
})