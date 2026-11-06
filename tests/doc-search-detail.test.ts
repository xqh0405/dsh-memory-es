/**
 * 阶段 23：doc_search 的分级读取（detail=full / summary）。
 *
 * 这里只钉一件事：**片段长度真的跟着 detail 走**。
 * 之前没有这个开关，模型想看「是不是这篇」也必须吃满 600 字/段，
 * 一页 5 篇就是 3000 字——而判断相关性其实 120 字就够。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { searchDocs } from '../src/memory/doc-search.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const LONG_CHUNK = '甲'.repeat(700)

test('detail=summary 每段只给 120 字，full 给 600 字', async () => {
  const fake = await startFakeEs((_req, res) => {
    sendJson(res, 200, {
      took: 1,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'doc-1-0',
            _score: 5,
            _source: {
              doc_id: 'doc-1',
              title: '优化路线',
              section_path: '阶段 20 > 预热',
              content: LONG_CHUNK,
            },
          },
        ],
      },
    })
  })

  try {
    const reader = createEsClient({ url: fake.url, username: 'mem-user-xqh', password: 'pw' })
    // embed=null → 走降级（只 BM25），不影响片段长度这条断言
    const deps = {
      userId: 'xqh',
      docPrefix: 'personal_doc_',
      reader,
      embed: null,
      dims: 1024,
      retrieval: { rrfK: 60 },
    }

    const full = await searchDocs(deps as never, { query: '预热' })
    const summary = await searchDocs(deps as never, { query: '预热', detail: 'summary' })

    assert.equal(full.docs.length, 1)
    assert.equal(full.docs[0].snippet.length, 600, 'full 仍是 600 字（默认行为不变）')
    assert.equal(summary.docs[0].snippet.length, 120, 'summary 只给 120 字')
    // 两路拿的是同一块内容，只是截断长度不同
    assert.equal(summary.docs[0].doc_id, full.docs[0].doc_id)
  } finally {
    await fake.close()
  }
})