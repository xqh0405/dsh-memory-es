/**
 * 短指令短路（2026-11-15 巡检后新增）的判定回归。
 *
 * 为什么必须用白名单而不是「长度 ≤ N」：
 * 巡检实测 zhongjinqi 76% 的注入 query 是 ≤6 字，但 `北单接口` 这种 4 字查询是有信息量的，
 * 用长度门槛会把它一起跳过。所以这里钉住两端：
 *  · 白名单里的推进/确认语义 → 命中（跳过检索零损失）；
 *  · 短但有信息、或长句里以「继续」开头 → 不命中（必须照常检索）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isShortCommand, SHORT_COMMAND_MAX_CHARS } from '../src/recall-inject.ts'

describe('isShortCommand', () => {
  test('日常推进/确认词命中（含中英文与错拼）', () => {
    for (const word of ['继续', '继续吧', '继续写', '开始', '开始做', '开始执行', '提交', '提交一下', '好', '好的', '嗯', '可以', '行', 'ok', 'OK', 'okay', 'jixu', 'go', '√', '✓']) {
      assert.equal(isShortCommand(word), true, `${word} 应该被判为短指令`)
    }
  })

  test('去标点与空白后仍能命中（同一个人会在「继续/继续吧/继续！/继续…」之间混用）', () => {
    for (const word of [' 继续 ', '继续。', '继续！', '继续…', '好，', 'OK!', '  jixu  ']) {
      assert.equal(isShortCommand(word), true, `${JSON.stringify(word)} 归一化后应命中`)
    }
  })

  test('短但有信息量 → 不命中（长度门槛会误杀的就是这一类）', () => {
    for (const query of ['北单接口', '订单状态', '重建索引', 'Nacos 配置', '48.36 库']) {
      assert.equal(isShortCommand(query), false, `${query} 是有信息量的查询，不能跳过检索`)
    }
  })

  test('长句即使以「继续」开头也不命中', () => {
    const long = '继续把订单服务的并发问题查一下'
    assert.equal(isShortCommand(long), false)
    assert.ok(long.length > SHORT_COMMAND_MAX_CHARS)
  })

  test('空串与纯空白不命中（它们的处理在调用方，不在这里吞掉）', () => {
    assert.equal(isShortCommand(''), false)
    assert.equal(isShortCommand('   '), false)
    assert.equal(isShortCommand('。！？'), false)
  })

  test('大小写与全角标点不影响判定', () => {
    assert.equal(isShortCommand('ＯＫ'), false, '全角字母不在白名单（真实输入里几乎不出现，宁可不跳）')
    assert.equal(isShortCommand('Yes'), true)
  })
})
