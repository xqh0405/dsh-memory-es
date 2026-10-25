/**
 * embedding 客户端单测：走进程内假 HTTP 服务冒充 Ollama 的 `/api/embed`。
 * 覆盖正常路径、四种失败分类（config / unavailable / timeout / protocol / dims）与
 * 「维度不符必须报错」这条换模型相关的硬约束。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEmbedder, EmbeddingError } from '../src/embedding.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const DIMS = 8
const vector = (n: number) => Array.from({ length: n }, (_v, i) => Math.sin(i))

async function expectEmbeddingError(promise: Promise<unknown>, kind: EmbeddingError['kind']): Promise<EmbeddingError> {
  const err = await promise.then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(err instanceof EmbeddingError, `应当抛 EmbeddingError，实际：${String(err)}`)
  assert.equal(err.kind, kind)
  return err
}

describe('createEmbedder', () => {
  test('正常：POST /api/embed，body 是 {model, input}', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { embeddings: [vector(DIMS)] }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      const result = await embedder.embed('一条记忆')
      assert.equal(result.length, DIMS)
      assert.deepEqual(result, vector(DIMS))
      const sent = fake.requests[0]
      assert.equal(sent.method, 'POST')
      assert.equal(sent.path, '/api/embed')
      assert.deepEqual(JSON.parse(sent.body), { model: 'bge-m3', input: '一条记忆' })
    } finally {
      await fake.close()
    }
  })

  test('url 带尾部斜杠也不会拼出双斜杠', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { embeddings: [vector(DIMS)] }))
    try {
      const embedder = createEmbedder({ url: `${fake.url}/`, model: 'bge-m3', dims: DIMS })
      await embedder.embed('x')
      assert.equal(fake.requests[0].path, '/api/embed')
    } finally {
      await fake.close()
    }
  })

  test('维度与 dims 不符 → dims（换模型必须重建索引）', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { embeddings: [vector(4)] }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      const err = await expectEmbeddingError(embedder.embed('x'), 'dims')
      assert.ok(err.hint.includes('重建索引'))
    } finally {
      await fake.close()
    }
  })

  test('响应不是 JSON → protocol', async () => {
    const fake = await startFakeEs((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not ollama</html>')
    })
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      await expectEmbeddingError(embedder.embed('x'), 'protocol')
    } finally {
      await fake.close()
    }
  })

  test('响应缺 embeddings[0] → protocol', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { done: true }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      await expectEmbeddingError(embedder.embed('x'), 'protocol')
    } finally {
      await fake.close()
    }
  })

  test('向量里混进 null → protocol', async () => {
    const broken = vector(DIMS)
    broken[2] = null as unknown as number
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { embeddings: [broken] }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      await expectEmbeddingError(embedder.embed('x'), 'protocol')
    } finally {
      await fake.close()
    }
  })

  test('404（模型没 pull）→ config', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 404, { error: 'model not found' }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'no-such-model', dims: DIMS })
      const err = await expectEmbeddingError(embedder.embed('x'), 'config')
      assert.equal(err.status, 404)
    } finally {
      await fake.close()
    }
  })

  test('500 → unavailable', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 500, { error: 'boom' }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      await expectEmbeddingError(embedder.embed('x'), 'unavailable')
    } finally {
      await fake.close()
    }
  })

  test('端口没人监听 → unavailable', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, {}))
    const url = fake.url
    await fake.close()
    const embedder = createEmbedder({ url, model: 'bge-m3', dims: DIMS })
    await expectEmbeddingError(embedder.embed('x'), 'unavailable')
  })

  test('超时 → timeout', async () => {
    const fake = await startFakeEs((_req, res) => {
      setTimeout(() => sendJson(res, 200, { embeddings: [vector(DIMS)] }), 300)
    })
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS, timeoutMs: 80 })
      const started = Date.now()
      await expectEmbeddingError(embedder.embed('x'), 'timeout')
      assert.ok(Date.now() - started < 260, '超时应当立刻失败')
    } finally {
      await fake.close()
    }
  })
})

describe('createEmbedder 配置 fail-fast', () => {
  test('url 非法 → config', () => {
    assert.throws(
      () => createEmbedder({ url: 'not-a-url', model: 'bge-m3', dims: DIMS }),
      (err: unknown) => err instanceof EmbeddingError && err.kind === 'config',
    )
  })

  test('model 为空 / dims 非正整数 → config', () => {
    assert.throws(
      () => createEmbedder({ url: 'http://127.0.0.1:11434', model: '', dims: DIMS }),
      (err: unknown) => err instanceof EmbeddingError && err.kind === 'config',
    )
    assert.throws(
      () => createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 0 }),
      (err: unknown) => err instanceof EmbeddingError && err.kind === 'config',
    )
  })

  test('空文本 → config（调用方应先拦空内容）', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { embeddings: [vector(DIMS)] }))
    try {
      const embedder = createEmbedder({ url: fake.url, model: 'bge-m3', dims: DIMS })
      await expectEmbeddingError(embedder.embed('   '), 'config')
      assert.equal(fake.requests.length, 0, '空文本不该发请求')
    } finally {
      await fake.close()
    }
  })
})

describe('取消信号', () => {
  const base = { model: 'bge-m3', dims: 4 }

  test('已经 abort → 立刻抛 aborted 且不发请求', async () => {
    let hits = 0
    const fake = await startFakeEs((_req, res) => {
      hits += 1
      sendJson(res, 200, { embeddings: [[1, 0, 0, 0]] })
    })
    try {
      const embedder = createEmbedder({ ...base, url: fake.url })
      const controller = new AbortController()
      controller.abort()
      const err = await embedder.embed('x', { signal: controller.signal }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EmbeddingError)
      assert.equal(err.kind, 'aborted')
      assert.equal(hits, 0, '已取消就不该发请求')
    } finally {
      await fake.close()
    }
  })

  test('在途 abort → aborted（不是 timeout）', async () => {
    const fake = await startFakeEs(() => {
      /* 故意不回包 */
    })
    try {
      const embedder = createEmbedder({ ...base, url: fake.url, timeoutMs: 30_000 })
      const controller = new AbortController()
      const pending = embedder.embed('x', { signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      const err = await pending.then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EmbeddingError)
      assert.equal(err.kind, 'aborted', '外部取消不能误报成 timeout')
    } finally {
      await fake.close()
    }
  })
})
