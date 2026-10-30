/**
 * 阶段 5.2 建边：纯函数取舍 + `memory_save` 里的落库行为。
 *
 * 纯函数部分不碰网络；落库部分用进程内假 ES 走真实 HTTP，
 * 这样「kNN 候选怎么过滤」「失败是否影响保存」都是可断言的。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { mergeEdges, pickNeighbors, readEdges } from '../src/memory/edges.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { sendEsError, sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const FIXED_ID = '11111111-2222-3333-4444-555555555555'
const NOW = new Date('2026-10-30T12:00:00.000Z')
const DIMS = 4
const VECTOR = [0.1, 0.2, 0.3, 0.4]

const EDGES = { enabled: true, topK: 3, minScore: 0.55, maxScore: 0.85, dims: DIMS }

describe('pickNeighbors', () => {
  const opts = { minScore: 0.55, maxScore: 0.85, topK: 3 }

  test('只收 [minScore, maxScore) 区间内的候选', () => {
    const picked = pickNeighbors(
      [
        { id: 'noise', score: 0.3 },
        { id: 'dup', score: 0.9 },
        { id: 'edge-low', score: 0.55 },
        { id: 'edge-high', score: 0.8499 },
      ],
      opts,
    )
    assert.deepEqual(picked.map((e) => e.id), ['edge-high', 'edge-low'])
  })

  test('排除自身，绝不自环', () => {
    const picked = pickNeighbors(
      [
        { id: 'me', score: 0.7 },
        { id: 'other', score: 0.6 },
      ],
      { ...opts, excludeId: 'me' },
    )
    assert.deepEqual(picked, [{ id: 'other', weight: 0.6 }])
  })

  test('同一 id 只留最高分，并按分数降序', () => {
    const picked = pickNeighbors(
      [
        { id: 'a', score: 0.6 },
        { id: 'b', score: 0.7 },
        { id: 'a', score: 0.8 },
      ],
      opts,
    )
    assert.deepEqual(picked, [
      { id: 'a', weight: 0.8 },
      { id: 'b', weight: 0.7 },
    ])
  })

  test('截断到 topK', () => {
    const hits = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, score: 0.6 + i * 0.05 }))
    assert.equal(pickNeighbors(hits, { ...opts, topK: 2 }).length, 2)
  })

  test('坏数据一律丢弃：空 id、NaN 分数、topK=0', () => {
    const picked = pickNeighbors(
      [
        { id: '', score: 0.7 },
        { id: '  ', score: 0.7 },
        { id: 'x', score: Number.NaN },
        { id: 'y', score: Number.POSITIVE_INFINITY },
      ],
      opts,
    )
    assert.deepEqual(picked, [])
    assert.deepEqual(pickNeighbors([{ id: 'a', score: 0.7 }], { ...opts, topK: 0 }), [])
  })

  test('权重保留 4 位小数', () => {
    const picked = pickNeighbors([{ id: 'a', score: 0.123456789 }], { ...opts, minScore: 0 })
    assert.equal(picked[0]?.weight, 0.1235)
  })
})

describe('mergeEdges', () => {
  test('幂等：同一批边合并两次结果不变', () => {
    const once = mergeEdges([], [{ id: 'a', weight: 0.7 }], 3)
    const twice = mergeEdges(once, [{ id: 'a', weight: 0.7 }], 3)
    assert.deepEqual(twice, once)
  })

  test('同一 id 取较大权重（邻居不会因一次查询偏弱被削弱）', () => {
    const merged = mergeEdges([{ id: 'a', weight: 0.8 }], [{ id: 'a', weight: 0.6 }], 3)
    assert.deepEqual(merged, [{ id: 'a', weight: 0.8 }])
  })

  test('本轮没出现的旧边保留（topK 有限，不等于不相关）', () => {
    const merged = mergeEdges([{ id: 'old', weight: 0.6 }], [{ id: 'new', weight: 0.7 }], 3)
    assert.deepEqual(merged.map((e) => e.id), ['new', 'old'])
  })

  test('按权重排序后截断 topK', () => {
    const existing = ['a', 'b', 'c'].map((id, i) => ({ id, weight: 0.6 + i * 0.05 }))
    const merged = mergeEdges(existing, [{ id: 'z', weight: 0.84 }], 2)
    assert.deepEqual(merged.map((e) => e.id), ['z', 'c'])
  })

  test('topK=0 返回空（等于关掉邻接表上界）', () => {
    assert.deepEqual(mergeEdges([{ id: 'a', weight: 0.7 }], [], 0), [])
  })
})

describe('readEdges', () => {
  test('缺失/非数组一律当空', () => {
    assert.deepEqual(readEdges(undefined), [])
    assert.deepEqual(readEdges(null), [])
    assert.deepEqual(readEdges({ id: 'a' }), [])
  })

  test('过滤坏条目，保留合法边', () => {
    const edges = readEdges([
      { id: 'a', weight: 0.7 },
      { id: '', weight: 0.7 },
      { id: 'b', weight: '0.9' },
      null,
      { id: 'c', weight: 0.5 },
    ])
    assert.deepEqual(edges.map((e) => e.id), ['a', 'c'])
  })
})

interface FakeEdgesState {
  /** kNN 候选（写死，便于断言过滤） */
  neighbors: Array<{ memoryId: string; score: number }>
  /** 读回时的已有边 */
  existing: unknown
  /** true = 写回 related 时返回 500 */
  failUpdate: boolean
}

async function startEdgesFake(overrides: Partial<FakeEdgesState> = {}): Promise<{
  fake: FakeEs
  state: FakeEdgesState
  updates: Record<string, unknown>[]
}> {
  const state: FakeEdgesState = { neighbors: [], existing: [], failUpdate: false, ...overrides }
  const updates: Record<string, unknown>[] = []
  const fake = await startFakeEs((req, res) => {
    const body = req.body === '' ? {} : (JSON.parse(req.body) as Record<string, unknown>)

    if (req.path.includes('/_search')) {
      if (body.knn !== undefined) {
        // 向量路：返回预设候选
        sendJson(res, 200, {
          took: 1,
          hits: {
            total: { value: state.neighbors.length, relation: 'eq' },
            hits: state.neighbors.map((n) => ({
              _id: n.memoryId,
              _score: n.score,
              _source: { memory_id: n.memoryId },
            })),
          },
        })
        return
      }
      // 去重路：一律未命中
      sendJson(res, 200, { took: 1, hits: { total: { value: 0, relation: 'eq' }, hits: [] } })
      return
    }

    if (req.path.includes('/_update/')) {
      if (state.failUpdate) {
        sendEsError(res, 500, 'internal_server_error', 'update boom')
        return
      }
      updates.push(body)
      sendJson(res, 200, { _id: FIXED_ID, result: 'updated' })
      return
    }

    if (req.method === 'GET' && req.path.includes('/_doc/')) {
      sendJson(res, 200, { _id: FIXED_ID, _index: 'personal_memory_xqh', _source: { related: state.existing } })
      return
    }

    if (req.method === 'POST' && req.path.includes('/_doc')) {
      sendJson(res, 201, { _id: FIXED_ID, result: 'created' })
      return
    }

    // 带 id 的写入走 PUT /<index>/_doc/<id>?refresh=wait_for
    if (req.method === 'PUT' && req.path.includes('/_doc/')) {
      sendJson(res, 201, { _id: FIXED_ID, result: 'created' })
      return
    }

    sendJson(res, 400, { error: { type: 'bad_request', reason: `unhandled ${req.method} ${req.path}` } })
  })
  return { fake, state, updates }
}

function makeDeps(fake: FakeEs, overrides: Partial<SaveDeps> = {}): SaveDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    defaultDomain: 'general',
    reader: createEsClient({ url: fake.url, username: 'r', password: 'r' }),
    writer: createEsClient({ url: fake.url, username: 'w', password: 'w' }),
    embed: { embed: async () => VECTOR },
    now: () => NOW,
    newId: () => FIXED_ID,
    edges: EDGES,
    ...overrides,
  }
}

describe('saveMemory 建边', () => {
  test('候选落在区间内 → 写回 related（排除自身）', async () => {
    const { fake, updates } = await startEdgesFake({
      neighbors: [
        { memoryId: FIXED_ID, score: 0.9 }, // 自身：必须被排除
        { memoryId: 'n1', score: 0.72 },
        { memoryId: 'n2', score: 0.3 }, // 噪声：低于 minScore
      ],
    })
    try {
      const result = await saveMemory(makeDeps(fake), { content: '一条会建边的事实' })
      assert.equal(result.deduped, false)
      assert.equal(updates.length, 1, '只写一次 related')
      // `_update` 的 body 是 { doc: {...} }
      assert.deepEqual((updates[0] as { doc?: unknown }).doc, { related: [{ id: 'n1', weight: 0.72 }] })
    } finally {
      await fake.close()
    }
  })

  test('没有合格候选时不写回（省一次 update）', async () => {
    const { fake, updates } = await startEdgesFake({
      neighbors: [{ memoryId: 'noise', score: 0.4 }],
    })
    try {
      await saveMemory(makeDeps(fake), { content: '一条没有邻居的事实' })
      assert.equal(updates.length, 0)
    } finally {
      await fake.close()
    }
  })

  test('已有边会被合并而不是覆盖', async () => {
    const { fake, updates } = await startEdgesFake({
      neighbors: [{ memoryId: 'n1', score: 0.7 }],
      existing: [{ id: 'old', weight: 0.66 }],
    })
    try {
      await saveMemory(makeDeps(fake), { content: '一条补充邻居的事实' })
      assert.deepEqual((updates[0] as { doc?: unknown }).doc, {
        related: [
          { id: 'n1', weight: 0.7 },
          { id: 'old', weight: 0.66 },
        ],
      })
    } finally {
      await fake.close()
    }
  })

  test('写回 related 失败不影响「已保存」的结论', async () => {
    const { fake } = await startEdgesFake({
      neighbors: [{ memoryId: 'n1', score: 0.7 }],
      failUpdate: true,
    })
    const events: Array<Record<string, unknown>> = []
    try {
      const result = await saveMemory(makeDeps(fake, { log: (e) => events.push(e) }), {
        content: '一条建边会失败但保存成功的事实',
      })
      assert.equal(result.deduped, false, '保存本身必须成功')
      assert.ok(events.some((e) => e.event === 'edges_failed'), '要记一条 edges_failed')
    } finally {
      await fake.close()
    }
  })

  test('edges.enabled=false 时不查也不写', async () => {
    const { fake, updates } = await startEdgesFake({ neighbors: [{ memoryId: 'n1', score: 0.7 }] })
    try {
      await saveMemory(makeDeps(fake, { edges: { ...EDGES, enabled: false } }), { content: '一条不建边的事实' })
      assert.equal(updates.length, 0)
      assert.equal(fake.requests.filter((r) => r.path.includes('/_search')).length, 1, '只做去重那次查询')
    } finally {
      await fake.close()
    }
  })
})
