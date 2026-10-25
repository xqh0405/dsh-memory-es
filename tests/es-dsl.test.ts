/**
 * DSL 组装单测：过滤条件的默认值与顺序、BM25 字段权重、kNN 的 k/num_candidates 与维度校验。
 * 纯函数，不依赖 ES。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { bm25Body, buildFilters, DEFAULT_SOURCE_EXCLUDES, knnBody } from '../src/es/dsl.ts'

describe('buildFilters', () => {
  test('默认只加 status=active', () => {
    assert.deepEqual(buildFilters(), [{ term: { status: 'active' } }])
  })

  test('status 传 null → 不加状态条件（审计/排障用）', () => {
    assert.deepEqual(buildFilters({ status: null }), [])
  })

  test('条件顺序稳定：status → memory_type → domain → 时间窗', () => {
    const now = new Date('2026-10-25T12:00:00.000Z')
    const filters = buildFilters({
      memory_type: 'decision',
      domain: 'lottery-cloud',
      updatedWithinDays: 30,
      now,
    })
    assert.deepEqual(filters, [
      { term: { status: 'active' } },
      { term: { memory_type: 'decision' } },
      { term: { domain: 'lottery-cloud' } },
      { range: { updated_at: { gte: '2026-09-25T12:00:00.000Z' } } },
    ])
  })

  test('updatedWithinDays 非正整数 → 抛错（0 天会让窗口变成“此刻”）', () => {
    assert.throws(() => buildFilters({ updatedWithinDays: 0 }), /updatedWithinDays/)
    assert.throws(() => buildFilters({ updatedWithinDays: -1 }), /updatedWithinDays/)
    assert.throws(() => buildFilters({ updatedWithinDays: 1.5 }), /updatedWithinDays/)
  })
})

describe('bm25Body', () => {
  test('size / _source 排除向量 / 字段权重 / filter 复用', () => {
    const body = bm25Body('  比赛腰斩怎么结算 ', { domain: 'lottery-cloud' }, 12)
    assert.equal(body.size, 12)
    assert.deepEqual(body._source, { excludes: [...DEFAULT_SOURCE_EXCLUDES] })
    assert.deepEqual(body.query, {
      bool: {
        must: [
          {
            multi_match: {
              query: '比赛腰斩怎么结算',
              fields: ['content^2', 'semantic_keywords^1.5'],
              type: 'best_fields',
            },
          },
        ],
        filter: [{ term: { status: 'active' } }, { term: { domain: 'lottery-cloud' } }],
      },
    })
  })

  test('query 空白 → 抛错', () => {
    assert.throws(() => bm25Body('   '), /query 不能为空/)
  })

  test('topK 非法 → 抛错', () => {
    assert.throws(() => bm25Body('x', {}, 0), /topK/)
  })
})

describe('knnBody', () => {
  const vector = Array.from({ length: 1024 }, (_v, i) => Math.sin(i))

  test('k 与 num_candidates = 5k，filter 与 BM25 一致', () => {
    const body = knnBody(vector, 1024, { memory_type: 'fact' }, 20)
    assert.equal(body.size, 20)
    assert.deepEqual(body._source, { excludes: [...DEFAULT_SOURCE_EXCLUDES] })
    assert.equal(body.query, undefined, 'kNN 是顶层参数，不能塞进 query')
    const knn = body.knn as Record<string, unknown>
    assert.equal(knn.field, 'embedding')
    assert.equal(knn.k, 20)
    assert.equal(knn.num_candidates, 100)
    assert.deepEqual(knn.filter, [{ term: { status: 'active' } }, { term: { memory_type: 'fact' } }])
    assert.deepEqual((knn.query_vector as number[]).slice(0, 3), [Math.sin(0), Math.sin(1), Math.sin(2)])
  })

  test('向量维度与 dims 不一致 → 抛错（换 embedding 模型必须重建索引）', () => {
    assert.throws(() => knnBody([0.1, 0.2], 1024), /维度/)
  })

  test('向量含非有限数 → 抛错', () => {
    const broken = [...vector]
    broken[3] = Number.NaN
    assert.throws(() => knnBody(broken, 1024), /第 3 维/)
  })
})
