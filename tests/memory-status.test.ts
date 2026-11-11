/**
 * `memory_update_status` / `memory_promote` 单测：假 ES + 真 `createEsClient`。
 *
 * 重点守四条：
 *  · supersede 是**双写**（旧文档下架 + 新文档回填 supersedes），且**先下架后回填**；
 *  · 任何写之前必须先确认两条文档都存在（不留指向空气的链）；
 *  · 归属不符（F3）与 404 都要在**写之前**拦掉；
 *  · promote 只置 candidate，绝不碰团队库；reason 只进日志、不进文档。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { createEsClient } from '../src/es/http.ts'
import { definePromoteTool, promoteMemory } from '../src/memory/promote.ts'
import { defineStatusTool, updateStatus } from '../src/memory/status.ts'
import { sendEsError, sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const INDEX = 'personal_memory_xqh'

/** 文档库：id → source。get 命中它，update 把补丁合进去（顺带记录 patch 顺序）。 */
interface State {
  docs: Record<string, Record<string, unknown>>
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  /** 让 ES 对 update 返回 noop（值本来就一样） */
  noop: boolean
}

async function startStateFake(initial: Record<string, Record<string, unknown>>, options: { noop?: boolean } = {}) {
  const state: State = { docs: { ...initial }, updates: [], noop: options.noop ?? false }
  const fake = await startFakeEs((req, res) => {
    const docGet = /^\/[^/]+\/_doc\/([^/?]+)/.exec(req.path)
    const docUpdate = /^\/[^/]+\/_update\/([^/?]+)/.exec(req.path)
    if (docGet) {
      const id = decodeURIComponent(docGet[1])
      const source = state.docs[id]
      if (!source) {
        sendJson(res, 404, { _index: INDEX, _id: id, found: false })
        return
      }
      sendJson(res, 200, { _index: INDEX, _id: id, found: true, _source: source })
      return
    }
    if (docUpdate) {
      const id = decodeURIComponent(docUpdate[1])
      const patch = (JSON.parse(req.body) as { doc: Record<string, unknown> }).doc
      state.updates.push({ id, patch })
      const current = state.docs[id]
      if (!current) {
        sendEsError(res, 404, 'document_missing_exception', `[${id}]: document missing`)
        return
      }
      if (state.noop) {
        sendJson(res, 200, { _id: id, result: 'noop' })
        return
      }
      state.docs[id] = { ...current, ...patch }
      sendJson(res, 200, { _id: id, result: 'updated' })
      return
    }
    sendJson(res, 404, { error: 'unknown path' })
  })
  const reader = createEsClient({ url: fake.url, username: 'mem-reader-xqh', password: 'pw-reader' })
  const writer = createEsClient({ url: fake.url, username: 'mem-writer', password: 'pw-writer' })
  return {
    fake,
    state,
    deps: {
      userId: 'xqh',
      personalPrefix: 'personal_memory_',
      reader,
      writer,
      now: () => NOW,
    },
  }
}

function doc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_id: id,
    user_id: 'xqh',
    content: `内容-${id}`,
    memory_type: 'fact',
    domain: 'lottery-cloud',
    privacy: 'normal',
    promote_state: 'none',
    status: 'active',
    content_sha256: `hash-${id}`,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}

describe('updateStatus', () => {
  test('supersede：先下架旧文档，再给新文档回填 supersedes', async () => {
    const h = await startStateFake({ old: doc('old'), fresh: doc('fresh') })
    try {
      const result = await updateStatus(h.deps, {
        memory_id: 'old',
        action: 'supersede',
        replacement_memory_id: 'fresh',
        reason: '口径更新',
      })
      assert.equal(result.status, 'superseded')
      assert.equal(result.superseded_by, 'fresh')
      assert.equal(result.changed, true)
      assert.match(result.text, /替代版本 fresh/)

      assert.deepEqual(h.state.updates.map((item) => item.id), ['old', 'fresh'], '先旧后新')
      assert.deepEqual(h.state.updates[0].patch, {
        status: 'superseded',
        superseded_by: 'fresh',
        // 阶段 13：失效原因留痕
        forget_reason: '口径更新',
        updated_at: NOW.toISOString(),
      })
      assert.deepEqual(h.state.updates[1].patch, {
        supersedes: 'old',
        updated_at: NOW.toISOString(),
      })
    } finally {
      await h.fake.close()
    }
  })

  test('supersede 缺 replacement → 抛错且零写入', async () => {
    const h = await startStateFake({ old: doc('old') })
    try {
      await assert.rejects(
        updateStatus(h.deps, { memory_id: 'old', action: 'supersede' }),
        /replacement_memory_id/,
      )
      assert.equal(h.state.updates.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('supersede 指向不存在的替代版本 → 抛错且零写入（不留指向空气的链）', async () => {
    const h = await startStateFake({ old: doc('old') })
    try {
      await assert.rejects(
        updateStatus(h.deps, { memory_id: 'old', action: 'supersede', replacement_memory_id: 'ghost' }),
        /找不到记忆 ghost/,
      )
      assert.equal(h.state.updates.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('替代版本是自己 → 抛错', async () => {
    const h = await startStateFake({ old: doc('old') })
    try {
      await assert.rejects(
        updateStatus(h.deps, { memory_id: 'old', action: 'supersede', replacement_memory_id: 'old' }),
        /不能是自己/,
      )
    } finally {
      await h.fake.close()
    }
  })

  test('expire：改 status + updated_at，并记下原因（阶段 13）', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'expire', reason: '过时了' })
      assert.equal(result.status, 'expired')
      assert.equal(result.superseded_by, '')
      assert.deepEqual(h.state.updates[0].patch, {
        status: 'expired',
        forget_reason: '过时了',
        updated_at: NOW.toISOString(),
      })
    } finally {
      await h.fake.close()
    }
  })

  test('archive：置 status=archived（移出检索，但不删除）', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'archive', reason: '不再需要' })
      assert.equal(result.status, 'archived')
      assert.match(result.text, /仍可按 id 查回/)
      assert.deepEqual(h.state.updates[0].patch, { status: 'archived', updated_at: NOW.toISOString() })
    } finally {
      await h.fake.close()
    }
  })

  test('restore：恢复为 active，并清掉 superseded_by（否则检索还是挡住它）', async () => {
    const h = await startStateFake({ a: doc('a', { status: 'superseded', superseded_by: 'newer' }) })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(result.status, 'active')
      assert.equal(result.superseded_by, '')
      assert.deepEqual(h.state.updates[0].patch, {
        status: 'active',
        superseded_by: null,
        quarantine_reason: null,
        // 阶段 13：恢复时一并清失效原因
        forget_reason: null,
        updated_at: NOW.toISOString(),
      })
    } finally {
      await h.fake.close()
    }
  })

  test('restore 一条被隔离的记忆：原因必须一起清掉（否则面板还显示「隔离原因」）', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'quarantine', quarantine_reason: '疑似凭据（命中赋值式口令），已隔离待审' }),
    })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(result.status, 'active')
      // 只改 status 不改原因 → 「已恢复但还挂着隔离理由」，审的人分不清是否恢复干净
      assert.equal(h.state.updates[0].patch.quarantine_reason, null)
    } finally {
      await h.fake.close()
    }
  })

  // 2026-11-10 审查 #16：隔离/归档期间 distill_state 被标 `skipped`，
  // 恢复后不重置的话，清扫只查 `distill_state=pending` → 这条**永远不再蒸馏、也永远补不回向量**。
  test('restore 一条 distill_state=skipped 的 → 重置回 pending，并在回执里说清', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'quarantine', distill_state: 'skipped', quarantine_reason: '命中赋值式凭证' }),
    })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(h.state.updates[0].patch.distill_state, 'pending', '必须重新排队，否则永不蒸馏')
      assert.match(result.text, /重新排队蒸馏/, '回执要说清它会回到蒸馏队列')
      assert.equal(result.status, 'active')
    } finally {
      await h.fake.close()
    }
  })

  test('restore 一条 distill_state=done 的 → 不重置（已蒸馏过，别白烧一轮模型）', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'archived', distill_state: 'done' }),
    })
    try {
      await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(
        'distill_state' in h.state.updates[0].patch,
        false,
        `不该动已蒸馏的条目，实际 patch=${JSON.stringify(h.state.updates[0].patch)}`,
      )
    } finally {
      await h.fake.close()
    }
  })

  // 线上实测：active + distill_state=skipped 的 93 条里 91 条是 `origin=import`
  // （阶段 33 热记忆下沉，向量已补齐、本就是人工收紧的短规则）。
  // 它们的 skipped 是**有意**的，归档后再恢复不能被重新扔进蒸馏队列让 LLM 改写。
  test('restore 一条 origin=import 且 skipped（归档来的）→ 不重置', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'archived', distill_state: 'skipped', origin: 'import' }),
    })
    try {
      await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(
        'distill_state' in h.state.updates[0].patch,
        false,
        `下沉那批的 skipped 是有意的，实际 patch=${JSON.stringify(h.state.updates[0].patch)}`,
      )
    } finally {
      await h.fake.close()
    }
  })

  // 但同样是 origin=import，只要它当前是 quarantine，说明 skipped 是「隔离时跑不了」写的
  // （不是脚本下沉时写的）→ 必须重排，否则恢复后照旧永不蒸馏。
  test('restore 一条 origin=import 但 status=quarantine → 仍要重置', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'quarantine', distill_state: 'skipped', origin: 'import', quarantine_reason: '命中赋值式凭证' }),
    })
    try {
      await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(h.state.updates[0].patch.distill_state, 'pending', '隔离来的必须重排')
    } finally {
      await h.fake.close()
    }
  })

  // `summary` 是蒸馏的产物：有它说明已经蒸馏过，skipped 只是后来归档时被打上的标记，
  // 重置等于拿 LLM 再改写一遍（线上 541e94f3 就是这种：有 summary、origin=agent、active+skipped）。
  test('restore 一条 skipped 但已有 summary（蒸馏过了）→ 不重置', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'archived', distill_state: 'skipped', origin: 'agent', summary: '已经蒸馏过的摘要' }),
    })
    try {
      await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(
        'distill_state' in h.state.updates[0].patch,
        false,
        `已蒸馏过的不该重排，实际 patch=${JSON.stringify(h.state.updates[0].patch)}`,
      )
    } finally {
      await h.fake.close()
    }
  })

  // 反过来：归档前还是 pending（从没蒸馏过、也没有 summary）→ 恢复后必须回到队列
  test('restore 一条从没蒸馏过、归档来的 skipped → 重置回 pending', async () => {
    const h = await startStateFake({
      a: doc('a', { status: 'archived', distill_state: 'skipped', origin: 'agent' }),
    })
    try {
      await updateStatus(h.deps, { memory_id: 'a', action: 'restore' })
      assert.equal(h.state.updates[0].patch.distill_state, 'pending', '没蒸馏过的归档条目要回到队列')
    } finally {
      await h.fake.close()
    }
  })

  test('mark_private：只改 privacy，状态保持不变', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'mark_private' })
      assert.equal(result.privacy, 'private')
      assert.equal(result.status, 'active', 'mark_private 不动状态')
      assert.deepEqual(h.state.updates[0].patch, { privacy: 'private', updated_at: NOW.toISOString() })
    } finally {
      await h.fake.close()
    }
  })

  test('找不到记忆 → 说人话（不把 ES 的 404 原文丢给模型）', async () => {
    const h = await startStateFake({})
    try {
      await assert.rejects(updateStatus(h.deps, { memory_id: 'nope', action: 'expire' }), /找不到记忆 nope/)
      assert.equal(h.state.updates.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('归属不符（F3）→ 拒绝且零写入', async () => {
    const h = await startStateFake({ a: doc('a', { user_id: 'someone-else' }) })
    try {
      await assert.rejects(updateStatus(h.deps, { memory_id: 'a', action: 'expire' }), /身份校验失败/)
      assert.equal(h.state.updates.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('未知 action → 抛错', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      await assert.rejects(
        updateStatus(h.deps, { memory_id: 'a', action: 'delete' as never }),
        /未知 action/,
      )
    } finally {
      await h.fake.close()
    }
  })

  test('ES 返回 noop → changed=false（字段本来就是目标值）', async () => {
    const h = await startStateFake({ a: doc('a') }, { noop: true })
    try {
      const result = await updateStatus(h.deps, { memory_id: 'a', action: 'expire' })
      assert.equal(result.changed, false)
    } finally {
      await h.fake.close()
    }
  })

  test('日志带 memory_id 与 action，但不带正文', async () => {
    const h = await startStateFake({ a: doc('a', { content: '不该进日志的正文-qqq' }) })
    const events: Record<string, unknown>[] = []
    try {
      await updateStatus({ ...h.deps, log: (event) => events.push(event) }, {
        memory_id: 'a',
        action: 'expire',
        reason: '过时',
      })
      const serialized = JSON.stringify(events)
      assert.equal(serialized.includes('不该进日志的正文'), false)
      assert.ok(serialized.includes('"memory_id":"a"'))
      assert.ok(serialized.includes('"action":"expire"'))
    } finally {
      await h.fake.close()
    }
  })

  test('工具定义：参数/输出 schema 合法，execute 可用', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      const def = defineStatusTool(h.deps as never)
      const parameters = def.parameters as { properties: Record<string, unknown> }
      assert.deepEqual(Object.keys(parameters.properties).sort(), [
        'action',
        'memory_id',
        'reason',
        'replacement_memory_id',
      ])
      assert.equal(JSON.stringify(def.parameters).includes('user_id'), false)
      const value = (await def.execute({ memory_id: 'a', action: 'expire' }, {
        signal: new AbortController().signal,
      } as never)) as Record<string, unknown>
      assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
    } finally {
      await h.fake.close()
    }
  })
})

describe('promoteMemory', () => {
  test('只置 promote_state=candidate，不碰团队库', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      const result = await promoteMemory(h.deps, { memory_id: 'a', reason: '团队也用得上' })
      assert.equal(result.promote_state, 'candidate')
      assert.equal(result.changed, true)
      assert.deepEqual(h.state.updates, [
        { id: 'a', patch: { promote_state: 'candidate', updated_at: NOW.toISOString() } },
      ])
      // 只打了个人库，团队索引一次都没碰
      assert.equal(h.fake.requests.every((req) => !req.path.includes('team_knowledge')), true)
    } finally {
      await h.fake.close()
    }
  })

  test('reason 只进日志，不进文档（mapping 没这个字段）', async () => {
    const h = await startStateFake({ a: doc('a') })
    const events: Record<string, unknown>[] = []
    try {
      await promoteMemory({ ...h.deps, log: (event) => events.push(event) }, {
        memory_id: 'a',
        reason: '接口契约值得共享',
      })
      assert.equal(JSON.stringify(h.state.updates).includes('接口契约值得共享'), false)
      assert.equal(JSON.stringify(events).includes('接口契约值得共享'), true)
    } finally {
      await h.fake.close()
    }
  })

  test('已经是 promoted → 跳过，不再写', async () => {
    const h = await startStateFake({ a: doc('a', { promote_state: 'promoted' }) })
    try {
      const result = await promoteMemory(h.deps, { memory_id: 'a' })
      assert.equal(result.promote_state, 'promoted')
      assert.equal(result.changed, false)
      assert.match(result.text, /已经晋升过/)
      assert.equal(h.state.updates.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('找不到 / 归属不符 → 抛错且零写入', async () => {
    const missing = await startStateFake({})
    try {
      await assert.rejects(promoteMemory(missing.deps, { memory_id: 'nope' }), /找不到记忆 nope/)
      assert.equal(missing.state.updates.length, 0)
    } finally {
      await missing.fake.close()
    }
    const foreign = await startStateFake({ a: doc('a', { user_id: 'someone-else' }) })
    try {
      await assert.rejects(promoteMemory(foreign.deps, { memory_id: 'a' }), /身份校验失败/)
      assert.equal(foreign.state.updates.length, 0)
    } finally {
      await foreign.fake.close()
    }
  })

  test('工具定义：schema 合法，execute 返回声明结构', async () => {
    const h = await startStateFake({ a: doc('a') })
    try {
      const def = definePromoteTool(h.deps as never)
      const parameters = def.parameters as { properties: Record<string, unknown> }
      assert.deepEqual(Object.keys(parameters.properties).sort(), ['memory_id', 'reason'])
      const value = (await def.execute({ memory_id: 'a' }, {
        signal: new AbortController().signal,
      } as never)) as Record<string, unknown>
      assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
      assert.equal(value.promote_state, 'candidate')
    } finally {
      await h.fake.close()
    }
  })
})

describe('阶段 13：forget_reason 失效原因留痕', () => {
  test('expire 带 reason → 原样落库；不带 → 用动作名兜底', async () => {
    const h = await startStateFake({ a: doc('a'), b: doc('b') })
    try {
      await updateStatus(h.deps, { memory_id: 'a', action: 'expire', reason: '  已被新方案取代  ' })
      await updateStatus(h.deps, { memory_id: 'b', action: 'expire' })
      assert.equal(h.state.updates[0]?.patch.forget_reason, '已被新方案取代', '两端空白要裁掉')
      assert.equal(h.state.updates[1]?.patch.forget_reason, 'expired', '没给原因时用动作名，保证字段总有值')
    } finally {
      await h.fake.close()
    }
  })

  test('supersede 不带 reason → 写 superseded（不是空串）', async () => {
    const h = await startStateFake({ old: doc('old'), fresh: doc('fresh') })
    try {
      await updateStatus(h.deps, { memory_id: 'old', action: 'supersede', replacement_memory_id: 'fresh' })
      assert.equal(h.state.updates[0]?.patch.forget_reason, 'superseded')
    } finally {
      await h.fake.close()
    }
  })

  test('restore 清掉 forget_reason（否则会挂着失效理由却已生效）', async () => {
    const h = await startStateFake({ gone: { ...doc('gone'), status: 'expired', forget_reason: '过期了' } })
    try {
      await updateStatus(h.deps, { memory_id: 'gone', action: 'restore' })
      assert.equal(h.state.updates[0]?.patch.forget_reason, null)
      assert.equal(h.state.updates[0]?.patch.status, 'active')
    } finally {
      await h.fake.close()
    }
  })
})
