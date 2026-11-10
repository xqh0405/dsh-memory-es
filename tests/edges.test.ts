/**
 * 阶段 5.2 建边：纯函数取舍 + `memory_save` 里的落库行为。
 *
 * 纯函数部分不碰网络；落库部分用进程内假 ES 走真实 HTTP，
 * 这样「kNN 候选怎么过滤」「失败是否影响保存」都是可断言的。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { mergeEdges, mergeEdgesSegmented, pickNeighbors, readEdges } from '../src/edges.ts'
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

  test('舍入后不越过判重带：0.84996 舍成 0.85 就该被排除', () => {
    const picked = pickNeighbors(
      [
        { id: 'just-under', score: 0.84996 },
        { id: 'safe', score: 0.84994 },
      ],
      opts,
    )
    assert.deepEqual(picked, [{ id: 'safe', weight: 0.8499 }], '存的权重必须与判定一致')
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

// 2026-11-10 审查 P5/#20：`related` 里可能已有**文档边**（link-docs.ts 写的，
// 权重 0.83~0.86），比记忆边（0.55~0.85）重。老写法 mergeEdges 按权重截断 topK
// 会把记忆边**整组挤掉**（2026-11-09 实测 8 条记忆的记忆边被清空，git show 3209607）。
// 这份分段逻辑之前重复存在于 backfill-edges.ts 与 link-docs.ts 两处，save.ts 还是老写法。
describe('mergeEdgesSegmented（分段：文档边不参与 topK 截断）', () => {
  const DOC = [
    { id: 'doc-a-0', weight: 0.86 },
    { id: 'doc-b-0', weight: 0.84 },
  ]
  const MEM = [
    { id: 'm1', weight: 0.6 },
    { id: 'm2', weight: 0.58 },
  ]
  const INCOMING = [
    { id: 'n1', weight: 0.7 },
    { id: 'n2', weight: 0.65 },
    { id: 'n3', weight: 0.6 },
  ]
  const DOC_IDS = new Set(['doc-a-0', 'doc-b-0'])

  test('existing 含文档边时不被记忆边挤掉（本条就是 #20 的核心回归）', () => {
    const existing = [...DOC, ...MEM]
    const out = mergeEdgesSegmented(existing, INCOMING, 3, DOC_IDS)

    const docSeg = out.filter((e) => e.id.startsWith('doc-'))
    const memSeg = out.filter((e) => !e.id.startsWith('doc-'))

    // 文档边：原样全留（不占 topK 名额）
    assert.equal(docSeg.length, 2, `文档边应 2 条全留，实际 ${JSON.stringify(docSeg)}`)
    // 要钉的性质是**记忆段独占 topK 预算**：
    // 5 个记忆候选（m1/m2 旧 + n1/n2/n3 新）按权重取前 3 —— 拿满 3 个名额。
    // （m2 是最低分 0.58，落选是**对的**：topK 对记忆段照样生效，本函数不是在取消上界。）
    assert.equal(memSeg.length, 3, `记忆段应拿满 topK=3 个名额，实际 ${JSON.stringify(memSeg)}`)
    assert.ok(memSeg.some((e) => e.id === 'm1'), `至少要有旧记忆边留下来，实际 ${JSON.stringify(memSeg)}`)

    // 对照同一组输入走老写法：文档边占掉 2 个名额 → 记忆段只剩 1 个 → 旧记忆边全没
    const naive = mergeEdges(existing, INCOMING, 3)
    const naiveMem = naive.filter((e) => !e.id.startsWith('doc-'))
    assert.equal(naiveMem.length, 1, `老写法记忆段被压到 1 个名额（bug 现象），实际 ${JSON.stringify(naive)}`)
    assert.equal(
      naive.filter((e) => e.id === 'm1' || e.id === 'm2').length,
      0,
      '老写法下旧记忆边一条不剩 —— 这正是「8 条归零」的成因，作为对照钉死',
    )
  })

  test('对照：老写法 mergeEdges 会把记忆边全挤没（这正是当时的 bug）', () => {
    const existing = [...DOC, ...MEM]
    const naive = mergeEdges(existing, INCOMING, 3)
    const naiveIds = naive.map((e) => e.id)
    // 文档边更重 → 占掉 topK 的头两名，旧记忆边 m1/m2 一条不剩
    assert.equal(naiveIds.includes('m1'), false, '老写法下 m1 应当被挤掉（bug 现象）')
    assert.equal(naiveIds.includes('m2'), false, '老写法下 m2 应当被挤掉（bug 现象）')
    // 有了分段版之后，这条对照同时钉住「别改回老写法」
    const fixed = mergeEdgesSegmented(existing, INCOMING, 3, DOC_IDS)
    assert.ok(fixed.some((e) => e.id === 'm1'), '分段版必须保住 m1')
  })

  test('文档边集合为空时，结果与 mergeEdges 完全一致（退化不改变行为）', () => {
    const existing = [...MEM, { id: 'other', weight: 0.5 }]
    assert.deepEqual(
      mergeEdgesSegmented(existing, INCOMING, 3, new Set()),
      mergeEdges(existing, INCOMING, 3),
      '没有文档边时两条路必须等价，否则分段逻辑会给常态路径带来行为变化',
    )
  })

  test('topK=0：文档边仍保留、记忆段清空（关掉的只是记忆段上界）', () => {
    const out = mergeEdgesSegmented([...DOC, ...MEM], INCOMING, 0, DOC_IDS)
    assert.deepEqual(out.map((e) => e.id), ['doc-a-0', 'doc-b-0'])
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
  /**
   * `existing` 里**属于文档切片**的 id（2026-11-10 审查 P5/#20）：
   * save 在 existing 非空时会拿它做 ids 查询，分出文档边才能分段合并。
   * 缺省 [] = 文档索引存在但这些 id 不是文档（判定结果是**空集**，不等于「判不出」）。
   */
  docIds?: string[]
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
      // 文档边判定（#20）：save 在 existing 非空时对 `personal_doc_<uid>` 做一次 ids 查询，
      // 问「这些 id 哪些是文档切片」—— 必须排在 knn/去重两路**之前**（它两者都不是）。
      if (req.path.includes('personal_doc_')) {
        const ids = (body.query as { ids?: { values?: unknown } } | undefined)?.ids
        const wanted = (Array.isArray(ids?.values) ? ids?.values : []) as string[]
        const hits = wanted.filter((id) => (state.docIds ?? []).includes(String(id)))
        sendJson(res, 200, {
          took: 1,
          hits: {
            total: { value: hits.length, relation: 'eq' },
            hits: hits.map((id) => ({ _id: id, _score: 1, _source: {} })),
          },
        })
        return
      }
      // 向量路：返回预设候选
      if (body.knn !== undefined) {
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
    // 与生产接线一致（index.ts 给 defineSaveTool 传的）：#20 的文档边判定要用它。
    // 缺省有它 → existing 非空时会去查文档索引，判定结果由 state.docIds 决定。
    docPrefix: 'personal_doc_',
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

  // 2026-11-10 审查 P5/#20 的两条 save 侧行为：
  test('existing 含文档边 → 分段合并，文档边原样保住、记忆边不被挤掉', async () => {
    const { fake, updates } = await startEdgesFake({
      // 文档边更重（0.86 > 记忆边 0.6）——老写法按权重截断会把它整组挤掉
      neighbors: [{ memoryId: 'n1', score: 0.7 }],
      existing: [
        { id: 'doc-a-0', weight: 0.86 },
        { id: 'm1', weight: 0.6 },
      ],
      docIds: ['doc-a-0'],
    })
    try {
      await saveMemory(makeDeps(fake), { content: '一条带文档边的补充事实' })
      const doc = (updates[0] as { doc?: { related?: Array<{ id: string }> } }).doc
      const ids = (doc?.related ?? []).map((e) => e.id)
      assert.ok(ids.includes('doc-a-0'), `文档边必须原样保住，实际 ${JSON.stringify(ids)}`)
      assert.ok(ids.includes('m1'), `记忆边 m1 不能被挤掉，实际 ${JSON.stringify(ids)}`)
      assert.ok(ids.includes('n1'), `新邻居 n1 应并进来，实际 ${JSON.stringify(ids)}`)
    } finally {
      await fake.close()
    }
  })

  test('判不出文档边（没给 docPrefix）→ 本轮不写 related，绝不猜', async () => {
    const { fake, updates } = await startEdgesFake({
      neighbors: [{ memoryId: 'n1', score: 0.7 }],
      existing: [
        { id: 'doc-a-0', weight: 0.86 },
        { id: 'm1', weight: 0.6 },
      ],
    })
    const events: Array<Record<string, unknown>> = []
    try {
      const result = await saveMemory(
        makeDeps(fake, { docPrefix: undefined, log: (e) => events.push(e) }),
        { content: '一条判定不出文档边的事实' },
      )
      assert.equal(result.deduped, false, '保存本身必须成功')
      assert.equal(updates.length, 0, `判不出时绝不能写 related（写下去就可能把文档边挤掉），实际写了 ${JSON.stringify(updates)}`)
      assert.ok(
        events.some((e) => e.event === 'edges_skipped_unclassifiable'),
        `要记一条 edges_skipped_unclassifiable 让这事可查，实际事件：${events.map((e) => e.event).join(',')}`,
      )
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
