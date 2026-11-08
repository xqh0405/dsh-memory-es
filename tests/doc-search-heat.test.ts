/**
 * 阶段 28：doc_search 的命中热度回写（`last_accessed_at`）。
 *
 * 只钉三件事：
 *  · 命中后真的写了一次 `_bulk`，且只动 `last_accessed_at`；
 *  · 回写失败**不阻断检索**（热度是观测信号，不能拖累主流程）；
 *  · 没有 writer 时行为与从前完全一致（不写、不报错）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { searchDocs } from '../src/memory/doc-search.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const HIT = {
  _id: 'doc-7-0',
  _score: 5,
  _source: {
    doc_id: 'doc-7',
    title: '归档加密三选一',
    section_path: '存储 > 加密',
    content: '归档加密已扩成存储目标级三选一。',
  },
}

function baseDeps(url: string, extra: Record<string, unknown>) {
  return {
    userId: 'xqh',
    docPrefix: 'personal_doc_',
    reader: createEsClient({ url, username: 'mem-user-xqh', password: 'pw' }),
    embed: null,
    dims: 1024,
    retrieval: { rrfK: 60 },
    ...extra,
  }
}

/** 等 fire-and-forget 的回写落地（HTTP 往返需要一拍，不是 setImmediate 就够） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

test('命中后回写 last_accessed_at：一次 _bulk，只动这一个字段', async () => {
  const bulkBodies: string[] = []
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('_bulk')) {
      bulkBodies.push(req.body)
      const lines = req.body.split('\n').filter((l) => l.trim() !== '')
      sendJson(res, 200, {
        items: lines.filter((l) => l.startsWith('{') && l.includes('"update"')).map(() => ({ update: { status: 200, result: 'updated' } })),
      })
      return
    }
    sendJson(res, 200, { took: 1, hits: { total: { value: 1, relation: 'eq' }, hits: [HIT] } })
  })
  try {
    const writer = createEsClient({ url: fake.url, username: 'mem-writer', password: 'pw' })
    const deps = baseDeps(fake.url, { writer })
    const result = await searchDocs(deps as never, { query: '归档加密' })
    assert.equal(result.docs.length, 1, '检索结果不受回写影响')

    await settle()
    assert.equal(bulkBodies.length, 1, '应发一次 _bulk')
    assert.match(bulkBodies[0]!, /last_accessed_at/, '脚本只写 last_accessed_at')
    assert.match(bulkBodies[0]!, /doc-7-0/, '回写目标是命中的 chunk')
  } finally {
    await fake.close()
  }
})

test('回写失败不阻断检索：仍返回结果，只记一条降级日志', async () => {
  const events: Array<Record<string, unknown>> = []
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('_bulk')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'boom', reason: 'bulk down' } }))
      return
    }
    sendJson(res, 200, { took: 1, hits: { total: { value: 1, relation: 'eq' }, hits: [HIT] } })
  })
  try {
    const writer = createEsClient({ url: fake.url, username: 'mem-writer', password: 'pw' })
    const deps = baseDeps(fake.url, { writer, log: (e: Record<string, unknown>) => events.push(e) })
    const result = await searchDocs(deps as never, { query: '归档加密' })
    assert.equal(result.docs.length, 1, '检索必须照常返回')
    await settle()
    assert.ok(
      events.some((e) => String(e.event).includes('doc_hit_record_degraded')),
      `应记录降级日志，实际：${JSON.stringify(events)}`,
    )
  } finally {
    await fake.close()
  }
})

test('没有 writer 时完全不回写（老调用点不受影响）', async () => {
  const seen: string[] = []
  const fake = await startFakeEs((req, res) => {
    seen.push(req.path)
    sendJson(res, 200, { took: 1, hits: { total: { value: 1, relation: 'eq' }, hits: [HIT] } })
  })
  try {
    const deps = baseDeps(fake.url, {})
    const result = await searchDocs(deps as never, { query: '归档加密' })
    assert.equal(result.docs.length, 1)
    await settle()
    assert.ok(!seen.some((p) => p.includes('_bulk')), '不该有任何回写请求')
  } finally {
    await fake.close()
  }
})
