/**
 * 阶段 6.2 情绪状态：纯函数行为。
 *
 * 重点钉住三件事：会衰减、只由事件改、平静时不注入。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyMoodEvent,
  decayMood,
  decayState,
  MOOD_DELTAS,
  MOOD_HALF_LIFE_HOURS,
  MOOD_MAX_EVENTS,
  MOOD_SILENT_THRESHOLD,
  moodLabel,
  NEUTRAL_MOOD,
  readMoodState,
  renderMoodLine,
  type MoodState,
} from '../src/mood.ts'

const T0 = new Date('2026-10-30T12:00:00.000Z')
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000)

describe('decayMood / decayState', () => {
  test('一个半衰期后偏离量减半', () => {
    assert.equal(decayMood(0.8, MOOD_HALF_LIFE_HOURS), 0.4)
    assert.equal(decayMood(0.8, MOOD_HALF_LIFE_HOURS * 2), 0.2)
  })

  test('零/负时长不衰减；非法输入回 0 或原值', () => {
    assert.equal(decayMood(0.8, 0), 0.8)
    assert.equal(decayMood(0.8, -1), 0.8)
    assert.equal(decayMood(Number.NaN, 3), 0)
  })

  test('decayState 把 updatedAt 推到当前时间', () => {
    const state: MoodState = { valence: 0.6, arousal: 0.3, updatedAt: T0.toISOString(), events: [] }
    const next = decayState(state, hours(MOOD_HALF_LIFE_HOURS))
    assert.equal(next.valence, 0.3)
    assert.equal(next.updatedAt, hours(MOOD_HALF_LIFE_HOURS).toISOString())
  })

  test('从未更新过的中性态原样返回', () => {
    const next = decayState(NEUTRAL_MOOD, hours(5))
    assert.equal(next.valence, 0)
    assert.equal(next.updatedAt, null)
  })
})

describe('applyMoodEvent', () => {
  test('夸奖抬升、批评压低', () => {
    const praised = applyMoodEvent(NEUTRAL_MOOD, 'praise', T0)
    assert.equal(praised.valence, MOOD_DELTAS.praise)
    const scolded = applyMoodEvent(NEUTRAL_MOOD, 'criticism', T0)
    assert.equal(scolded.valence, MOOD_DELTAS.criticism)
  })

  test('clamp 在 [-1, 1]：连夸 20 次也不会超过 1', () => {
    let state = NEUTRAL_MOOD
    for (let i = 0; i < 20; i += 1) state = applyMoodEvent(state, 'praise', T0)
    assert.ok(state.valence <= 1)
    assert.ok(state.valence > 0.7)
    assert.ok(state.arousal <= 1)
  })

  test('事件按新→旧排列，并受 MOOD_MAX_EVENTS 截断', () => {
    let state = NEUTRAL_MOOD
    for (let i = 0; i < MOOD_MAX_EVENTS + 5; i += 1) {
      state = applyMoodEvent(state, 'tool_ok', hours(i))
    }
    assert.equal(state.events.length, MOOD_MAX_EVENTS)
    assert.equal(state.events[0]?.at, hours(MOOD_MAX_EVENTS + 4).toISOString(), '最新事件在最前')
  })

  test('事件之间会先衰减：隔很久的夸奖累加得很轻', () => {
    const close = applyMoodEvent(applyMoodEvent(NEUTRAL_MOOD, 'praise', T0), 'praise', T0)
    const far = applyMoodEvent(applyMoodEvent(NEUTRAL_MOOD, 'praise', T0), 'praise', hours(MOOD_HALF_LIFE_HOURS * 3))
    assert.ok(close.valence > far.valence)
  })

  test('未知事件类型直接抛（不要静默接受写错的 kind）', () => {
    assert.throws(() => applyMoodEvent(NEUTRAL_MOOD, 'excited' as never, T0), /未知的情绪事件类型/)
  })

  test('note 可选，且不会把用户原文塞进去', () => {
    const state = applyMoodEvent(NEUTRAL_MOOD, 'praise', T0, '用户明确夸奖')
    assert.equal(state.events[0]?.note, '用户明确夸奖')
    assert.equal(applyMoodEvent(NEUTRAL_MOOD, 'praise', T0).events[0]?.note, undefined)
  })
})

describe('moodLabel / renderMoodLine', () => {
  test('标签按阈值分档', () => {
    assert.equal(moodLabel(0.9), '愉快')
    assert.equal(moodLabel(0.2), '不错')
    assert.equal(moodLabel(0), '平静')
    assert.equal(moodLabel(-0.2), '有点闷')
    assert.equal(moodLabel(-0.9), '低落')
  })

  test('平静时不注入（返回空串）', () => {
    assert.equal(renderMoodLine(NEUTRAL_MOOD, T0), '')
    const faint = applyMoodEvent(NEUTRAL_MOOD, 'tool_ok', T0)
    assert.ok(Math.abs(faint.valence) < MOOD_SILENT_THRESHOLD)
    assert.equal(renderMoodLine(faint, T0), '')
  })

  test('有情绪时给一行短提示，不含数字', () => {
    const happy = applyMoodEvent(applyMoodEvent(NEUTRAL_MOOD, 'praise', T0), 'praise', T0)
    const line = renderMoodLine(happy, T0)
    assert.match(line, /心情/)
    assert.doesNotMatch(line, /\d/, '不要暴露数值')
  })

  test('单次夸奖必须注入（阈值不能被 delta 顶着）', () => {
    const once = applyMoodEvent(NEUTRAL_MOOD, 'praise', T0)
    // 哪怕已经过了几秒（衰减一点点），也仍然要注入——这是 0.15 阈值时代的 bug
    assert.notEqual(renderMoodLine(once, new Date(T0.getTime() + 5_000)), '', '一次「谢谢」就该有反应')
    const scolded = applyMoodEvent(NEUTRAL_MOOD, 'criticism', T0)
    assert.notEqual(renderMoodLine(scolded, new Date(T0.getTime() + 5_000)), '', '一次明确批评也该有反应')
  })

  test('单次工具失败不外露（阈值高于 0.10）', () => {
    const failed = applyMoodEvent(NEUTRAL_MOOD, 'tool_error', T0)
    assert.equal(renderMoodLine(failed, T0), '', '偶发报错不该改变口吻')
  })

  test('情绪会随时间淡出：很久之后又变回不注入', () => {
    const happy = applyMoodEvent(NEUTRAL_MOOD, 'praise', T0)
    assert.notEqual(renderMoodLine(happy, T0), '')
    assert.equal(renderMoodLine(happy, hours(MOOD_HALF_LIFE_HOURS * 6)), '')
  })
})

describe('readMoodState', () => {
  test('缺失字段回中性', () => {
    const state = readMoodState({})
    assert.equal(state.valence, 0)
    assert.equal(state.arousal, 0)
    assert.equal(state.updatedAt, null)
    assert.deepEqual(state.events, [])
  })

  test('脏事件被丢掉，合法事件保留', () => {
    const state = readMoodState({
      mood_valence: 0.42,
      mood_arousal: 0.2,
      mood_updated_at: T0.toISOString(),
      mood_events: [
        { kind: 'praise', at: T0.toISOString(), delta: 0.15 },
        { kind: 'no-such-kind', at: T0.toISOString() },
        { kind: 'criticism' },
        null,
        { kind: 'tool_error', at: T0.toISOString() },
      ],
    })
    assert.equal(state.valence, 0.42)
    assert.equal(state.events.length, 2)
    assert.deepEqual(state.events.map((e) => e.kind), ['praise', 'tool_error'])
  })

  test('越界值被夹回区间', () => {
    const state = readMoodState({ mood_valence: 5, mood_arousal: -3 })
    assert.equal(state.valence, 1)
    assert.equal(state.arousal, 0)
  })
})
