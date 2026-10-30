/**
 * DSL 组装单测：过滤条件的默认值与顺序、BM25 字段权重、kNN 的 k/num_candidates 与维度校验。
 * 纯函数，不依赖 ES。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { bm25Body, buildFilters, DEFAULT_SOURCE_EXCLUDES, freshOnlyFilters, knnBody } from '../src/es/dsl.ts'

const NOW = new Date('2026-10-25T12:00:00.000Z')

describe('buildFilters / review_state（S9 审核闸）', () => {
  test('传数组 → terms；传 null/undefined → 不加条件', () => {
    const withFilter = buildFilters({ status: 'active', review_state: ['auto', 'approved'], now: NOW })
    assert.deepEqual(withFilter.at(-3), { terms: { review_state: ['auto', 'approved'] } })
    assert.deepEqual(buildFilters({ status: 'active', review_state: null, now: NOW }), [
      { term: { status: 'active' } },
      ...freshOnlyFilters(NOW),
    ])
    assert.deepEqual(buildFilters({ status: 'active', now: NOW }), [{ term: { status: 'active' } }, ...freshOnlyFilters(NOW)])
  })

  test('单值 → term（与其它 meta 过滤行为一致）', () => {
    assert.deepEqual(buildFilters({ review_state: 'approved', now: NOW }), [
      { term: { status: 'active' } },
      { term: { review_state: 'approved' } },
      ...freshOnlyFilters(NOW),
    ])
  })
})

describe('buildFilters', () => {
  test('默认：status=active + 两条时效过滤', () => {
    assert.deepEqual(buildFilters({ now: NOW }), [{ term: { status: 'active' } }, ...freshOnlyFilters(NOW)])
  })

  test('status 传 null → 不加状态条件（审计/排障用），但时效过滤仍然生效', () => {
    assert.deepEqual(buildFilters({ status: null, now: NOW }), freshOnlyFilters(NOW))
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
      ...freshOnlyFilters(now),
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
    const body = bm25Body('  比赛腰斩怎么结算 ', { domain: 'lottery-cloud', now: NOW }, 12)
    assert.equal(body.size, 12)
    assert.deepEqual(body._source, { excludes: [...DEFAULT_SOURCE_EXCLUDES] })
    assert.deepEqual(body.query, {
      bool: {
        must: [
          {
            multi_match: {
              query: '比赛腰斩怎么结算',
              // summary 是蒸馏产出的一句话，必须参与 BM25（否则蒸馏白存）
              fields: ['content^2', 'summary^1.5', 'semantic_keywords^1.5'],
              type: 'best_fields',
            },
          },
        ],
        filter: [{ term: { status: 'active' } }, { term: { domain: 'lottery-cloud' } }, ...freshOnlyFilters(NOW)],
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
    const body = knnBody(vector, 1024, { memory_type: 'fact', now: NOW }, 20)
    assert.equal(body.size, 20)
    assert.deepEqual(body._source, { excludes: [...DEFAULT_SOURCE_EXCLUDES] })
    assert.equal(body.query, undefined, 'kNN 是顶层参数，不能塞进 query')
    const knn = body.knn as Record<string, unknown>
    assert.equal(knn.field, 'embedding')
    assert.equal(knn.k, 20)
    assert.equal(knn.num_candidates, 100)
    assert.deepEqual(knn.filter, [{ term: { status: 'active' } }, { term: { memory_type: 'fact' } }, ...freshOnlyFilters(NOW)])
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

describe('excludeMemoryTypes（阶段 7.1）', () => {
  const isExclude = (f: unknown): boolean =>
    JSON.stringify(f).includes('"must_not":[{"terms":{"memory_type":["identity"]}}]')

  test('传数组时生成排除条件，且排在状态之后、时效过滤之前', () => {
    const filters = buildFilters({ excludeMemoryTypes: ['identity'] })
    assert.deepEqual(filters[0], { term: { status: 'active' } })
    assert.ok(isExclude(filters[1]), '第二条就是排除条件')
    assert.equal(filters.length, 4, 'status + 排除 + 两条时效过滤')
  })

  test('传字符串也接受；空串与空数组不生成条件', () => {
    assert.ok(isExclude(buildFilters({ excludeMemoryTypes: 'identity' })[1]))
    assert.equal(buildFilters({ excludeMemoryTypes: '' }).some(isExclude), false, '空串 = 不排除')
    assert.equal(buildFilters({ excludeMemoryTypes: [] }).some(isExclude), false, '空数组 = 不排除')
    assert.equal(buildFilters({}).some(isExclude), false, '不传 = 不排除')
  })
})
