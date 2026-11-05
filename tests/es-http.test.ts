/**
 * ES 传输层单测：配置 fail-fast、Basic Auth、错误映射、重试策略、响应归一化。
 *
 * 这一层不碰真实 ES（那是 es-integration.test.ts 的活），用进程内假 ES 把
 * 「真实实例造不出来」的场景（409 冲突、429 限流、5xx、超时、非 JSON）钉死。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient, EsError, formatEsError } from '../src/es/http.ts'
import { sendEsError, sendJson, startFakeEs } from './helpers/fake-es.ts'

const PASSWORD = 'pw-not-to-leak-123'

describe('createEsClient 配置 fail-fast', () => {
  const base = { url: 'https://127.0.0.1:9200', username: 'u', password: PASSWORD }

  test('非法 URL → config', () => {
    assert.throws(
      () => createEsClient({ ...base, url: 'not-a-url' }),
      (err: unknown) => err instanceof EsError && err.kind === 'config',
    )
  })

  test('URL 里内嵌凭证 → config（否则会随错误信息泄漏出去）', () => {
    assert.throws(
      () => createEsClient({ ...base, url: 'https://u:p@127.0.0.1:9200' }),
      (err: unknown) => err instanceof EsError && err.kind === 'config',
    )
  })

  test('用户名/密码为空 → config', () => {
    assert.throws(
      () => createEsClient({ ...base, password: '' }),
      (err: unknown) => err instanceof EsError && err.kind === 'config',
    )
  })

  test('CA 文件不存在 → config（加载期就炸，不留到第一次写记忆）', () => {
    assert.throws(
      () => createEsClient({ ...base, caCertPath: 'deploy/es/certs/__missing__.crt' }),
      (err: unknown) => err instanceof EsError && err.kind === 'config',
    )
  })

  test('超时非法 → config', () => {
    assert.throws(
      () => createEsClient({ ...base, requestTimeoutMs: 0 }),
      (err: unknown) => err instanceof EsError && err.kind === 'config',
    )
  })
})

describe('Basic Auth 与请求形态', () => {
  test('发的是 Basic 头，且内容不含明文密码', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { ok: true }))
    try {
      const client = createEsClient({ url: fake.url, username: 'mem-writer', password: PASSWORD })
      await client.search('idx', { size: 1 })
      const sent = fake.requests[0]
      const expected = `Basic ${Buffer.from(`mem-writer:${PASSWORD}`, 'utf8').toString('base64')}`
      assert.equal(sent.headers.authorization, expected)
      assert.equal(sent.method, 'POST')
      assert.equal(sent.path, '/idx/_search')
      assert.equal(sent.headers['content-type'], 'application/json')
      // 头里是 base64，不代表“看得见”就是安全；这里只断言错误信息不外带凭证
    } finally {
      await fake.close()
    }
  })

  test('index 带 id 用 PUT、不带 id 用 POST；refresh 与 op_type 进 query', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 201, { _id: 'd1', result: 'created' }))
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      await client.index('personal_memory_xqh', { memory_id: 'd1' }, { id: 'd1', refresh: 'wait_for' })
      await client.index('personal_memory_xqh', { memory_id: 'd2' }, { opType: 'create' })
      assert.equal(fake.requests[0].method, 'PUT')
      assert.equal(fake.requests[0].path, '/personal_memory_xqh/_doc/d1?refresh=wait_for')
      assert.equal(fake.requests[1].method, 'POST')
      assert.equal(fake.requests[1].path, '/personal_memory_xqh/_doc?op_type=create')
      assert.deepEqual(JSON.parse(fake.requests[0].body), { memory_id: 'd1' })
    } finally {
      await fake.close()
    }
  })

  test('update 用 _update 端点、body 是 {doc}', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { _id: 'd1', result: 'updated' }))
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      await client.update('personal_memory_xqh', 'd1', { status: 'superseded' }, { refresh: 'wait_for' })
      assert.equal(fake.requests[0].path, '/personal_memory_xqh/_update/d1?refresh=wait_for')
      assert.deepEqual(JSON.parse(fake.requests[0].body), { doc: { status: 'superseded' } })
    } finally {
      await fake.close()
    }
  })

  test('search 归一化：total 对象形态 + _source 原样带出', async () => {
    const fake = await startFakeEs((_req, res) =>
      sendJson(res, 200, {
        took: 7,
        hits: {
          total: { value: 42, relation: 'eq' },
          hits: [{ _id: 'd1', _score: 1.25, _source: { content: 'x' } }],
        },
      }),
    )
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const result = await client.search('idx', { size: 1 })
      assert.equal(result.took, 7)
      assert.equal(result.total, 42)
      assert.deepEqual(result.hits, [{ id: 'd1', score: 1.25, source: { content: 'x' } }])
    } finally {
      await fake.close()
    }
  })
})

describe('错误映射（不重试的那几类）', () => {
  const cases: Array<{ status: number; type: string; kind: EsError['kind'] }> = [
    { status: 401, type: 'security_exception', kind: 'auth' },
    { status: 403, type: 'security_exception', kind: 'permission' },
    { status: 404, type: 'index_not_found_exception', kind: 'not_found' },
    { status: 400, type: 'strict_dynamic_mapping_exception', kind: 'bad_request' },
    { status: 500, type: 'internal_server_error', kind: 'server' },
    { status: 503, type: 'unavailable_shards_exception', kind: 'server' },
  ]

  for (const item of cases) {
    test(`HTTP ${item.status} → ${item.kind}，只发一次请求`, async () => {
      const fake = await startFakeEs((_req, res) => sendEsError(res, item.status, item.type, 'boom'))
      try {
        const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
        const err = await client.search('idx', { size: 1 }).then(
          () => null,
          (e: unknown) => e,
        )
        assert.ok(err instanceof EsError, '应当抛 EsError')
        assert.equal(err.kind, item.kind)
        assert.equal(err.status, item.status)
        assert.equal(err.esType, item.type)
        assert.equal(err.attempts, 1, '这一类不允许重试')
        assert.equal(fake.requests.length, 1)
        // 给模型看的文字要带提示，且不能带凭证
        const text = formatEsError(err)
        assert.ok(text.includes(err.hint), 'formatEsError 应包含提示')
        assert.ok(!text.includes(PASSWORD), '错误信息不能带明文密码')
      } finally {
        await fake.close()
      }
    })
  }

  test('404 且无 error 体（缺文档形态）也能映射', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 404, { _index: 'idx', _id: 'nope', found: false }))
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const err = await client.get('idx', 'nope').then(
        () => null,
        (e: unknown) => e,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'not_found')
      assert.equal(err.esType, undefined)
    } finally {
      await fake.close()
    }
  })

  test('200 但响应不是 JSON → protocol', async () => {
    const fake = await startFakeEs((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>proxy error</html>')
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const err = await client.info().then(
        () => null,
        (e: unknown) => e,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'protocol')
    } finally {
      await fake.close()
    }
  })
})

describe('重试策略（只有 409 与 429，各一次）', () => {
  test('409 → 重试一次后成功', async () => {
    const fake = await startFakeEs((_req, res, seq) => {
      if (seq === 1) sendEsError(res, 409, 'version_conflict_engine_exception', 'conflict')
      else sendJson(res, 200, { _id: 'd1', result: 'updated' })
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const result = await client.update('idx', 'd1', { status: 'expired' })
      assert.equal(result.result, 'updated')
      assert.equal(fake.requests.length, 2)
    } finally {
      await fake.close()
    }
  })

  test('409 连续两次 → conflict，attempts=2，正好两次请求', async () => {
    const fake = await startFakeEs((_req, res) =>
      sendEsError(res, 409, 'version_conflict_engine_exception', 'conflict'),
    )
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const err = await client.update('idx', 'd1', { status: 'expired' }).then(
        () => null,
        (e: unknown) => e,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'conflict')
      assert.equal(err.attempts, 2)
      assert.equal(fake.requests.length, 2)
    } finally {
      await fake.close()
    }
  })

  test('429 → 退避 200ms 后重试一次（实测间隔 ≥180ms）', async () => {
    const fake = await startFakeEs((_req, res, seq) => {
      if (seq === 1) sendEsError(res, 429, 'circuit_breaking_exception', 'too many requests')
      else sendJson(res, 200, { took: 1, hits: { total: { value: 0, relation: 'eq' }, hits: [] } })
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      await client.search('idx', { size: 1 })
      assert.equal(fake.requests.length, 2)
      const gap = fake.requests[1].at - fake.requests[0].at
      assert.ok(gap >= 180, `退避间隔应 ≥180ms，实测 ${gap}ms`)
    } finally {
      await fake.close()
    }
  })

  test('超时 → timeout，不重试', async () => {
    const fake = await startFakeEs((_req, res) => {
      setTimeout(() => sendJson(res, 200, {}), 300)
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD, requestTimeoutMs: 80 })
      const started = Date.now()
      const err = await client.search('idx', { size: 1 }).then(
        () => null,
        (e: unknown) => e,
      )
      assert.ok(err instanceof EsError, '超时应抛 EsError')
      assert.equal(err.kind, 'timeout')
      assert.equal(err.attempts, 1)
      assert.equal(fake.requests.length, 1)
      assert.ok(Date.now() - started < 250, '超时应当立刻失败，而不是等对端返回')
    } finally {
      await fake.close()
    }
  })

  test('端口没人监听 → network，不重试', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, {}))
    const url = fake.url
    await fake.close()
    const client = createEsClient({ url, username: 'u', password: PASSWORD, requestTimeoutMs: 500 })
    const err = await client.info().then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof EsError)
    assert.equal(err.kind, 'network')
    assert.equal(err.attempts, 1)
  })
})

describe('取消信号（exec.signal 一路传到请求）', () => {
  function env() {
    return {
      url: 'http://es.example:9200',
      username: 'mem-reader-xqh',
      password: 'pw',
      caCertPath: '',
    }
  }

  test('外部 abort → EsError kind=aborted，且不重试（不会变成 network）', async () => {
    // 服务器收到请求后不回包，让请求一直挂着
    const fake = await startFakeEs(() => {
      /* 故意不响应 */
    })
    try {
      const client = createEsClient({ ...env(), url: fake.url, requestTimeoutMs: 30_000 })
      const controller = new AbortController()
      const pending = client.search('personal_memory_xqh', { size: 1 }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      const err = await pending.then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'aborted', '取消不能被归到 network/timeout')
      // attempts=1 表示「只发了一次、没有重试」（取消不在 RETRY_DELAY_MS 里）
      assert.equal(err.attempts, 1, '取消不该重试')
      assert.equal(fake.requests.length, 1, '取消后不应再发第二次请求')
    } finally {
      await fake.close()
    }
  })

  test('已经 abort 的 signal → 立刻失败（不发请求）', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { hits: { total: 0, hits: [] } }))
    try {
      const client = createEsClient({ ...env(), url: fake.url })
      const controller = new AbortController()
      controller.abort()
      const err = await client
        .search('personal_memory_xqh', { size: 1 }, { signal: controller.signal })
        .then(() => null, (error: unknown) => error)
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'aborted')
    } finally {
      await fake.close()
    }
  })
})

describe('_msearch（阶段 20）', () => {
  test('按 NDJSON 发，按顺序返回；只发一次 HTTP', async () => {
    const fake = await startFakeEs((req, res) => {
      const index = /^\/([^/]+)\/_search/.exec(req.path)?.[1] ?? ''
      const body = JSON.parse(req.body) as { size?: number }
      sendJson(res, 200, {
        took: 2,
        hits: {
          total: { value: 1, relation: 'eq' },
          hits: [{ _id: `${index}-1`, _score: body.size ?? 0, _source: { from: index } }],
        },
      })
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const results = await client.msearch([
        { index: 'personal_memory_xqh', body: { size: 1 } },
        { index: 'team_knowledge', body: { size: 2 } },
      ])

      assert.equal(fake.msearchCalls, 1, '两条子查询必须只走一次往返')
      assert.equal(results.length, 2)
      assert.equal(results[0]!.hits[0]!.id, 'personal_memory_xqh-1')
      assert.equal(results[1]!.hits[0]!.id, 'team_knowledge-1')
      assert.deepEqual(results[1]!.hits[0]!.source, { from: 'team_knowledge' })
    } finally {
      await fake.close()
    }
  })

  test('空请求不发 HTTP，直接返回空数组', async () => {
    const fake = await startFakeEs(() => undefined)
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      assert.deepEqual(await client.msearch([]), [])
      assert.equal(fake.requests.length, 0)
    } finally {
      await fake.close()
    }
  })

  test('单条报错 → 整体抛，错误里带子查询下标与索引名', async () => {
    const fake = await startFakeEs((req, res) => {
      if (req.path.includes('team_knowledge')) {
        sendEsError(res, 404, 'index_not_found_exception', 'no such index [team_knowledge]')
        return
      }
      sendJson(res, 200, { took: 1, hits: { total: { value: 0, relation: 'eq' }, hits: [] } })
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      await assert.rejects(
        () =>
          client.msearch([
            { index: 'personal_memory_xqh', body: { size: 1 } },
            { index: 'team_knowledge', body: { size: 1 } },
          ]),
        (err: unknown) =>
          err instanceof EsError
          && err.kind === 'not_found'
          && err.message.includes('msearch[1]')
          && err.message.includes('team_knowledge'),
      )
    } finally {
      await fake.close()
    }
  })

  test('响应条数与请求不一致 → protocol（错位合并比报错难查得多）', async () => {
    // 这里必须绕过「拆开再拼」的默认行为，否则造不出畸形响应
    const fake = await startFakeEs(
      (_req, res) => sendJson(res, 200, { responses: [{ hits: { total: 0, hits: [] } }] }),
      { rawMsearch: true },
    )
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      await assert.rejects(
        () =>
          client.msearch([
            { index: 'a', body: {} },
            { index: 'b', body: {} },
          ]),
        (err: unknown) => err instanceof EsError && err.kind === 'protocol',
      )
    } finally {
      await fake.close()
    }
  })
})

describe('_bulk 命中回写（阶段 20）', () => {
  test('一次往返更新多条；部分失败只体现在结果里，不抛', async () => {
    const fake = await startFakeEs((req, res) => {
      const pairs = req.body.split('\n').filter((line) => line.trim() !== '').length / 2
      sendJson(res, 200, {
        items: Array.from({ length: pairs }, (_, i) => ({
          update:
            i === 0
              ? { status: 200, result: 'updated' }
              : { status: 404, error: { type: 'document_missing_exception', reason: 'missing doc' } },
        })),
      })
    })
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      const results = await client.bulkUpdateScript([
        { index: 'personal_memory_xqh', id: 'a', script: { source: 'ctx._source.hit_count += 1' } },
        { index: 'team_knowledge', id: 'b', script: { source: 'ctx._source.hit_count += 1' } },
      ])

      assert.equal(fake.requests.length, 1, '两条更新必须只走一次 HTTP')
      assert.equal(results.length, 2)
      assert.equal(results[0]!.ok, true)
      assert.equal(results[1]!.ok, false)
      assert.equal(results[1]!.status, 404)
      assert.match(results[1]!.error ?? '', /missing doc/)
    } finally {
      await fake.close()
    }
  })

  test('空数组不发请求', async () => {
    const fake = await startFakeEs(() => undefined)
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: PASSWORD })
      assert.deepEqual(await client.bulkUpdateScript([]), [])
      assert.equal(fake.requests.length, 0)
    } finally {
      await fake.close()
    }
  })
})
