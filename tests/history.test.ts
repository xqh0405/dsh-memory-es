/**
 * 阶段 7.4：版本链与回滚。
 *
 * 重点钉住两件事：链能双向走通；回滚只动该动的两条，且**不删任何东西**。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { collectChain, rollbackTo, type HistoryDeps } from '../src/memory/history.ts'

const NOW = new Date('2026-10-30T12:00:00.000Z')

type Doc = Record<string, unknown>

function makeDeps(docs: Record<string, Doc>) {
  const updates: Array<{ id: string; doc: Doc }> = []
  const deps = {
    userId: 'u1',
    personalPrefix: 'personal_memory_',
    now: () => NOW,
    reader: {
      get: async (_i: string, id: string) => {
        const doc = docs[id]
        if (doc === undefined) throw { status: 404 }
        return { id, source: doc }
      },
      search: async () => ({ hits: [] }),
    },
    writer: {
      update: async (_i: string, id: string, doc: Doc) => {
        updates.push({ id, doc })
        return { id, result: 'updated', status: 200 }
      },
    },
  } as unknown as HistoryDeps
  return { deps, updates }
}

describe('collectChain', () => {
  test('从中间开始，前后都走通，offset 正确', async () => {
    const { deps } = makeDeps({
      v1: { memory_id: 'v1', content: '第一版', status: 'superseded', superseded_by: 'v2' },
      v2: { memory_id: 'v2', content: '第二版', status: 'superseded', supersedes: 'v1', superseded_by: 'v3' },
      v3: { memory_id: 'v3', content: '第三版', status: 'active', supersedes: 'v2' },
    })
    const chain = await collectChain(deps, 'v2')
    assert.deepEqual(chain.map((v) => v.memory_id), ['v1', 'v2', 'v3'])
    assert.deepEqual(chain.map((v) => v.offset), [-1, 0, 1])
    assert.equal(chain[2]?.status, 'active')
  })

  test('没有历史时只有一条', async () => {
    const { deps } = makeDeps({
      only: { memory_id: 'only', content: '唯一一版', status: 'active' },
    })
    const chain = await collectChain(deps, 'only')
    assert.equal(chain.length, 1)
    assert.equal(chain[0]?.offset, 0)
  })

  test('找不到返回空数组（不抛错）', async () => {
    const { deps } = makeDeps({})
    assert.deepEqual(await collectChain(deps, 'nope'), [])
  })

  test('脏数据成环时被 hop 上限与 seen 挡住', async () => {
    const { deps } = makeDeps({
      a: { memory_id: 'a', content: 'a', status: 'superseded', superseded_by: 'b' },
      b: { memory_id: 'b', content: 'b', status: 'superseded', supersedes: 'a', superseded_by: 'a' },
    })
    const chain = await collectChain(deps, 'a')
    assert.ok(chain.length <= 3, '不会无限走')
  })
})

describe('rollbackTo', () => {
  test('恢复旧版、把后继置 archived，先撤后继再恢复', async () => {
    const { deps, updates } = makeDeps({
      v1: { memory_id: 'v1', content: '第一版', status: 'superseded', superseded_by: 'v2' },
      v2: { memory_id: 'v2', content: '第二版', status: 'active', supersedes: 'v1' },
    })
    const out = await rollbackTo(deps, 'v1')
    assert.equal(out.changed, true)
    assert.equal(out.restored, 'v1')
    assert.equal(out.retired, 'v2')
    assert.equal(updates.length, 2)
    assert.equal(updates[0]?.id, 'v2', '先撤后继')
    assert.equal(updates[0]?.doc.status, 'archived')
    assert.equal(updates[1]?.id, 'v1', '再恢复旧版')
    assert.equal(updates[1]?.doc.status, 'active')
    assert.equal(updates[1]?.doc.superseded_by, null, '恢复时要清掉指向新版的指针')
  })

  test('active 的条目不能"回滚"（它已经是生效版本）', async () => {
    const { deps, updates } = makeDeps({
      v1: { memory_id: 'v1', content: 'x', status: 'active' },
    })
    const out = await rollbackTo(deps, 'v1')
    assert.equal(out.changed, false)
    assert.match(out.note, /只有 superseded/)
    assert.equal(updates.length, 0)
  })

  test('找不到条目如实返回', async () => {
    const { deps } = makeDeps({})
    const out = await rollbackTo(deps, 'nope')
    assert.equal(out.changed, false)
    assert.match(out.note, /找不到/)
  })

  test('没有后继时只恢复自己', async () => {
    const { deps, updates } = makeDeps({
      v1: { memory_id: 'v1', content: 'x', status: 'superseded' },
    })
    const out = await rollbackTo(deps, 'v1')
    assert.equal(out.changed, true)
    assert.equal(updates.length, 1)
    assert.equal(out.retired, '')
    assert.match(out.note, /没有后继/)
  })

  test('回滚**不删除**任何内容：只改状态字段', async () => {
    const { deps, updates } = makeDeps({
      v1: { memory_id: 'v1', content: '第一版正文', status: 'superseded', superseded_by: 'v2' },
      v2: { memory_id: 'v2', content: '第二版正文', status: 'active', supersedes: 'v1' },
    })
    await rollbackTo(deps, 'v1')
    for (const u of updates) {
      assert.equal('content' in u.doc, false, '不应该改写正文')
      assert.equal(typeof u.doc.status, 'string')
    }
  })
})
