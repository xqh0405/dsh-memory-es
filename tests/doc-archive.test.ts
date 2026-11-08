/**
 * 阶段 29：文档归档、冷引用、容量闸、检索默认只查 active。
 *
 * 四条断言对应 29.2 的验收：
 *  · 默认检索不带归档（否则「归档」只是贴了个标签）；
 *  · includeArchived 时**不加 status 条件**（不是加 active+archived，那会漏掉没有该字段的老文档）；
 *  · 归档写冷引用，且 content 里带 doc_id（否则找不回来）；
 *  · 容量超限拒绝写入；autoArchive 默认关。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config } from '../src/config.ts'
import { createEsClient } from '../src/es/http.ts'
import { archiveDoc, assertDocCapacity, readDocCapacity, restoreDoc } from '../src/memory/doc-archive.ts'
import { searchDocs } from '../src/memory/doc-search.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const SLICES = [
  { _id: 'doc-9-0', _score: 5, _source: { doc_id: 'doc-9', title: '归档加密三选一', domain: 'backup-server', chunk_total: 2, source_paths: ['/docs/a.md'] } },
  { _id: 'doc-9-1', _score: 4, _source: { doc_id: 'doc-9', title: '归档加密三选一', domain: 'backup-server', chunk_total: 2, source_paths: ['/docs/a.md'] } },
]

function depsFor(url: string, extra: Record<string, unknown> = {}) {
  const client = createEsClient({ url, username: 'mem-user-xqh', password: 'pw' })
  return {
    userId: 'xqh',
    docPrefix: 'personal_doc_',
    reader: client,
    writer: client,
    ...extra,
  }
}

test('归档：全部切片改 archived，并写一条带 doc_id 的冷引用', async () => {
  const scripts: Array<{ source?: string }> = []
  const coldRefs: Array<{ content: string; domain: string }> = []
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('_search')) {
      sendJson(res, 200, { took: 1, hits: { total: { value: SLICES.length }, hits: SLICES } })
      return
    }
    if (req.path.includes('_bulk')) {
      // _bulk 的 body 是 ndjson：每两行一条（action + source），action 行带 update.script
      const items = []
      for (const line of String(req.body).split('\n')) {
        const text = line.trim()
        if (!text.startsWith('{')) continue
        const obj = JSON.parse(text)
        // action 行（含 update）带 _index/_id，payload 行才是 {script} —— 只认后者
        if (obj.script) {
          scripts.push(obj)
          items.push({ update: { status: 200, result: 'updated' } })
        }
      }
      sendJson(res, 200, { took: 1, errors: false, items })
      return
    }
    if (req.path.includes('_update/')) {
      scripts.push(JSON.parse(req.body))
      sendJson(res, 200, { result: 'updated' })
      return
    }
    sendJson(res, 200, {})
  })
  try {
    const result = await archiveDoc(
      depsFor(fake.url, {
        saveColdRef: async (input: { content: string; domain: string }) => {
          coldRefs.push(input)
          return { status: 'created', memory_id: 'cold-1', deduped: false, degraded: false, quarantined: false, text: 'ok' }
        },
      }) as never,
      { docId: 'doc-9', reason: '容量清理' },
    )
    assert.equal(result.chunks, 2, '两个切片都要改')
    assert.equal(scripts.length, 2)
    assert.ok(scripts.every((s: any) => String(s.script?.source ?? s.update?.script?.source).includes('archived')), '状态改成 archived')
    assert.equal(result.coldMemoryId, 'cold-1')
    assert.equal(coldRefs.length, 1, '必须留冷引用')
    assert.match(coldRefs[0]!.content, /doc-9/, '冷引用正文必须带 doc_id')
    assert.match(coldRefs[0]!.content, /includeArchived/, '要告诉人怎么找回')
    assert.equal(coldRefs[0]!.domain, 'backup-server', '沿用文档自己的 domain')
  } finally {
    await fake.close()
  }
})

test('恢复：全部切片改回 active', async () => {
  const scripts: Array<{ source?: string }> = []
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('_search')) {
      sendJson(res, 200, { took: 1, hits: { total: { value: SLICES.length }, hits: SLICES } })
      return
    }
    if (req.path.includes('_bulk')) {
      // _bulk 的 body 是 ndjson：每两行一条（action + source），action 行带 update.script
      const items = []
      for (const line of String(req.body).split('\n')) {
        const text = line.trim()
        if (!text.startsWith('{')) continue
        const obj = JSON.parse(text)
        // action 行（含 update）带 _index/_id，payload 行才是 {script} —— 只认后者
        if (obj.script) {
          scripts.push(obj)
          items.push({ update: { status: 200, result: 'updated' } })
        }
      }
      sendJson(res, 200, { took: 1, errors: false, items })
      return
    }
    if (req.path.includes('_update/')) {
      scripts.push(JSON.parse(req.body))
      sendJson(res, 200, { result: 'updated' })
      return
    }
    sendJson(res, 200, {})
  })
  try {
    const result = await restoreDoc(depsFor(fake.url) as never, { docId: 'doc-9' })
    assert.equal(result.chunks, 2)
    assert.ok(scripts.every((s: any) => String(s.script?.source ?? s.update?.script?.source).includes("'active'")))
  } finally {
    await fake.close()
  }
})

test('冷引用写失败不回滚归档，但要留下 note（否则是「失踪」）', async () => {
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('_search')) {
      sendJson(res, 200, { took: 1, hits: { total: { value: 1 }, hits: [SLICES[0]] } })
      return
    }
    if (req.path.includes('_bulk')) {
      const items = String(req.body)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l))
        .filter((o) => o.script)
        .map(() => ({ update: { status: 200, result: 'updated' } }))
      sendJson(res, 200, { took: 1, errors: false, items })
      return
    }
    sendJson(res, 200, { result: 'updated' })
  })
  try {
    const result = await archiveDoc(
      depsFor(fake.url, { saveColdRef: async () => { throw new Error('写开关关着') } }) as never,
      { docId: 'doc-9' },
    )
    assert.equal(result.chunks, 1, '归档本身要成功')
    assert.equal(result.coldMemoryId, undefined)
    assert.match(String(result.note), /冷引用写入失败/)
  } finally {
    await fake.close()
  }
})

test('容量闸：超限抛错且提示先归档', async () => {
  const fake = await startFakeEs((_req, res) => {
    sendJson(res, 200, {
      took: 1,
      hits: { total: { value: 4000 } },
      aggregations: { docs: { value: 500 }, chars: { value: 4_000_000 } }, // 4M 字符 ≈ 12 MiB
    })
  })
  try {
    const deps = depsFor(fake.url) as never
    const cap = await readDocCapacity(deps, 10 * 1024 * 1024)
    assert.equal(cap.overLimit, true, '12 MiB 应判定超限')
    assert.equal(cap.activeDocs, 500)
    await assert.rejects(() => assertDocCapacity(deps, 10 * 1024 * 1024), /先归档旧文档/)
    // limitBytes=0 = 不限，永不超限
    const unlimited = await readDocCapacity(deps, 0)
    assert.equal(unlimited.overLimit, false)
  } finally {
    await fake.close()
  }
})

test('autoArchive 默认关（自动归档会改「搜得到什么」，必须人决定）', () => {
  const cfg = Config({} as never)
  assert.equal(cfg.doc.autoArchive, false)
  assert.equal(cfg.doc.limitBytes, 10 * 1024 * 1024)
})

test('doc_search 默认带 status=active；includeArchived 时完全不加 status 条件', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const fake = await startFakeEs((req, res) => {
    bodies.push(JSON.parse(req.body))
    sendJson(res, 200, { took: 1, hits: { total: { value: 0 }, hits: [] } })
  })
  try {
    const deps = {
      userId: 'xqh',
      docPrefix: 'personal_doc_',
      reader: createEsClient({ url: fake.url, username: 'mem-user-xqh', password: 'pw' }),
      embed: null,
      dims: 1024,
      retrieval: { topK: 20, rrfK: 60, limit: 5 },
    }
    bodies.length = 0
    await searchDocs(deps as never, { query: '归档' })
    const plain = JSON.stringify(bodies[0])
    assert.match(plain, /"status":"active"/, '默认只查 active')

    bodies.length = 0
    await searchDocs(deps as never, { query: '归档', includeArchived: true })
    const deep = JSON.stringify(bodies[0])
    assert.ok(!deep.includes('"status"'), 'includeArchived 时不加 status 条件（老文档没这个字段也不会被漏掉）')
  } finally {
    await fake.close()
  }
})
