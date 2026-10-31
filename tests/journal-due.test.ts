/**
 * 每日回顾的「到点判定」守门。
 *
 * 这里钉的是 2026-10-31 巡检发现的死循环：调度器原先每小时醒一次，而 due=23:30 之后
 * 的下一个整点是 00:00（当天已过），于是 `maybeRunDailyJournal` 永远只会判断「新的一天还没到 23:30」——
 * **正在运行的长进程永远不会写当天的回顾**。修法是把检查粒度改到 5 分钟（index.ts），
 * 这组测试保证「23:30 之后确实会进入执行分支」这个语义不被改回去。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { maybeRunDailyJournal, type JournalRunDeps } from '../src/journal.ts'

/** 最小依赖：hasJournal 查不到、写库成功、素材目录不存在（于是停在 too-few-turns，不会真的调模型） */
function deps(overrides: Partial<JournalRunDeps> = {}): JournalRunDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    reader: {
      search: async () => ({ hits: [], took: 0, total: 0 }),
    } as never,
    writer: {
      index: async () => ({ id: 'journal-2026-10-31', result: 'created', status: 201 }),
    } as never,
    summarize: async () => '今天的回顾正文',
    at: '23:30',
    root: '/definitely-not-a-real-dir',
    ...overrides,
  }
}

describe('每日回顾的到点判定（23:30）', () => {
  test('23:29 → not-due（一分钟都不提前写）', async () => {
    const result = await maybeRunDailyJournal(deps({ root: '/tmp' }), new Date('2026-10-31T23:29:00+08:00'))
    assert.equal(result.ran, false)
    assert.equal(result.reason, 'not-due')
  })

  test('23:31 → 进入执行分支（不再卡在 not-due）', async () => {
    const result = await maybeRunDailyJournal(deps(), new Date('2026-10-31T23:31:00+08:00'))
    assert.equal(result.ran, false)
    assert.notEqual(result.reason, 'not-due')
    assert.match(result.reason, /too-few-turns/)
    assert.equal(result.date, '2026-10-31')
  })

  test('00:05（已跨天）→ 对新的一天是 not-due：所以检查粒度必须细于 1 小时', async () => {
    const result = await maybeRunDailyJournal(deps({ root: '/tmp' }), new Date('2026-11-01T00:05:00+08:00'))
    assert.equal(result.reason, 'not-due')
    // not-due 分支不带 date（还没进入「今天」的处理），这正是 23:30 之后必须再检查一次的原因
    assert.equal(result.date, undefined)
  })
})
