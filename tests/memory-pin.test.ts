/**
 * 阶段 33：pinned 的写入路径（`memory_save{pinned}` 与 `memory_update_status{pin|unpin}`）。
 *
 * 守四件事：
 *  1. 写入时显式落 `pinned: false`（不是省略）——否则「没置顶」与「老文档缺字段」在统计口径上混在一起；
 *  2. **去重分支不能吞掉 pinned**：库里已有同内容但未置顶时，补一次只改 pinned 的写；
 *  3. pin/unpin 只改 pinned 一位，不动 status（置顶与可见性是两条正交的轴）；
 *  4. pin 一条非 active 的记忆要**如实说它不会注入**，不能给「已生效」的错觉。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildMemoryDoc, saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { defineStatusTool, updateStatus, type UpdateStatusDeps } from '../src/memory/status.ts'
import { createEsClient } from '../src/es/http.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const NOW = new Date('2026-11-09T10:00:00.000Z')
const INDEX = 'personal_memory_xqh'
const VECTOR = new Array(1024).fill(0.01)

interface Captured {
  writes: Array<{ path: string; body: Record<string, unknown> }>
}

async function startFake(
  docs: Record<string, Record<string, unknown>> = {},
  opts: { duplicate?: string | null } = {},
) {
  const captured: Captured = { writes: [] }
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('/_search')) {
      const dupId = opts.duplicate ?? null
      sendJson(res, 200, {
        took: 1,
        hits: {
          total: { value: dupId ? 1 : 0, relation: 'eq' },
          hits: dupId ? [{ _id: dupId, _score: 1, _source: { memory_id: dupId, pinned: false } }] : [],
        },
      })
      return
    }
    const getMatch = /^\/[^/]+\/_doc\/([^/?]+)/.exec(req.path)
    const updateMatch = /^\/[^/]+\/_update\/([^/?]+)/.exec(req.path)
    if (getMatch && req.method === 'GET') {
      const id = decodeURIComponent(getMatch[1])
      const source = docs[id]
      if (!source) {
        sendJson(res, 404, { _index: INDEX, _id: id, found: false })
        return
      }
      sendJson(res, 200, { _index: INDEX, _id: id, found: true, _source: source })
      return
    }
    const body = req.body.trim() === '' ? {} : (JSON.parse(req.body) as Record<string, unknown>)
    captured.writes.push({ path: req.path, body })
    if (updateMatch) {
      const id = decodeURIComponent(updateMatch[1])
      const patch = (body.doc ?? body) as Record<string, unknown>
      Object.assign(docs[id] ?? (docs[id] = {}), patch)
      sendJson(res, 200, { _index: INDEX, _id: id, result: 'updated' })
      return
    }
    const id = (body.memory_id as string) ?? 'generated'
    docs[id] = body
    sendJson(res, 201, { _index: INDEX, _id: id, result: 'created' })
  })
  return { fake, captured, docs }
}

function saveDeps(fakeUrl: string, overrides: Partial<SaveDeps> = {}): SaveDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    defaultDomain: 'general',
    reader: createEsClient({ url: fakeUrl, username: 'r', password: 'p' }),
    writer: createEsClient({ url: fakeUrl, username: 'w', password: 'p' }),
    embed: { embed: async () => VECTOR },
    now: () => NOW,
    ...overrides,
  }
}

function statusDeps(fakeUrl: string): UpdateStatusDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    reader: createEsClient({ url: fakeUrl, username: 'r', password: 'p' }),
    writer: createEsClient({ url: fakeUrl, username: 'w', password: 'p' }),
    now: () => NOW,
  }
}

describe('memory_save 的 pinned 参数', () => {
  test('pinned=true 写进文档', async () => {
    const { fake, docs } = await startFake()
    try {
      const result = await saveMemory(saveDeps(fake.url), { content: '回复先给结论再给理由', pinned: true })
      assert.equal(result.status, 'created')
      const doc = Object.values(docs)[0]
      assert.equal(doc.pinned, true)
    } finally {
      await fake.close()
    }
  })

  test('不给 pinned 时显式写 false（不是省略）', async () => {
    const { fake, docs } = await startFake()
    try {
      await saveMemory(saveDeps(fake.url), { content: '一条普通事实' })
      const doc = Object.values(docs)[0]
      assert.equal(doc.pinned, false, '缺失与 false 在统计口径上不等价，必须显式写')
    } finally {
      await fake.close()
    }
  })

  test('去重时 pinned=true 仍会升级已有条目（不能静默吞掉）', async () => {
    const { fake, captured, docs } = await startFake({ existing1: { memory_id: 'existing1', pinned: false } }, { duplicate: 'existing1' })
    try {
      const result = await saveMemory(saveDeps(fake.url), { content: '回复先给结论', pinned: true })
      assert.equal(result.status, 'merged')
      assert.match(result.text, /置为常驻/)
      const update = captured.writes.find((w) => w.path.includes('/_update/'))
      assert.ok(update, '必须补一次 update')
      assert.equal((update.body.doc as Record<string, unknown>).pinned, true)
      assert.equal(docs.existing1.pinned, true)
    } finally {
      await fake.close()
    }
  })

  test('去重且没要求置顶时，不写任何东西', async () => {
    const { fake, captured } = await startFake({ existing1: { memory_id: 'existing1', pinned: false } }, { duplicate: 'existing1' })
    try {
      const result = await saveMemory(saveDeps(fake.url), { content: '重复内容' })
      assert.equal(result.status, 'merged')
      assert.equal(captured.writes.length, 0, '没置顶诉求就不该有写操作')
    } finally {
      await fake.close()
    }
  })
})

describe('buildMemoryDoc 的 pinned 字段', () => {
  test('缺省 false、true 时 true（纯函数层）', () => {
    const deps = { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'general' } as never
    const base = { content: '甲', memoryId: 'm1', embedding: null, now: NOW }
    const a = buildMemoryDoc({ content: '甲' }, deps, base as never)
    const b = buildMemoryDoc({ content: '甲', pinned: true }, deps, base as never)
    assert.equal(a.doc.pinned, false)
    assert.equal(b.doc.pinned, true)
  })
})

describe('memory_update_status 的 pin / unpin', () => {
  test('pin 只改 pinned，不动 status', async () => {
    const { fake, docs } = await startFake({ m1: { memory_id: 'm1', user_id: 'xqh', status: 'active', pinned: false } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm1', action: 'pin' })
      assert.equal(result.status, 'active', 'status 不该被 pin 改动')
      assert.equal(docs.m1.pinned, true)
      assert.match(result.text, /每轮注入/)
    } finally {
      await fake.close()
    }
  })

  test('unpin 取消常驻，但仍可被检索命中', async () => {
    const { fake, docs } = await startFake({ m1: { memory_id: 'm1', user_id: 'xqh', status: 'active', pinned: true } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm1', action: 'unpin' })
      assert.equal(docs.m1.pinned, false)
      assert.match(result.text, /不再每轮注入/)
    } finally {
      await fake.close()
    }
  })

  test('pin 一条 archived 的记忆：如实说它不会注入（不给「已生效」的错觉）', async () => {
    const { fake } = await startFake({ m2: { memory_id: 'm2', user_id: 'xqh', status: 'archived', pinned: false } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm2', action: 'pin' })
      assert.equal(result.status, 'archived')
      assert.match(result.text, /不会注入/)
      assert.match(result.text, /restore/)
    } finally {
      await fake.close()
    }
  })

  test('工具描述里写清 pin 的语义（模型靠描述选工具）', () => {
    const tool = defineStatusTool(statusDeps('http://127.0.0.1:1')) as unknown as {
      description: string
      parameters: { properties: Record<string, { enum?: string[]; description?: string }> }
    }
    assert.match(tool.description, /pin/)
    assert.match(tool.description, /常驻/)
    const action = tool.parameters.properties.action
    assert.equal(action.enum?.includes('pin'), true)
    assert.equal(action.enum?.includes('unpin'), true)
    assert.match(String(action.description), /常驻/)
  })
})
