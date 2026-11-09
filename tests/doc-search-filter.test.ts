/**
 * 阶段 27#4 收尾：doc_search 的两条缺口用例（空结果、域过滤）。
 *
 * 为什么单独立文件：既有的 doc-search-detail / doc-search-heat 分别钉「分级」与
 * 「热度回写」，本文件只钉**检索条件本身**——空结果不能抛错（模型会当成工具失效）、
 * domain 必须真的进过滤条件（写在参数里但没进 DSL 是静默失效，回的全部域）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { searchDocs } from '../src/memory/doc-search.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const EMPTY = { took: 1, hits: { total: { value: 0, relation: 'eq' }, hits: [] } }

/**
 * embed 默认给一个假向量：不传时 note 会落成 degraded（向量不可用优先于 no_match），
 * 那样测不出「真的没找到」。要测降级路径就显式传 embed: null。
 */
function depsFor(url: string, opts: { embed?: null } = {}) {
  const embed = opts.embed === null
    ? null
    : { embed: async () => new Array(1024).fill(0) }
  return {
    userId: 'xqh',
    docPrefix: 'personal_doc_',
    reader: createEsClient({ url, username: 'mem-user-xqh', password: 'pw' }),
    embed,
    dims: 1024,
    retrieval: { rrfK: 60 },
  } as never
}

test('空结果：命中 0 条时返回空列表且不抛错', async () => {
  const fake = await startFakeEs((_req, res) => sendJson(res, 200, EMPTY))
  try {
    const result = await searchDocs(depsFor(fake.url), { query: '库里绝对没有的东西' })
    assert.deepEqual(result.docs, [], '没有命中时 docs 应为空数组')
    assert.equal(result.note, 'no_match', '空结果要落 note=no_match，让模型知道是「没找到」而不是「工具坏了」')
    assert.equal(result.degraded, false, '这条路径向量可用，不该被标成降级')
    assert.equal(result.text, '没有找到相关文档。', 'text 要给可读的空结果说明')
    // 关键：不能抛错。抛错会让模型以为工具坏了，而不是「没找到」
  } finally {
    await fake.close()
  }
})

test('域过滤：domain 参数真的进了查询条件', async () => {
  const fake = await startFakeEs((_req, res) => sendJson(res, 200, EMPTY))
  try {
    await searchDocs(depsFor(fake.url), { query: '阶段', domain: ['lottery-cloud', 'huoxin-data'] })

    const body = JSON.parse(fake.requests[0]?.body ?? '{}') as {
      query?: { bool?: { filter?: Array<{ terms?: { domain?: string[] } }> } }
    }
    const filter = body.query?.bool?.filter ?? []
    const domainFilters = filter.filter((item) => Array.isArray(item.terms?.domain))
    assert.equal(domainFilters.length, 1, 'domain 必须以 terms 过滤条件的形式出现一次')
    assert.deepEqual(
      domainFilters[0]?.terms?.domain,
      ['lottery-cloud', 'huoxin-data'],
      '域列表要原样下发，不能被截断或改写',
    )
  } finally {
    await fake.close()
  }
})

test('不传 domain 时不该出现 domain 过滤（否则等于默认只查一个域）', async () => {
  const fake = await startFakeEs((_req, res) => sendJson(res, 200, EMPTY))
  try {
    await searchDocs(depsFor(fake.url), { query: '阶段' })

    const body = JSON.parse(fake.requests[0]?.body ?? '{}') as {
      query?: { bool?: { filter?: Array<{ terms?: { domain?: unknown } }> } }
    }
    const filter = body.query?.bool?.filter ?? []
    assert.equal(
      filter.some((item) => item.terms?.domain !== undefined),
      false,
      '无 domain 时不得带 domain 条件',
    )
  } finally {
    await fake.close()
  }
})
test('向量不可用时优先标 degraded（不是 no_match），两者不能混为一谈', async () => {
  const fake = await startFakeEs((_req, res) => sendJson(res, 200, EMPTY))
  try {
    const result = await searchDocs(depsFor(fake.url, { embed: null }), { query: '库里没有的东西' })
    assert.equal(result.docs.length, 0)
    assert.equal(result.degraded, true, '走 BM25 单路的降级要如实标记')
    assert.equal(result.note, 'degraded', 'degraded 优先于 no_match：否则通道问题会被当成「没找到」')
  } finally {
    await fake.close()
  }
})
