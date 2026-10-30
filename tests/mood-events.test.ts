/**
 * 阶段 6.4 判定层：消息 → 情绪事件。
 *
 * 规则版判定的价值是「便宜且可解释」，所以测试重点在边界：
 * 否定前缀不能误判、中性消息不该产生事件、节流要真的挡住连发。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { classifyUserMessage, extractUserText, MOOD_EVENT_MIN_INTERVAL_MS, MoodEventThrottle } from '../src/mood-events.ts'

describe('classifyUserMessage', () => {
  test('明确夸奖判为 praise', () => {
    assert.equal(classifyUserMessage('太棒了！')?.kind, 'praise')
    assert.equal(classifyUserMessage('这个正是我要的')?.kind, 'praise')
  })

  test('致谢判为 praise', () => {
    assert.equal(classifyUserMessage('谢谢')?.kind, 'praise')
    assert.equal(classifyUserMessage('辛苦了，thanks')?.kind, 'praise')
  })

  test('「不错」是褒义——不能被「不」字带跑', () => {
    assert.equal(classifyUserMessage('这次不错')?.kind, 'praise')
    assert.equal(classifyUserMessage('还不错')?.kind, 'praise')
  })

  test('批评与不满判为 criticism', () => {
    assert.equal(classifyUserMessage('不对，这里是错的')?.kind, 'criticism')
    assert.equal(classifyUserMessage('这个不太行')?.kind, 'criticism')
    assert.equal(classifyUserMessage('你怎么又错了')?.kind, 'criticism')
  })

  test('中性消息不产生事件', () => {
    assert.equal(classifyUserMessage('现在做 5.3'), null)
    assert.equal(classifyUserMessage('把 README 更新一下'), null)
    assert.equal(classifyUserMessage(''), null)
    assert.equal(classifyUserMessage('   '), null)
  })

  test('note 只记命中类别，不含用户原文', () => {
    const signal = classifyUserMessage('谢谢你，xqh 真棒')
    assert.equal(signal?.kind, 'praise')
    assert.ok(signal?.note !== undefined)
    assert.equal(signal?.note.includes('xqh'), false)
  })
})

describe('extractUserText', () => {
  test('字符串直接返回', () => {
    assert.equal(extractUserText('你好'), '你好')
  })

  test('content 是文本块数组时拼接', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: '谢谢' },
        { type: 'image', data: 'xx' },
        { type: 'text', text: '太棒了' },
      ],
    }
    assert.equal(extractUserText(message), '谢谢\n太棒了')
  })

  test('脏数据回空串', () => {
    assert.equal(extractUserText(null), '')
    assert.equal(extractUserText(undefined), '')
    assert.equal(extractUserText({}), '')
    assert.equal(extractUserText({ content: 42 }), '')
    assert.equal(extractUserText({ content: [null, 3, { type: 'text' }] }), '')
  })
})

describe('MoodEventThrottle', () => {
  test('间隔内只放行一次', () => {
    const throttle = new MoodEventThrottle(1000)
    assert.equal(throttle.allow('a', 0), true)
    assert.equal(throttle.allow('a', 500), false)
    assert.equal(throttle.allow('a', 1000), true, '刚好到期就放行')
  })

  test('不同 key 互不影响', () => {
    const throttle = new MoodEventThrottle(1000)
    assert.equal(throttle.allow('a', 0), true)
    assert.equal(throttle.allow('b', 0), true)
  })

  test('默认间隔是 30 秒', () => {
    const throttle = new MoodEventThrottle()
    assert.equal(throttle.allow('a', 0), true)
    assert.equal(throttle.allow('a', MOOD_EVENT_MIN_INTERVAL_MS - 1), false)
    assert.equal(throttle.allow('a', MOOD_EVENT_MIN_INTERVAL_MS), true)
  })

  test('clear 之后重新放行', () => {
    const throttle = new MoodEventThrottle(1000)
    assert.equal(throttle.allow('a', 0), true)
    throttle.clear()
    assert.equal(throttle.allow('a', 1), true)
  })
})
