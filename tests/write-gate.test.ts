/**
 * `governance.write` 写闸下沉（2026-11-10，用户拍板「全拦：代码向文档靠」）。
 *
 * 背景：配置文案一直承诺「导入 / 蒸馏回写 / pinned 都走同一道闸」，实际只有
 * `memory_save` 检查 —— `write=off`（停机维护）时新增记忆被拒，但后台仍在改写已有正文、
 * 仍能 pin 置顶。本文件把「每条链路都要被拦」钉死。
 *
 * 断言的两条性质：
 *  1. **拦得住**：write=off 下每条写链路都抛 / 发出 `write_gate`，且**一次 ES 请求都不发**
 *     （闸在最前面 —— 否则「只读」只是把结果盖住，读与网络代价照付）；
 *  2. **不误伤**：不传 writeMode（历史行为 / 单测里的老 deps）= `on`，照常放行。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import type { EsClient } from '../src/es/http.ts'
import { writeJournal } from '../src/journal.ts'
import type { MoodState } from '../src/mood.ts'
import { assertWriteAllowed } from '../src/memory/common.ts'
import { distillMemory } from '../src/memory/distill.ts'
import { runDistillJob, runDistillSweep } from '../src/memory/distillRunner.ts'
import { rollbackTo } from '../src/memory/history.ts'
import { writeMood } from '../src/memory/mood.ts'
import { promoteMemory } from '../src/memory/promote.ts'
import { approveCandidate } from '../src/memory/review.ts'
import { updateStatus } from '../src/memory/status.ts'
import { writeTraitCandidate } from '../src/memory/traits.ts'
import { sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const INDEX = 'personal_memory_xqh'
const NOW = new Date('2026-11-10T12:00:00.000Z')

interface Harness {
  fake: FakeEs
  base: {
    userId: string
    personalPrefix: string
    reader: EsClient
    writer: EsClient
  }
}

/**
 * 关键设计：假 ES 对**任何**请求都回 200 —— 所以「拦没拦住」不能靠它报错来判断，
 * 只能靠 `fake.requests.length === 0`。这正是本文件要钉的性质：闸必须在 ES 往返之前。
 */
async function gateHarness(): Promise<Harness> {
  const fake = await startFakeEs((_req, res) => {
    sendJson(res, 200, { found: false, result: 'updated', hits: { hits: [] } })
  })
  const reader = createEsClient({ url: fake.url, username: 'mem-reader', password: 'pw' })
  const writer = createEsClient({ url: fake.url, username: 'mem-writer', password: 'pw' })
  return { fake, base: { userId: 'xqh', personalPrefix: 'personal_memory_', reader, writer } }
}

/** 每条链路的最小 deps：只补该函数必填、且与写闸无关的字段 */
function offDeps(h: Harness, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...h.base, writeMode: 'off', ...extra }
}

const MOOD: MoodState = { valence: 0, arousal: 0, updatedAt: null, events: [] }

describe('assertWriteAllowed（写闸本体）', () => {
  test('on 与缺省都放行 —— 缺省是「不改变历史行为」的关键', () => {
    assert.doesNotThrow(() => assertWriteAllowed({}, 'x'))
    assert.doesNotThrow(() => assertWriteAllowed({ writeMode: 'on' }, 'x'))
  })

  test('readonly / off 都拦，错误里带模式与链路名', () => {
    for (const mode of ['readonly', 'off'] as const) {
      assert.throws(
        () => assertWriteAllowed({ writeMode: mode }, '测试链路'),
        (err: Error) => {
          assert.match(err.message, /写入已关闭/)
          assert.match(err.message, new RegExp(`governance\\.write=${mode}`))
          assert.match(err.message, /测试链路/)
          return true
        },
      )
    }
  })
})

describe('写闸覆盖的链路（write=off 一律拦，且零 ES 请求）', () => {
  test('memory_update_status：pin 这条「最像后门」的路被堵上', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(
        () => updateStatus(offDeps(h) as never, { action: 'pin', memory_id: 'a' } as never),
        /governance\.write=off/,
      )
      assert.equal(h.fake.requests.length, 0, '闸必须在 loadOwnedDoc 之前：一次 GET 都不该发')
    } finally {
      await h.fake.close()
    }
  })

  test('蒸馏正文回写：distillMemory 直接拒', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(
        () => distillMemory(offDeps(h) as never, { memory_id: 'a', content: '改写后的正文' } as never),
        /governance\.write=off/,
      )
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('清扫整轮跳过：不发查询、返回全 0、日志带 write_gate', async () => {
    const h = await gateHarness()
    const events: Array<Record<string, unknown>> = []
    try {
      const result = await runDistillSweep(offDeps(h, { timeoutMs: 1000, log: (e: Record<string, unknown>) => events.push(e) }) as never, {})
      assert.deepEqual(
        { scanned: result.scanned, distilled: result.distilled, markedDone: result.markedDone, markedSkipped: result.markedSkipped },
        { scanned: 0, distilled: 0, markedDone: 0, markedSkipped: 0 },
        '整轮跳过：pending 原样保留，一个状态都不改',
      )
      assert.equal(h.fake.requests.length, 0, '连 pending 查询都不该发（省 query + 每条的 LLM 调用）')
      assert.ok(events.some((e) => e.skipped === 'write_gate'), `日志要记 write_gate，实际 ${JSON.stringify(events)}`)
    } finally {
      await h.fake.close()
    }
  })

  test('单条蒸馏任务：在烧模型之前返回 write_gate（不是 no_llm_service）', async () => {
    const h = await gateHarness()
    try {
      // 故意不给 llm —— 若闸在 llm 检查之后，这里会返回 no_llm_service，分类就错了
      const r = await runDistillJob(offDeps(h, { timeoutMs: 1000 }) as never, {
        memoryId: 'a',
        content: '正文',
        domain: 'test',
      })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'write_gate')
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('memory_promote：标 candidate 也被拦', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(() => promoteMemory(offDeps(h) as never, { memory_id: 'a' }), /governance\.write=off/)
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('自述候选（LLM 直写）被拦', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(
        () => writeTraitCandidate(offDeps(h) as never, { content: '你倾向于先给结论', evidence_ids: ['a'] }, 7),
        /governance\.write=off/,
      )
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('日记写入被拦', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(() => writeJournal(offDeps(h) as never, '2026-11-10', '今天的回顾'), /governance\.write=off/)
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('情绪写回被拦', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(() => writeMood(offDeps(h) as never, MOOD), /governance\.write=off/)
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('审核采纳（transition 覆盖 approve/reject）被拦', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(
        () => approveCandidate(offDeps(h, { auditIndex: 'memory_audit', auditPrefix: 'personal_audit_' }) as never, 'a'),
        /governance\.write=off/,
      )
      assert.equal(h.fake.requests.length, 0, '连读都不该做')
    } finally {
      await h.fake.close()
    }
  })

  test('history 回滚被拦', async () => {
    const h = await gateHarness()
    try {
      await assert.rejects(() => rollbackTo(offDeps(h) as never, 'a'), /governance\.write=off/)
      assert.equal(h.fake.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })
})

describe('不误伤：缺省 writeMode = on', () => {
  test('老 deps（不传 writeMode）照常放行，走到 ES 才失败', async () => {
    const h = await gateHarness()
    try {
      // 假 ES 的响应形状会让 loadOwnedDoc 走到归属校验才失败——具体报什么不重要，
      // 重要的是**没被写闸拦**、且请求真的发出去了。
      await assert.rejects(
        () => updateStatus(h.base as never, { action: 'pin', memory_id: 'a' } as never),
        (err: Error) => {
          assert.doesNotMatch(err.message, /governance\.write/, '缺省不该触发写闸')
          assert.match(err.message, /身份校验失败|找不到记忆/, '应已越过写闸、进入正常读取逻辑')
          return true
        },
      )
      assert.ok(h.fake.requests.length > 0, '放行的判据就是真的发出了请求')
    } finally {
      await h.fake.close()
    }
  })
})
