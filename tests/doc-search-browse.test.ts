/**
 * 阶段 31：`doc_search` 空 query = 按更新时间浏览最近 N 篇。
 *
 * 守四条：
 *  1. 空 query 不再抛错，按 `updated_at` 倒序返回；
 *  2. 浏览**不发 embedding、不走 BM25**（没有查询词，语义检索无意义，还白花一次推理）；
 *  3. 浏览**不回写 `last_accessed_at`** —— 否则 daily-report 的「90 天冷文档」会被自己翻一遍洗白；
 *  4. 同一篇的多个 chunk 仍然聚合成一条（与检索模式共用 assembleDocs）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { searchDocs, type DocSearchDeps } from '../src/memory/doc-search.ts'
import { createEsClient } from '../src/es/http.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const RETRIEVAL = { limit: 5, topK: 10, rrfK: 60, dims: 1024 } as never

function chunkBody(docId: string, title: string, section: string, content: string) {
  return { doc_id: docId, title, section_path: section, content, status: 'active', domain: 'general' }
}

async function startFake(searchHits: unknown[], record: { searches: unknown[]; updates: unknown[] }) {
  return startFakeEs((req, res) => {
    if (req.path.includes('/_search')) {
      record.searches.push(JSON.parse(req.body))
      sendJson(res, 200, { took: 1, hits: { total: { value: searchHits.length, relation: 'eq' }, hits: searchHits } })
      return
    }
    record.updates.push(JSON.parse(req.body))
    sendJson(res, 200, { _index: 'personal_doc_xqh', _id: 'x', result: 'updated' })
  })
}

function deps(url: string, overrides: Partial<DocSearchDeps> = {}): DocSearchDeps {
  return {
    userId: 'xqh',
    docPrefix: 'personal_doc_',
    reader: createEsClient({ url, username: 'r', password: 'p' }),
    writer: undefined,
    retrieval: RETRIEVAL,
    ...overrides,
  } as DocSearchDeps
}

describe('doc_search 空 query 浏览', () => {
  test('空 query 按 updated_at 倒序返回，且不抛错', async () => {
    const record = { searches: [] as unknown[], updates: [] as unknown[] }
    const fake = await startFake(
      [
        { _id: 'd1-0', _score: 1, _source: chunkBody('d1', '路线文档', '阶段 31', '最近改过的内容') },
        { _id: 'd2-0', _score: 1, _source: chunkBody('d2', '旧方案', '背景', '更早的内容') },
      ],
      record,
    )
    try {
      const result = await searchDocs(deps(fake.url), { query: '' })
      assert.equal(result.docs.length, 2)
      assert.equal(result.docs[0].title, '路线文档')
      const body = record.searches[0] as { sort?: unknown[]; query?: { bool?: { must?: unknown[] } } }
      assert.deepEqual(body.sort, [{ updated_at: { order: 'desc' } }], '浏览必须显式按更新时间排序')
      assert.equal(body.query?.bool?.must, undefined, '浏览不该带 BM25 must 子句')
    } finally {
      await fake.close()
    }
  })

  test('空 query 不发 embedding（没有查询词，语义检索无意义）', async () => {
    const record = { searches: [] as unknown[], updates: [] as unknown[] }
    const fake = await startFake([{ _id: 'd1-0', _score: 1, _source: chunkBody('d1', 't', 's', 'c') }], record)
    let embedded = 0
    try {
      const result = await searchDocs(deps(fake.url, { embed: { embed: async () => { embedded += 1; return [0.1] } } as never }), { query: '   ' })
      assert.equal(embedded, 0, '空 query 不该调用 embed')
      assert.equal(result.docs.length, 1)
      assert.equal(result.note, 'ok')
    } finally {
      await fake.close()
    }
  })

  test('浏览不写 last_accessed_at（否则冷文档口径会被浏览洗白）', async () => {
    const record = { searches: [] as unknown[], updates: [] as unknown[] }
    const fake = await startFake([{ _id: 'd1-0', _score: 1, _source: chunkBody('d1', 't', 's', 'c') }], record)
    try {
      const writer = createEsClient({ url: fake.url, username: 'w', password: 'p' })
      await searchDocs(deps(fake.url, { writer }), { query: '' })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(record.updates.length, 0, '浏览模式一次热度回写都不该发')
    } finally {
      await fake.close()
    }
  })

  test('同一篇多块仍聚合为一条（与检索模式共用聚合逻辑）', async () => {
    const record = { searches: [] as unknown[], updates: [] as unknown[] }
    const fake = await startFake(
      [
        { _id: 'd1-0', _score: 1, _source: chunkBody('d1', '同一篇', '第一节', 'a') },
        { _id: 'd1-1', _score: 1, _source: chunkBody('d1', '同一篇', '第二节', 'b') },
        { _id: 'd2-0', _score: 1, _source: chunkBody('d2', '另一篇', '一', 'c') },
      ],
      record,
    )
    try {
      const result = await searchDocs(deps(fake.url), { query: '' })
      assert.equal(result.docs.length, 2)
      const first = result.docs.find((d) => d.doc_id === 'd1')
      assert.equal(first?.hits, 2, '同一篇的两个 chunk 要合并计数')
    } finally {
      await fake.close()
    }
  })

  test('浏览到空库：note 用 ok、文案区分「还没有任何文档」', async () => {
    const record = { searches: [] as unknown[], updates: [] as unknown[] }
    const fake = await startFake([], record)
    try {
      const result = await searchDocs(deps(fake.url), { query: '' })
      assert.deepEqual(result.docs, [])
      assert.equal(result.note, 'ok', '空库浏览不是「没匹配到」')
      assert.match(result.text, /还没有任何文档/)
    } finally {
      await fake.close()
    }
  })
})
