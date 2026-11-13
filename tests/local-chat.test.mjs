/**
 * 本地 chat 客户端（阶段 D）。
 *
 * 守 D2 的核心：**空正文必须判失败**，不能把空串当蒸馏结果写库。
 * 同时验证关闭时不发请求、请求体带「关思考」开关。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

const { createLocalChat, parseChatContent } = await import('../src/local-chat.ts')

const LOCAL = { baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: '' }

function cfg(overrides = {}) {
  return { enabled: true, model: 'qwen3-30b', timeoutMs: 500, ...overrides }
}

async function startGateway(handler) {
  const bodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push(body)
      handler(body, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies: () => bodies,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

test('关闭时不发请求（默认关的成本为零）', async () => {
  let fetched = 0
  const chat = createLocalChat(cfg({ enabled: false }), LOCAL, {
    fetchImpl: async () => {
      fetched += 1
      throw new Error('不该被调用')
    },
  })
  const result = await chat.complete({ system: 's', user: 'u', maxTokens: 10 })
  assert.equal(result.error, 'disabled')
  assert.equal(fetched, 0)
  assert.equal(chat.enabled, false)
})

test('baseUrl 为空 → 视为未配置', async () => {
  const chat = createLocalChat(cfg(), { baseUrl: '', apiKeyEnv: '' })
  assert.equal(chat.enabled, false)
  assert.equal((await chat.complete({ system: 's', user: 'u', maxTokens: 10 })).error, 'disabled')
})

test('正常返回正文，并在请求体里关掉思考（D2 前置）', async () => {
  const gateway = await startGateway((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '{"content":"改写后"}' } }] }))
  })
  try {
    const chat = createLocalChat(cfg(), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
    const result = await chat.complete({ system: '系统', user: '用户', maxTokens: 100 })
    assert.equal(result.text, '{"content":"改写后"}')
    assert.equal(gateway.bodies()[0].model, 'qwen3-30b')
    assert.deepEqual(gateway.bodies()[0].chat_template_kwargs, { enable_thinking: false })
    assert.equal(gateway.bodies()[0].stream, false)
  } finally {
    await gateway.close()
  }
})

test('空正文 → empty_content（绝不把空串当结果）', async () => {
  const gateway = await startGateway((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }))
  })
  try {
    const chat = createLocalChat(cfg(), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
    const result = await chat.complete({ system: 's', user: 'u', maxTokens: 10 })
    assert.equal(result.error, 'empty_content')
    assert.equal(chat.stats().failures, 1)
  } finally {
    await gateway.close()
  }
})

test('HTTP 500 → http（调用方回落云端）', async () => {
  const gateway = await startGateway((_body, res) => {
    res.writeHead(500)
    res.end('boom')
  })
  try {
    const chat = createLocalChat(cfg(), { baseUrl: gateway.baseUrl, apiKeyEnv: '' })
    assert.equal((await chat.complete({ system: 's', user: 'u', maxTokens: 10 })).error, 'http')
  } finally {
    await gateway.close()
  }
})

test('parseChatContent 对畸形响应返回 null', () => {
  assert.equal(parseChatContent({}), null)
  assert.equal(parseChatContent({ choices: [] }), null)
  assert.equal(parseChatContent({ choices: [{ message: { content: 123 } }] }), null)
  assert.equal(parseChatContent({ choices: [{ message: { content: 'ok' } }] }), 'ok')
})
