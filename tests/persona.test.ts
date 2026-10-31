/**
 * 阶段 9.1：人格内核段。
 *
 * 重点在「不要产生空壳」与「不要炸掉整个提示词」：
 *  - 没配 seed 的部署必须与没装这个插件一致（空段被宿主丢弃）；
 *  - seed 是手写自由文本，含 `{{` 会让宿主的变量插值失败——失败方式是
 *    「模型连启动都收不到提示词」，所以这里必须兜住。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildPersonaSection,
  MEMORY_PROMPT_SECTION,
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
} from '../src/prompt.ts'

describe('buildPersonaSection：人格内核', () => {
  test('没配 seed 时返回空串（宿主整段丢弃，不留空壳）', () => {
    assert.equal(buildPersonaSection('', true), '')
    assert.equal(buildPersonaSection('   \n  ', true), '')
  })

  test('enabled=false 时即便有 seed 也不注入', () => {
    assert.equal(buildPersonaSection('我是昔涟。', false), '')
  })

  test('有 seed 时带上标题与正文，并去掉首尾空白', () => {
    const out = buildPersonaSection('\n\n我是昔涟。\n\n', true)
    assert.match(out, /^# 我的人格\n\n我是昔涟。$/)
  })

  test('`{{ }}` 被换成全角，避免宿主的变量插值炸掉整段提示词', () => {
    const out = buildPersonaSection('我有一个 {{memory}} 的占位', true)
    assert.ok(!out.includes('{{'), '半角双花括号必须消失')
    assert.ok(!out.includes('}}'))
    assert.match(out, /｛｛memory｝｝/)
  })

  test('段名与排序：人格段排在记忆段之前', () => {
    assert.equal(PERSONA_SECTION_NAME, 'dsh-memory-es-persona')
    assert.ok(PERSONA_SECTION_ORDER < MEMORY_PROMPT_SECTION.order, '人格要先于「我知道什么」')
  })
})
