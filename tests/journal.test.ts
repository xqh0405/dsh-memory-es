/**
 * 每日回顾的纯函数测试。
 *
 * 重点不是"模型写得好不好"（那要真跑），而是**素材抽取的口径**：
 * 只认当天、只认真人消息、配对方向正确。这三条错了，模型写得再顺也是错的。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  JOURNAL_MAX_CHARS,
  buildJournalPrompt,
  dateKey,
  dayRange,
  extractDayTurns,
  journalMemoryId,
  parseJournalOutput,
} from '../src/journal.ts'

const DAY = '2026-10-31'
const { start, end } = dayRange(DAY)

function line(type: string, time: number, data: Record<string, unknown>): string {
  return JSON.stringify({ type, seq: 1, time, data })
}

// ⚠️ 两种消息结构不对称，测试样例必须照实现来：
//    user/message → data.content（直接）
//    assistant/message → data.message.content（包一层）
function userLine(time: number, text: string, kind = 'user'): string {
  return line('user/message', time, {
    source: { kind },
    content: [{ type: 'text', text }],
  })
}

function assistantLine(time: number, text: string): string {
  return line('assistant/message', time, {
    message: { content: [{ type: 'text', text }] },
  })
}

describe('dayRange', () => {
  test('左闭右开，且是本地时区的 24 小时', () => {
    const range = dayRange('2026-10-31')
    assert.equal(new Date(range.start).getDate(), 31)
    assert.equal(new Date(range.start).getHours(), 0)
    assert.equal(new Date(range.end).getDate(), 1)
    assert.equal(range.end - range.start, 24 * 3600 * 1000)
  })

  test('dateKey 用本地日期，不会因 UTC 串天', () => {
    // 本地 00:30（UTC 还是前一天）：toISOString 会给出前一天，dateKey 必须给当天
    const at = new Date(2026, 9, 31, 0, 30, 0)
    assert.equal(dateKey(at), '2026-10-31')
  })
})

describe('extractDayTurns', () => {
  test('配对：用户先说、助手后答', () => {
    const log = [
      userLine(start + 1000, '帮我看下备份为什么失败'),
      assistantLine(start + 2000, '日志显示 max_allowed_packet 不够'),
    ].join('\n')
    const turns = extractDayTurns(log, 's1', start, end)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].user, '帮我看下备份为什么失败')
    assert.equal(turns[0].assistant, '日志显示 max_allowed_packet 不够')
    assert.equal(turns[0].session, 's1')
  })

  test('不在当天的消息一律丢弃', () => {
    const log = [
      userLine(start - 5000, '昨天的话'),
      assistantLine(start - 4000, '昨天的回复'),
      userLine(start + 1000, '今天的话'),
      assistantLine(start + 2000, '今天的回复'),
      userLine(end + 1000, '明天的话'),
      assistantLine(end + 2000, '明天的回复'),
    ].join('\n')
    const turns = extractDayTurns(log, 's1', start, end)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].user, '今天的话')
  })

  test('系统注入的消息不算人说的话', () => {
    const log = [
      userLine(start + 1000, 'runtime context 一大段', 'system'),
      assistantLine(start + 2000, '收到'),
      userLine(start + 3000, '真的问题'),
      assistantLine(start + 4000, '真的回答'),
    ].join('\n')
    const turns = extractDayTurns(log, 's1', start, end)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].user, '真的问题')
  })

  test('工具调用不打断配对', () => {
    const log = [
      userLine(start + 1000, '跑一下测试'),
      line('tool/call', start + 1500, { name: 'bash' }),
      line('tool/result', start + 1800, { output: 'ok' }),
      assistantLine(start + 2000, '全部通过'),
    ].join('\n')
    const turns = extractDayTurns(log, 's1', start, end)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].assistant, '全部通过')
  })

  test('子代理标记（[dsh-xxx:…]）不算人说的话', () => {
    const log = [
      userLine(start + 500, '[dsh-mnemon:delegated review] Bounded complete'),
      assistantLine(start + 900, '收到'),
      userLine(start + 1000, '真正的问题'),
      assistantLine(start + 2000, '真正的回答'),
    ].join('\n')
    const turns = extractDayTurns(log, 's1', start, end)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].user, '真正的问题')
  })

  test('没有回复的用户消息不产出条目', () => {
    const log = [userLine(start + 1000, '只有我问，没人答')].join('\n')
    assert.equal(extractDayTurns(log, 's1', start, end).length, 0)
  })

  test('坏行跳过而不是整份失败', () => {
    const log = ['{这行不是 json', userLine(start + 1000, '问题'), assistantLine(start + 2000, '回答')].join('\n')
    assert.equal(extractDayTurns(log, 's1', start, end).length, 1)
  })
})

describe('buildJournalPrompt', () => {
  test('带日期、轮数、时间与双方发言', () => {
    const prompt = buildJournalPrompt(DAY, [
      { session: 's1', user: '用户的问题', assistant: '我的回答', at: start + 9 * 3600_000 },
    ])
    assert.ok(prompt.includes(`【日期】${DAY}`))
    assert.ok(prompt.includes('【对话轮数】1'))
    assert.ok(prompt.includes('【用户】用户的问题'))
    assert.ok(prompt.includes('【助手】我的回答'))
    assert.ok(/### \[0\] \d{2}:\d{2}/.test(prompt))
  })
})

describe('parseJournalOutput', () => {
  test('普通正文原样返回', () => {
    assert.equal(parseJournalOutput('  今天把备份链路修好了。  '), '今天把备份链路修好了。')
  })

  test('剥掉代码围栏', () => {
    assert.equal(parseJournalOutput('```markdown\n今天做了 A。\n```'), '今天做了 A。')
  })

  test('诊断信息当失败（不写垃圾）', () => {
    assert.equal(parseJournalOutput('[诊断] 拿不到 llm 服务'), null)
  })

  test('空输出返回 null', () => {
    assert.equal(parseJournalOutput('   \n  '), null)
  })

  test('超长截断而不是丢弃', () => {
    const long = '字'.repeat(JOURNAL_MAX_CHARS + 100)
    const out = parseJournalOutput(long)
    assert.ok(out !== null)
    assert.equal(out.length, JOURNAL_MAX_CHARS + 1)
    assert.ok(out.endsWith('…'))
  })
})

describe('journalMemoryId', () => {
  test('同一天固定同一个 id（重跑是覆盖不是新增）', () => {
    assert.equal(journalMemoryId(DAY), journalMemoryId(DAY))
    assert.equal(journalMemoryId(DAY), `journal-${DAY}`)
  })
})
