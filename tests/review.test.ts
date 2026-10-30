/**
 * 阶段 7.3：采纳闸门。
 *
 * 这里最要紧的是「不许悄悄放行」：类型不对、状态不对、找不到条目，
 * 都必须如实返回 changed=false 并说明原因，绝不能假装成功。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  APPROVED_STATUS,
  approveCandidate,
  listCandidates,
  REJECTED_STATUS,
  rejectCandidate,
  type ReviewDeps,
} from '../src/memory/review.ts'

const NOW = new Date('2026-10-30T12:00:00.000Z')

interface FakeDoc {
  memory_id: string
  content: string
  memory_type: string
  status: string
  evidence_ids?: string[]
  created_at?: string
}

function makeDeps(docs: Record<string, FakeDoc>, options: { auditFails?: boolean } = {}) {
  const updates: Array<{ id: string; doc: Record<string, unknown> }> = []
  const audits: Array<Record<string, unknown>> = []
  let searchBody: Record<string, unknown> | null = null

  const deps = {
    userId: 'u1',
    personalPrefix: 'personal_memory_',
    auditIndex: 'memory_audit',
    now: () => NOW,
    reader: {
      get: async (_i: string, id: string) => {
        const doc = docs[id]
        if (doc === undefined) throw { status: 404, kind: 'not_found' }
        return { id, source: { ...doc } }
      },
      search: async (_i: string, body: unknown) => {
        searchBody = body as Record<string, unknown>
        const hits = Object.values(docs)
          .filter((d) => d.status === 'pending' && d.memory_type === 'identity')
          .map((d) => ({ source: d }))
        return { hits }
      },
    },
    writer: {
      update: async (_i: string, id: string, doc: Record<string, unknown>) => {
        updates.push({ id, doc })
        return { id, result: 'updated', status: 200 }
      },
      index: async (_i: string, doc: Record<string, unknown>) => {
        if (options.auditFails === true) throw { status: 403, kind: 'security' }
        audits.push(doc)
        return { id: 'audit-1', result: 'created', status: 200 }
      },
    },
  } as unknown as ReviewDeps
  return { deps, updates, audits, getSearchBody: () => searchBody }
}

describe('listCandidates', () => {
  test('只列 pending 的 identity，带证据', async () => {
    const { deps, getSearchBody } = makeDeps({
      t1: { memory_id: 't1', content: '你偏好先给结论', memory_type: 'identity', status: 'pending', evidence_ids: ['a', 'b'] },
      t2: { memory_id: 't2', content: '已生效的自述', memory_type: 'identity', status: 'active' },
      f1: { memory_id: 'f1', content: '普通事实', memory_type: 'fact', status: 'active' },
    })
    const items = await listCandidates(deps)
    assert.equal(items.length, 1)
    assert.equal(items[0]?.memory_id, 't1')
    assert.deepEqual(items[0]?.evidence_ids, ['a', 'b'])
    const text = JSON.stringify(getSearchBody())
    assert.ok(text.includes('"pending"'), '过滤 pending')
    assert.ok(text.includes('"identity"'), '过滤 identity')
  })
})

describe('approveCandidate', () => {
  test('pending → active，并写审计', async () => {
    const { deps, updates, audits } = makeDeps({
      t1: { memory_id: 't1', content: '你偏好先给结论', memory_type: 'identity', status: 'pending' },
    })
    const out = await approveCandidate(deps, 't1', '看着像')
    assert.equal(out.changed, true)
    assert.equal(out.status, APPROVED_STATUS)
    assert.equal(out.audit, 'ok')
    assert.equal(updates[0]?.doc.status, 'active')
    assert.equal(audits[0]?.event, 'identity_approved')
    assert.equal(audits[0]?.from_state, 'pending')
    assert.equal(audits[0]?.to_state, 'active')
    assert.equal(audits[0]?.note, '看着像')
  })

  test('已经 active 的再采纳：changed=false，如实说明状态', async () => {
    const { deps, updates } = makeDeps({
      t1: { memory_id: 't1', content: 'x', memory_type: 'identity', status: 'active' },
    })
    const out = await approveCandidate(deps, 't1')
    assert.equal(out.changed, false)
    assert.equal(out.status, 'active')
    assert.match(out.note, /只有 pending/)
    assert.equal(updates.length, 0, '不该改状态')
  })

  test('普通记忆不能走采纳闸门', async () => {
    const { deps } = makeDeps({
      f1: { memory_id: 'f1', content: 'x', memory_type: 'fact', status: 'pending' },
    })
    const out = await approveCandidate(deps, 'f1')
    assert.equal(out.changed, false)
    assert.match(out.note, /不是 identity/)
  })

  test('找不到条目：不抛错，如实返回', async () => {
    const { deps } = makeDeps({})
    const out = await approveCandidate(deps, 'nope')
    assert.equal(out.changed, false)
    assert.equal(out.status, '')
    assert.match(out.note, /找不到/)
  })

  test('审计写失败不回滚主操作，且如实标记', async () => {
    const { deps, updates } = makeDeps(
      { t1: { memory_id: 't1', content: 'x', memory_type: 'identity', status: 'pending' } },
      { auditFails: true },
    )
    const out = await approveCandidate(deps, 't1')
    assert.equal(out.changed, true, '状态已改')
    assert.equal(out.audit, 'failed')
    assert.match(out.note, /审计索引写不进/)
    assert.equal(updates.length, 1)
    // 审核痕迹必须同时落在条目上（审计索引写不进去时的降级保障）
    assert.equal(typeof updates[0]?.doc.reviewed_at, 'string')
    assert.equal(updates[0]?.doc.reviewed_by, 'u1')
  })
})

describe('rejectCandidate', () => {
  test('pending → archived（内容保留，不删）', async () => {
    const { deps, updates, audits } = makeDeps({
      t1: { memory_id: 't1', content: '你很快乐', memory_type: 'identity', status: 'pending' },
    })
    const out = await rejectCandidate(deps, 't1', '太笼统')
    assert.equal(out.changed, true)
    assert.equal(out.status, REJECTED_STATUS)
    assert.equal(updates[0]?.doc.status, 'archived')
    assert.equal(audits[0]?.event, 'identity_rejected')
    assert.equal(audits[0]?.note, '太笼统')
  })

  test('拒绝已归档的再次拒绝：不重复改状态', async () => {
    const { deps, updates } = makeDeps({
      t1: { memory_id: 't1', content: 'x', memory_type: 'identity', status: 'archived' },
    })
    const out = await rejectCandidate(deps, 't1')
    assert.equal(out.changed, false)
    assert.equal(updates.length, 0)
  })
})
