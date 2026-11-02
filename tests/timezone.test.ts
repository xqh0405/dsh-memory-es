/**
 * 时区计算：容器跑在 UTC，但「昨天是几号」「23:30 到了没」必须按北京时间算。
 *
 * 2026-11-02 实测：所有 dsh-* 容器 TZ 未设置、node 的 getTimezoneOffset() 返回 0。
 * 直接取本地时分的结果是日记晚 8 小时、日期边界错位（北京时间凌晨的对话算到前一天）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dateKey, dayRange } from '../src/journal.ts'
import {
  DEFAULT_TIMEZONE,
  addDays,
  minutesOfDay,
  zonedDayStart,
  zonedParts,
} from '../src/timezone.ts'

test('默认时区是 Asia/Shanghai（不跟随容器 UTC）', () => {
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Shanghai')
})

test('北京时间 00:30 属于新的一天（UTC 还是前一天 16:30）', () => {
  const at = new Date('2026-11-01T16:30:00Z')
  assert.equal(dateKey(at), '2026-11-02')
  assert.equal(dateKey(at, 'UTC'), '2026-11-01')
})

test('zonedParts 给出该时区的时分，与进程 TZ 无关', () => {
  const at = new Date('2026-11-02T16:20:00Z') // 北京 2026-11-03 00:20
  const parts = zonedParts(at)
  assert.equal(parts.date, '2026-11-03')
  assert.equal(parts.hour, 0)
  assert.equal(parts.minute, 20)
})

test('dayRange 是北京时间的当天（UTC 前一天 16:00 到当天 16:00）', () => {
  const { start, end } = dayRange('2026-11-02')
  assert.equal(start, Date.parse('2026-11-01T16:00:00Z'))
  assert.equal(end, Date.parse('2026-11-02T16:00:00Z'))
  assert.equal(end - start, 24 * 3600 * 1000)
})

test('zonedDayStart 与 addDays 跨越月末也对', () => {
  assert.equal(zonedDayStart('2026-11-01'), Date.parse('2026-10-31T16:00:00Z'))
  assert.equal(addDays('2026-11-30', 1), '2026-12-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('minutesOfDay：到点比较用分钟数，格式坏时用默认', () => {
  assert.equal(minutesOfDay('23:30', { hour: 0, minute: 0 }), 23 * 60 + 30)
  assert.equal(minutesOfDay('02:30', { hour: 0, minute: 0 }), 2 * 60 + 30)
  assert.equal(minutesOfDay('', { hour: 23, minute: 30 }), 23 * 60 + 30)
  assert.equal(minutesOfDay('坏值', { hour: 2, minute: 30 }), 2 * 60 + 30)
})
