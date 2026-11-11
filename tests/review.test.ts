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
  defineReviewTool,
  listCandidates,
  REJECTED_STATUS,
  rejectCandidate,
  setAnchor,
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

function makeDeps(
  docs: Record<string, FakeDoc>,
  options: { sharedAuditFails?: boolean; personalAuditFails?: boolean } = {},
) {
  const updates: Array<{ id: string; doc: Record<string, unknown> }> = []
  const audits: Array<{ index: string; doc: Record<string, unknown> }> = []
  let searchBody: Record<string, unknown> | null = null

  const deps = {
    userId: 'u1',
    personalPrefix: 'personal_memory_',
    auditIndex: 'memory_audit',
    auditPrefix: 'personal_audit_',
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
      index: async (indexName: string, doc: Record<string, unknown>) => {
        const isPersonal = indexName.startsWith('personal_audit_')
        if (isPersonal && options.personalAuditFails === true) throw { status: 403, kind: 'security' }
        if (!isPersonal && options.sharedAuditFails === true) throw { status: 403, kind: 'security' }
        audits.push({ index: indexName, doc })
        return { id: `audit-${audits.length}`, result: 'created', status: 200 }
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
    assert.equal(audits.length, 2, '个人审计 + 共享审计各一条')
    assert.equal(audits[0]?.index, 'personal_audit_u1', '先写个人那份')
    assert.equal(audits[0]?.doc.event, 'identity_approved')
    assert.equal(audits[0]?.doc.from_state, 'pending')
    assert.equal(audits[0]?.doc.to_state, 'active')
    assert.equal(audits[0]?.doc.note, '看着像')
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

  test('没有 teamWrite：共享审计失败，但个人审计仍写入（personal_only）', async () => {
    const { deps, updates, audits } = makeDeps(
      { t1: { memory_id: 't1', content: 'x', memory_type: 'identity', status: 'pending' } },
      { sharedAuditFails: true },
    )
    const out = await approveCandidate(deps, 't1')
    assert.equal(out.changed, true, '状态已改')
    assert.equal(out.audit, 'personal_only')
    assert.match(out.note, /共享审计索引写不进/)
    assert.equal(updates.length, 1)
    assert.equal(audits.length, 1, '只有个人那份写成功')
    assert.equal(audits[0]?.index, 'personal_audit_u1')
    // 审核痕迹必须同时落在条目上
    assert.equal(typeof updates[0]?.doc.reviewed_at, 'string')
    assert.equal(updates[0]?.doc.reviewed_by, 'u1')
  })

  test('个人审计也失败时才报 failed，且不回滚主操作', async () => {
    const { deps, updates } = makeDeps(
      { t1: { memory_id: 't1', content: 'x', memory_type: 'identity', status: 'pending' } },
      { personalAuditFails: true, sharedAuditFails: true },
    )
    const out = await approveCandidate(deps, 't1')
    assert.equal(out.changed, true, '状态已改')
    assert.equal(out.audit, 'failed')
    assert.equal(updates.length, 1)
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
    assert.equal(audits[0]?.doc.event, 'identity_rejected')
    assert.equal(audits[0]?.doc.note, '太笼统')
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

describe('setAnchor（阶段 7.5）', () => {
  test('生效中的 identity 可以设锚点，并写审计', async () => {
    const { deps, updates, audits } = makeDeps({
      i1: { memory_id: 'i1', content: '你倾向于先给结论', memory_type: 'identity', status: 'active' },
    })
    const out = await setAnchor(deps, 'i1', true)
    assert.equal(out.changed, true)
    assert.equal(updates[0]?.doc.anchor, true)
    assert.equal(audits[0]?.doc.event, 'identity_anchor_set')
  })

  test('取消锚点', async () => {
    const { deps, updates, audits } = makeDeps({
      i1: { memory_id: 'i1', content: 'x', memory_type: 'identity', status: 'active' },
    })
    const out = await setAnchor(deps, 'i1', false)
    assert.equal(out.changed, true)
    assert.equal(updates[0]?.doc.anchor, false)
    assert.equal(audits[0]?.doc.event, 'identity_anchor_cleared')
  })

  test('未生效的自述不能设锚点（pending / archived 都不行）', async () => {
    const { deps, updates } = makeDeps({
      p1: { memory_id: 'p1', content: 'x', memory_type: 'identity', status: 'pending' },
      a1: { memory_id: 'a1', content: 'x', memory_type: 'identity', status: 'archived' },
    })
    assert.equal((await setAnchor(deps, 'p1', true)).changed, false)
    assert.equal((await setAnchor(deps, 'a1', true)).changed, false)
    assert.equal(updates.length, 0)
  })

  test('普通记忆不能设锚点', async () => {
    const { deps } = makeDeps({
      f1: { memory_id: 'f1', content: 'x', memory_type: 'fact', status: 'active' },
    })
    const out = await setAnchor(deps, 'f1', true)
    assert.equal(out.changed, false)
    assert.match(out.note, /不是 identity/)
  })

  test('找不到条目如实返回', async () => {
    const { deps } = makeDeps({})
    const out = await setAnchor(deps, 'nope', true)
    assert.equal(out.changed, false)
    assert.match(out.note, /找不到/)
  })

  // ── 工具级：锚点必须走自己的分支，不能掉进 reject（2026-11-11 审查 #34）──────
  // `defineReviewTool` 的兜底是 `action === 'approve' ? approve : reject`。
  // `anchor` 分支必须排在它**之前**（review.ts 里现在的顺序是对的）。
  // 一旦有人把 anchor 分支挪后或删掉，`{action:'anchor'}` 会**掉进 reject** ——
  // 把候选置 archived，是**破坏性**后果。
  // 原来只有直接调 setAnchor 的测试（`grep "action: 'anchor'"` 在 tests 下 0 命中），
  // 所以从工具入口走完整路径这条一直是空的。下面从 execute() 走一遍。
  test('工具级：action=anchor 走锚点分支，绝不会掉进 reject', async () => {
    const { deps, updates, audits } = makeDeps({
      i1: { memory_id: 'i1', content: 'x', memory_type: 'identity', status: 'active' },
    })
    const def = defineReviewTool(deps)

    const value = (await def.execute(
      { action: 'anchor', memory_id: 'i1', anchor: true },
      {} as never,
    )) as Record<string, unknown>

    // 返回的 action 变了就说明走错分支（掉进 approve/reject）
    assert.equal(value.action, 'anchor')
    assert.equal(value.changed, true)

    // 真正的破坏性判据：写出去的只有「锚点位」，不能顺手改 status
    assert.equal(updates.length, 1, `只该有一次写，实际 ${updates.length} 次 —— 多出来的就是 reject 路径`)
    assert.equal(updates[0]?.doc.anchor, true)
    assert.equal(
      'status' in (updates[0]?.doc ?? {}),
      false,
      'anchor 不该碰 status —— 碰了就是把候选归档（reject 的后果）',
    )

    assert.equal(audits.length >= 1, true)
    // 审计会写两处（个人审计索引 + 团队审计索引），所以按**事件名**断言，不数条数
    const events = audits.map((a) => String(a.doc.event))
    assert.ok(events.includes('identity_anchor_set'), `审计里必须有 identity_anchor_set，实际 ${events.join('/')}`)
    assert.equal(events.includes('identity_rejected'), false, '出现 identity_rejected 就是掉进 reject 分支了')
  })

  // 上一条用 active 候选（能验证「锚点真写进去」）。但**破坏性**判据在这里：
  // pending 候选在 anchor 分支里应当被拒绝（「只有生效中的自述能设锚点」），
  // 可一旦 `{action:'anchor'}` 掉进 reject 分支，**pending 正好是 reject 的合法目标**
  // —— 候选会被真的置成 archived/rejected，一条待办就这么被悄悄毁掉。
  test('工具级：pending 候选走 anchor 分支会如实拒绝，绝不能被归档', async () => {
    const { deps, updates, audits } = makeDeps({
      p1: { memory_id: 'p1', content: 'x', memory_type: 'identity', status: 'pending' },
    })
    const def = defineReviewTool(deps)

    const value = (await def.execute(
      { action: 'anchor', memory_id: 'p1', anchor: true },
      {} as never,
    )) as Record<string, unknown>

    assert.equal(value.action, 'anchor', '走错分支时 action 会变成 reject')
    assert.equal(value.changed, false, 'pending 不能设锚点，必须如实返回 changed=false')

    // 破坏性判据：一次写都不该发生
    assert.deepEqual(
      updates.map((u) => ({ id: u.id, keys: Object.keys(u.doc) })),
      [],
      'pending 候选在 anchor 分支下不该有任何写入；有写入就是掉进 reject 被归档了',
    )
    const events = audits.map((a) => String(a.doc.event))
    assert.equal(events.includes('identity_rejected'), false, '出现 identity_rejected 就是被 reject 了')
  })
})
