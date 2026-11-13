/**
 * 本地推理网关客户端（阶段 A/B）。
 *
 * 守六条设计原则里的可测部分：
 *  · 关闭时**一次请求都不发**（不是发了再丢）；
 *  · 失败/超时/条数不符 → `scores: null`，绝不抛；
 *  · 连续失败到阈值后熔断，不再发请求；
 *  · 名次并入融合分**不改后验乘子的语义**（只加一路 RRF 同尺度项）。
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, test } from 'node:test'

import { blendRerankScores, type ScopedHit } from '../src/fragment.ts'
import { createReranker, endpointsOf, parseRerankResponse, type LocalModelsConfig, type RerankConfig } from '../src/local-models.ts'

const LOCAL: LocalModelsConfig = { baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: '' }

function cfg(overrides: Partial<RerankConfig> = {}): RerankConfig {
  return {
    enabled: true,
    model: 'reranker',
    candidates: 20,
    docChars: 300,
    timeoutMs: 300,
    failureThreshold: 3,
    scoreWeight: 1,
    logPath: '',
    ...overrides,
  }
}

/** 起一个假网关；`hits` 记录收到的请求体 */
async function startGateway(
  handler: (body: Record<string, unknown>, res: ServerResponse) => void,
): Promise<{ baseUrl: string; calls: () => number; close: () => Promise<void> }> {
  const hits: unknown[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      hits.push(body)
      handler(body, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls: () => hits.length,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

function hit(id: string, fusedScore: number, origin: 'personal' | 'team' = 'personal'): ScopedHit {
  return {
    id,
    score: 0,
    source: { content: id },
    routeRanks: [],
    fusedScore,
    origin,
    contentHash: id,
  } as unknown as ScopedHit
}

describe('endpointsOf', () => {
  test('同时接受根地址与 /v1 写法', () => {
    assert.deepEqual(endpointsOf('http://h:8080'), {
      rerank: 'http://h:8080/rerank',
      chat: 'http://h:8080/v1/chat/completions',
    })
    assert.deepEqual(endpointsOf('http://h:8080/v1/'), {
      rerank: 'http://h:8080/rerank',
      chat: 'http://h:8080/v1/chat/completions',
    })
  })

  test('空串与非法地址 → null（= 视为未配置）', () => {
    assert.equal(endpointsOf(''), null)
    assert.equal(endpointsOf('   '), null)
    assert.equal(endpointsOf('不是地址'), null)
  })
})

describe('关闭时零请求（原则 1/2）', () => {
  test('enabled=false 时即使 baseUrl 必失败也一次都不发', async () => {
    let fetched = 0
    const reranker = createReranker(cfg({ enabled: false }), LOCAL, {
      fetchImpl: (async () => {
        fetched += 1
        throw new Error('不应该被调用')
      }) as unknown as typeof fetch,
    })
    const result = await reranker.rerank('q', ['a', 'b'])
    assert.equal(result.scores, null)
    assert.equal(result.outcome, 'disabled')
    assert.equal(fetched, 0)
    assert.equal(reranker.enabled, false)
  })

  test('baseUrl 为空 → 视为未配置', async () => {
    const reranker = createReranker(cfg(), { baseUrl: '', apiKeyEnv: '' })
    assert.equal(reranker.enabled, false)
    const result = await reranker.rerank('q', ['a'])
    assert.equal(result.outcome, 'disabled')
  })

  test('构造期间不读凭据（credential ref 在调用时才解析）', () => {
    // 只要 createReranker 不抛，就说明没有去读 ~/.dsh/.credentials.yaml
    const reranker = createReranker(cfg(), { baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: '不存在的_REF_XYZ' })
    assert.equal(reranker.enabled, true)
  })
})

describe('正常调用', () => {
  test('按 index 对齐分数、带上 Authorization、拒绝跨条数不符', async () => {
    const gateway = await startGateway((body, res) => {
      const docs = body.documents as string[]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          results: docs.map((_, index) => ({ index, relevance_score: index === 1 ? 9 : -3 })),
        }),
      )
    })
    try {
      const seen: Array<{ url: string; auth: string | null }> = []
      const reranker = createReranker(cfg(), { baseUrl: gateway.baseUrl, apiKeyEnv: 'REF' }, {
        apiKey: () => 'k-123',
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen.push({ url, auth: new Headers(init.headers).get('authorization') })
          return fetch(url, init)
        }) as unknown as typeof fetch,
      })
      const result = await reranker.rerank('q', ['a', 'b'])
      assert.equal(result.outcome, 'ok')
      assert.deepEqual(result.scores, [-3, 9])
      assert.equal(gateway.calls(), 1)
      assert.match(seen[0]?.url ?? '', /\/rerank$/)
      assert.equal(seen[0]?.auth, 'Bearer k-123')
    } finally {
      await gateway.close()
    }
  })

  test('返回条数不符 → bad_shape，调用方按原序回落', async () => {
    const gateway = await startGateway((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }))
    })
    try {
      const reranker = createReranker(cfg(), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
      const result = await reranker.rerank('q', ['a', 'b'])
      assert.equal(result.scores, null)
      assert.equal(result.outcome, 'bad_shape')
    } finally {
      await gateway.close()
    }
  })

  test('HTTP 500 → http；不抛给调用方', async () => {
    const gateway = await startGateway((_body, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    try {
      const reranker = createReranker(cfg(), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
      const result = await reranker.rerank('q', ['a'])
      assert.equal(result.scores, null)
      assert.equal(result.outcome, 'http')
    } finally {
      await gateway.close()
    }
  })
})

describe('超时与熔断', () => {
  test('网关不回包 → timeout（单一总超时）', async () => {
    const gateway = await startGateway(() => {
      // 故意不 end：让客户端超时
    })
    try {
      const reranker = createReranker(cfg({ timeoutMs: 150 }), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
      const started = Date.now()
      const result = await reranker.rerank('q', ['a'])
      assert.equal(result.scores, null)
      assert.equal(result.outcome, 'timeout')
      // 不能等满好几秒才放弃
      assert.ok(Date.now() - started < 2_000)
    } finally {
      await gateway.close()
    }
  })

  test('连续失败到阈值 → 熔断，之后不再发请求', async () => {
    const gateway = await startGateway((_body, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    try {
      const reranker = createReranker(cfg({ failureThreshold: 3 }), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
      for (let i = 0; i < 3; i += 1) {
        const attempt = await reranker.rerank('q', ['a'])
        assert.equal(attempt.outcome, 'http')
      }
      assert.equal(gateway.calls(), 3)
      const after = await reranker.rerank('q', ['a'])
      assert.equal(after.outcome, 'tripped')
      assert.equal(gateway.calls(), 3, '熔断后不应再发请求')
      assert.equal(reranker.stats().tripped, true)
    } finally {
      await gateway.close()
    }
  })

  test('成功一次清零连续失败计数', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const gateway = await startGateway((body, res) => {
      if (mode === 'fail') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      const docs = body.documents as string[]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: docs.map((_, index) => ({ index, relevance_score: 1 })) }))
    })
    try {
      const reranker = createReranker(cfg({ failureThreshold: 3 }), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
      await reranker.rerank('q', ['a'])
      await reranker.rerank('q', ['a'])
      mode = 'ok'
      assert.equal((await reranker.rerank('q', ['a'])).outcome, 'ok')
      mode = 'fail'
      await reranker.rerank('q', ['a'])
      await reranker.rerank('q', ['a'])
      // 成功已把计数清零，第 3 次才熔断
      assert.equal(reranker.stats().tripped, false)
      await reranker.rerank('q', ['a'])
      assert.equal(reranker.stats().tripped, true)
    } finally {
      await gateway.close()
    }
  })
})

describe('parseRerankResponse', () => {
  test('允许网关多包一层 data', () => {
    assert.deepEqual(parseRerankResponse({ data: { results: [{ index: 0, relevance_score: 1.5 }] } }, 1), [1.5])
  })

  test('index 越界/重复/缺字段一律 null', () => {
    assert.equal(parseRerankResponse({ results: [{ index: 2, relevance_score: 1 }] }, 1), null)
    assert.equal(parseRerankResponse({ results: [{ relevance_score: 1 }] }, 1), null)
    assert.equal(parseRerankResponse({ results: [{ index: 0, relevance_score: 'x' }] }, 1), null)
    assert.equal(parseRerankResponse({ results: [] }, 1), null)
  })
})

describe('blendRerankScores（只并入名次，不混 logit）', () => {
  test('重排名次能改序，分数停在候选自己的区间内', () => {
    const hits = [hit('a', 0.0167), hit('b', 0.0164), hit('c', 0.0161)]
    // 重排认为 c 最相关、a 最不相关
    const blended = blendRerankScores(hits, [0, 1, 5], { weight: 1, rrfK: 60 })
    assert.deepEqual(blended.map((item) => item.id), ['c', 'b', 'a'])
    // 第 1 名拿区间上沿、末名拿下沿（不是 logit，也不越界）
    assert.ok(Math.abs((blended[0]?.fusedScore ?? 0) - 0.0167) < 1e-5)
    assert.ok(Math.abs((blended[2]?.fusedScore ?? 0) - 0.0161) < 1e-5)
  })

  test('后验乘子（±10%）能小幅调整名次', () => {
    const hits = [hit('a', 0.0167), hit('b', 0.0164), hit('c', 0.0161)]
    const blended = blendRerankScores(hits, [0, 1, 5], { weight: 1, rrfK: 60 })
    // c 第一、b 第二；1.1 的乘子足以让 b 反超 c（档距约 1.6%），但不能跨到第三之后
    const boosted = blended.map((item) => (item.id === 'b' ? { ...item, fusedScore: item.fusedScore * 1.1 } : item))
    boosted.sort((x, y) => y.fusedScore - x.fusedScore)
    assert.deepEqual(boosted.map((item) => item.id), ['b', 'c', 'a'])
  })

  test('weight=0 只记账不改排序', () => {
    const hits = [hit('a', 0.0167), hit('b', 0.0164)]
    const blended = blendRerankScores(hits, [0, 5], { weight: 0, rrfK: 60 })
    assert.deepEqual(blended.map((item) => item.id), ['a', 'b'])
  })

  test('只送前 N 条时，候选外的条目保持原分（可能被超过）', () => {
    const hits = [hit('a', 0.0167), hit('b', 0.0164), hit('outside', 0.0160)]
    // 只送 2 条，重排把 b 排第一、a 第二
    const blended = blendRerankScores(hits, [1, 9], { weight: 1, rrfK: 60 })
    assert.deepEqual(blended.map((item) => item.id), ['b', 'a', 'outside'])
    const outside = blended.find((item) => item.id === 'outside')
    assert.equal(outside?.fusedScore, 0.0160)
  })

  test('同分时保持原序（稳定）', () => {
    const hits = [hit('a', 0.01), hit('b', 0.01)]
    const blended = blendRerankScores(hits, [3, 3], { weight: 0.5, rrfK: 60 })
    assert.deepEqual(blended.map((item) => item.id), ['a', 'b'])
  })
})
