/**
 * 阶段 10：检索回执（`explain=true`）。
 *
 * 两个断言方向：
 *  1. **回执只解释、不改序**——同一份输出，explain 开与关的 hits 序列必须逐条一致
 *     （这是「只读能力」的硬约束，回执一旦影响排序就成了第二个排序器）；
 *  2. 回执要说得出人话：哪一路召回、名次多少、RRF 多少、乘子有没有动过、标识符命中没有。
 *
 * 这里用进程内假 ES 走真实 HTTP：两路（BM25 / kNN）按 body 是否带 `knn` 分流。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { createEsClient } from '../src/es/http.ts'
import { buildHitReceipts, type ScopedHit } from '../src/fragment.ts'
import { defineSearchTool, renderReceipts, searchMemories, type SearchDeps } from '../src/memory/search.ts'
import { sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const NOW = new Date('2026-11-01T12:00:00.000Z')
const DIMS = 4
const VECTOR = [0.1, 0.2, 0.3, 0.4]

/** 同一份候选，按「带不带 knn」分两路返回 */
function startSearchFake(): Promise<FakeEs> {
  return startFakeEs((req, res) => {
    if (req.method === 'POST' && req.path.includes('/_search')) {
      const body = JSON.parse(req.body || '{}') as { knn?: unknown }
      if (body.knn !== undefined) {
        sendJson(res, 200, {
          took: 1,
          hits: {
            total: { value: 2, relation: 'eq' },
            hits: [
              { _id: 'a', _score: 0.9, _source: source('a') },
              { _id: 'c', _score: 0.8, _source: source('c') },
            ],
          },
        })
        return
      }
      sendJson(res, 200, {
        took: 1,
        hits: {
          total: { value: 2, relation: 'eq' },
          hits: [
            { _id: 'a', _score: 30, _source: source('a') },
            { _id: 'b', _score: 12, _source: source('b') },
          ],
        },
      })
      return
    }
    sendJson(res, 400, { error: { type: 'bad_request', reason: `unhandled ${req.method} ${req.path}` } })
  })
}

function source(id: string): Record<string, unknown> {
  // a 的正文里带标识符，用来验证「标识符命中」这条理由
  const content =
    id === 'a'
      ? '北单同步走 lot.bd_write_sync 主表直连，动工前逐位对拍赔率列。'
      : `一条与查询相关但没带标识符的事实 ${id}`
  return {
    memory_id: id,
    content,
    content_exact: content,
    memory_type: 'fact',
    domain: 'general',
    updated_at: '2026-10-01T00:00:00.000Z',
  }
}

function makeDeps(fake: FakeEs, overrides: Partial<SearchDeps> = {}): SearchDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    teamIndex: 'team_knowledge',
    reader: createEsClient({ url: fake.url, username: 'r', password: 'r' }),
    embed: { embed: async () => VECTOR },
    dims: DIMS,
    retrieval: { topK: 10, rrfK: 60, limit: 5 },
    now: () => NOW,
    hitRecorder: null,
    recorder: null,
    ...overrides,
  }
}

describe('buildHitReceipts（纯函数）', () => {
  function scoped(id: string, fusedScore: number, sourceExtra: Record<string, unknown> = {}): ScopedHit {
    return {
      id,
      score: fusedScore,
      source: { memory_id: id, ...sourceExtra },
      routeRanks: [1],
      fusedScore,
      origin: 'personal',
      contentHash: id,
    }
  }

  test('两路都有 → both-routes + agree，RRF 与最终分分开记', () => {
    const routes = new Map([
      ['personal:a', { bm25: { rank: 1, score: 30 }, knn: { rank: 1, score: 0.9 }, rrf: 0.0328 }],
    ])
    const [receipt] = buildHitReceipts({ hits: [scoped('a', 0.0394)], routes, weights: { personal: 1.2 } })
    assert.equal(receipt?.bm25_rank, 1)
    assert.equal(receipt?.knn_rank, 1)
    assert.equal(receipt?.rrf, 0.0328)
    assert.equal(receipt?.sourceWeight, 1.2, '跨库权重单独记，不和 RRF 混在一起')
    assert.equal(receipt?.final, 0.0394)
    assert.deepEqual(receipt?.reasons.slice(0, 2), ['both-routes', 'agree'])
    assert.ok(receipt?.reasons.includes('ranked-up'), '0.0394 > 0.0328×1.2 时应标 ranked-up')
  })

  test('只有一路命中 → bm25-only / knn-only', () => {
    const routes = new Map([
      ['personal:b', { bm25: { rank: 2, score: 12 }, rrf: 0.0161 }],
      ['personal:c', { knn: { rank: 2, score: 0.8 }, rrf: 0.0159 }],
    ])
    const receipts = buildHitReceipts({ hits: [scoped('b', 0.0193), scoped('c', 0.0191)], routes, weights: { personal: 1.2 } })
    assert.deepEqual(receipts[0]?.reasons[0], 'bm25-only')
    assert.equal(receipts[0]?.knn_rank, undefined)
    assert.deepEqual(receipts[1]?.reasons[0], 'knn-only')
    assert.equal(receipts[1]?.bm25_rank, undefined)
  })

  test('标识符命中：正文里真的出现才算（大小写无关）', () => {
    const routes = new Map([['personal:a', { rrf: 0.03 }]])
    const [hit] = buildHitReceipts({
      hits: [scoped('a', 0.03, { content_exact: '走 LOT.BD_WRITE_SYNC 主表直连' })],
      routes,
      identifiers: ['lot.bd_write_sync', 'other'],
    })
    assert.deepEqual(hit?.identifiers, ['lot.bd_write_sync'])
    assert.ok(hit?.reasons.includes('identifier-match'))
  })
})

describe('searchMemories 的 explain', () => {
  test('explain=false：不返回 receipts，text 不含命中理由', async () => {
    const fake = await startSearchFake()
    try {
      const result = await searchMemories(makeDeps(fake), {
        query: 'lot.bd_write_sync 北单同步',
        scope: 'personal',
      })
      assert.equal(result.receipts, undefined)
      assert.ok(!result.text.includes('命中理由'))
      assert.equal(result.hits.length, 3, 'a 两路 + b 只有 BM25 + c 只有 kNN')
    } finally {
      await fake.close()
    }
  })

  test('explain=true：回执与 hits 逐条同序、id 对得上', async () => {
    const fake = await startSearchFake()
    try {
      const result = await searchMemories(makeDeps(fake), {
        query: 'lot.bd_write_sync 北单同步',
        scope: 'personal',
        explain: true,
      })
      const receipts = result.receipts ?? []
      assert.equal(receipts.length, result.hits.length)
      assert.deepEqual(
        receipts.map((item) => item.memory_id),
        result.hits.map((item) => item.memory_id),
        '回执必须与 hits 同序（否则模型对不上号）',
      )
      const a = receipts.find((item) => item.memory_id === 'a')
      assert.equal(a?.bm25_rank, 1)
      assert.equal(a?.knn_rank, 1)
      assert.ok(a?.reasons.includes('both-routes'))
      assert.match(result.text, /命中理由（explain）/)
      assert.match(result.text, /BM25 第1/)
    } finally {
      await fake.close()
    }
  })

  test('回执只读：explain 开与关的 hits 序列与分数完全一致', async () => {
    const fake = await startSearchFake()
    try {
      const deps = makeDeps(fake)
      const off = await searchMemories(deps, { query: 'lot.bd_write_sync 北单同步', scope: 'personal' })
      const on = await searchMemories(deps, { query: 'lot.bd_write_sync 北单同步', scope: 'personal', explain: true })
      assert.deepEqual(on.hits, off.hits, 'explain 不能改动任何一条命中（含分数）')
      assert.equal(on.note, off.note)
      assert.equal(on.degraded, off.degraded)
    } finally {
      await fake.close()
    }
  })

  test('no_match + explain：返回空 receipts 而不是省略字段', async () => {
    const fake = await startFakeEs((_req, res) => {
      sendJson(res, 200, { took: 1, hits: { total: { value: 0, relation: 'eq' }, hits: [] } })
    })
    try {
      const result = await searchMemories(makeDeps(fake), {
        query: '一条查不到的记忆',
        scope: 'personal',
        explain: true,
      })
      assert.equal(result.note, 'no_match')
      assert.deepEqual(result.receipts, [])
    } finally {
      await fake.close()
    }
  })
})

describe('renderReceipts', () => {
  test('文本里带上名次、RRF 流与标识符，模型才读得到', () => {
    const text = renderReceipts([
      {
        memory_id: 'mem-1',
        source: 'personal',
        bm25_rank: 1,
        bm25_score: 30,
        knn_rank: 2,
        knn_score: 0.8123,
        rrf: 0.0328,
        sourceWeight: 1.2,
        final: 0.0394,
        reasons: ['both-routes', 'ranked-up'],
        identifiers: ['lot.bd_write_sync'],
      },
    ])
    assert.match(text, /BM25 第1/)
    assert.match(text, /kNN 第2（cos 0\.812）/)
    assert.match(text, /rrf 0\.0328 ×1\.2 → 0\.0394/)
    assert.match(text, /标识符 lot\.bd_write_sync/)
    assert.match(text, /乘子上调/)
  })
})

describe('工具契约：receipts 必须过 DSH 的 output schema 校验', () => {
  const EXEC = { signal: new AbortController().signal } as unknown as ToolRunContext

  test('explain=true 的返回值通过 schema（扁平字段，无嵌套 object）', async () => {
    const fake = await startSearchFake()
    try {
      const tool = defineSearchTool(makeDeps(fake))
      const value = (await tool.execute(
        { query: 'lot.bd_write_sync 北单同步', scope: 'personal', explain: true },
        EXEC,
      )) as Record<string, unknown>
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
      assert.ok(Array.isArray(value.receipts) && value.receipts.length > 0)
      // render 只给 text：回执必须已经在 text 里，否则模型看不见
      const rendered = tool.output.render({}, value as never) as Array<{ text: string }>
      assert.match(rendered[0]?.text ?? '', /命中理由（explain）/)
    } finally {
      await fake.close()
    }
  })

  test('explain=false 的返回值同样过 schema（receipts 缺省而不是 null）', async () => {
    const fake = await startSearchFake()
    try {
      const tool = defineSearchTool(makeDeps(fake))
      const value = (await tool.execute(
        { query: 'lot.bd_write_sync 北单同步', scope: 'personal' },
        EXEC,
      )) as Record<string, unknown>
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
      assert.equal('receipts' in value, false)
    } finally {
      await fake.close()
    }
  })
})
