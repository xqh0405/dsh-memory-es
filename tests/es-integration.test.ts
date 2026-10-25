/**
 * ES 集成测试：打真实实例（127.0.0.1:9200），验证 TLS CA + Basic Auth + 五个端点 + 错误映射。
 *
 * 前提：`deploy/es/.env` 存在（scripts/es-up.sh + init-security.sh 跑过）。
 * 缺少前提时**显式 skip 并打印原因**，不做成静默通过。
 *
 * 安全约束：
 *  · 写入类用例只在 `es.url` 指向本机回环时执行（别的机器上的 ES 不该被测试写）；
 *  · 测试文档统一打 `domain=__it` 标记，before/after 用 elastic 超级用户清理；
 *  · 断言只比对 kind/status/esType，**从不打印密码**。
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { after, before, describe, test } from 'node:test'

import { bm25Body, knnBody } from '../src/es/dsl.ts'
import { createEsClient, EsError, formatEsError } from '../src/es/http.ts'
import { normalizeContent, sha256Hex } from '../src/fragment.ts'
import type { EsTestEnv } from './helpers/es-env.ts'
import { isLoopbackUrl, loadEsTestEnv } from './helpers/es-env.ts'

const MARKER_DOMAIN = '__it'

/** 直接用 https 发一条请求：用于清理（elastic 超级用户）与健康检查，不经过被测客户端 */
function adminRequest(
  env: EsTestEnv,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; text: string }> {
  const target = new URL(path, env.url)
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  const ca = target.protocol === 'https:' ? readFileSync(env.caCertPath) : undefined
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8')
  const auth = `Basic ${Buffer.from(`${env.admin.username}:${env.admin.password}`, 'utf8').toString('base64')}`

  return new Promise((resolve, reject) => {
    const req = transport(
      target,
      {
        method,
        ca,
        headers: {
          authorization: auth,
          'content-type': 'application/json',
          ...(body ? { 'content-length': body.byteLength } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 删掉所有 domain=__it 的测试文档（幂等；索引不存在时忽略 404） */
async function cleanupTestDocs(env: EsTestEnv): Promise<void> {
  const res = await adminRequest(env, 'POST', `/${env.personalIndex}/_delete_by_query?refresh=true&conflicts=proceed`, {
    query: { term: { domain: MARKER_DOMAIN } },
  })
  if (res.status === 404) return
  assert.ok(res.status === 200, `清理失败：HTTP ${res.status}`)
}

const env = loadEsTestEnv()

if (!env) {
  test('ES 集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else {
  defineReadOnlyTests(env)
  if (isLoopbackUrl(env.url)) {
    defineReadWriteTests(env)
  } else {
    test('ES 读写集成', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
  }
}

/** 只读用例：任何部署都能跑（不写数据） */
function defineReadOnlyTests(e: EsTestEnv): void {
  describe('真实实例：TLS 与认证', () => {
    test('admin 能取到版本（说明自签 CA 校验通过）', async () => {
      const client = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.admin })
      const info = await client.info()
      assert.match(info.version.number, /^8\./)
    })

    test('密码错误 → auth（401），且错误信息不含密码', async () => {
      const wrongPassword = `${e.reader.password}-wrong`
      const client = createEsClient({
        url: e.url,
        caCertPath: e.caCertPath,
        username: e.reader.username,
        password: wrongPassword,
      })
      const err = await client.search(e.personalIndex, { size: 1 }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError, '应当抛 EsError')
      assert.equal(err.kind, 'auth')
      assert.equal(err.status, 401)
      assert.equal(err.esType, 'security_exception')
      assert.ok(!formatEsError(err).includes(wrongPassword), '错误信息不能带明文密码')
      assert.ok(formatEsError(err).includes('identity.readUsername'), '401 的提示要指向 identity 配置')
    })

    test('读者身份没有 cluster 权限：GET / 是 403（别拿 info() 当存活探针）', async () => {
      const client = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
      const err = await client.info().then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'permission')
      assert.equal(err.status, 403)
    })

    test('不给 CA（走系统信任库）→ tls 校验失败，不静默降级', async () => {
      const client = createEsClient({ url: e.url, caCertPath: '', ...e.admin })
      const err = await client.info().then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError, '应当抛 EsError')
      assert.equal(err.kind, 'tls')
      assert.ok(formatEsError(err).includes('caCertPath'), 'TLS 失败要指向 caCertPath')
    })
  })
}

/** 读写用例：只在回环实例上跑，用 domain=__it 标记并在前后清理 */
function defineReadWriteTests(e: EsTestEnv): void {
  const reader = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
  const writer = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.writer })
  const memoryId = randomUUID()
  const vector = Array.from({ length: 1024 }, (_v, i) => Math.sin(i))
  const content = '集成测试：ES 客户端层必须用自签 CA 校验 TLS，并用 Basic Auth 认证；向量只用于检索不回传。'
  const nowIso = new Date().toISOString()
  const doc: Record<string, unknown> = {
    memory_id: memoryId,
    user_id: e.userId,
    content,
    semantic_keywords: 'ES 客户端层 TLS Basic Auth 集成测试',
    embedding: vector,
    memory_type: 'fact',
    domain: MARKER_DOMAIN,
    privacy: 'normal',
    promote_state: 'none',
    status: 'active',
    content_sha256: sha256Hex(normalizeContent(content)),
    created_at: nowIso,
    updated_at: nowIso,
  }

  describe('真实实例：写入 / 检索 / 更新 / 错误映射', () => {
    before(async () => {
      await cleanupTestDocs(e)
      const written = await writer.index(e.personalIndex, doc, { id: memoryId, refresh: 'wait_for' })
      assert.equal(written.id, memoryId)
      assert.equal(written.result, 'created')
    })

    after(async () => {
      await cleanupTestDocs(e)
      // 清理必须真的清干净，否则下一次跑会被残留文档干扰
      const res = await adminRequest(e, 'POST', `/${e.personalIndex}/_search`, {
        size: 0,
        query: { term: { domain: MARKER_DOMAIN } },
      })
      assert.equal(res.status, 200)
      const total = (JSON.parse(res.text) as { hits: { total: { value: number } } }).hits.total.value
      assert.equal(total, 0, `清理后仍有 ${total} 条 domain=${MARKER_DOMAIN} 的残留文档`)
    })

    test('BM25 命中，且 _source 不回传 embedding（M2 判据）', async () => {
      const res = await reader.search(e.personalIndex, bm25Body('客户端层 TLS Basic Auth', {}, 5))
      const hit = res.hits.find((h) => h.id === memoryId)
      assert.ok(hit, 'BM25 应命中刚写入的文档')
      assert.equal('embedding' in hit.source, false, '_source 不应包含 embedding')
      assert.equal(hit.source.content, content)
    })

    test('kNN 命中（同一向量 → cosine 相似度接近 1）', async () => {
      const res = await reader.search(e.personalIndex, knnBody(vector, 1024, {}, 5))
      const hit = res.hits.find((h) => h.id === memoryId)
      assert.ok(hit, 'kNN 应命中刚写入的文档')
      assert.ok(hit.score > 0.99, `同一向量的相似度应接近 1，实测 ${hit.score}`)
      assert.equal('embedding' in hit.source, false)
    })

    test('get 按 id 取回原文', async () => {
      const got = await reader.get(e.personalIndex, memoryId)
      assert.equal(got.id, memoryId)
      assert.equal(got.source.content, content)
    })

    test('update 改 status 后状态生效，且默认检索（status=active）不再返回它', async () => {
      await writer.update(e.personalIndex, memoryId, { status: 'superseded', updated_at: new Date().toISOString() }, { refresh: 'wait_for' })
      const got = await reader.get(e.personalIndex, memoryId)
      assert.equal(got.source.status, 'superseded')

      const res = await reader.search(e.personalIndex, bm25Body('客户端层 TLS Basic Auth', {}, 5))
      assert.equal(
        res.hits.some((h) => h.id === memoryId),
        false,
        'status=superseded 的文档不应出现在 active 检索里',
      )

      // status: null 能把它翻出来（审计形态），证明是过滤生效而不是文档丢了
      const audit = await reader.search(e.personalIndex, bm25Body('客户端层 TLS Basic Auth', { status: null }, 5))
      assert.equal(audit.hits.some((h) => h.id === memoryId), true)
    })

    test('读者身份写入 → permission（403 security_exception）', async () => {
      const err = await reader.index(e.personalIndex, doc).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'permission')
      assert.equal(err.status, 403)
      assert.equal(err.esType, 'security_exception')
      assert.equal(err.attempts, 1, '403 不允许重试')
    })

    test('writer 写团队库 → permission（writer 的角色只覆盖 personal_memory_*）', async () => {
      const err = await writer.index(e.teamIndex, { content: 'x' }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'permission')
      assert.equal(err.status, 403)
    })

    test('get 不存在的文档 → not_found（404）', async () => {
      const err = await reader.get(e.personalIndex, 'definitely-not-here').then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'not_found')
      assert.equal(err.status, 404)
    })

    test('查不存在的索引 → not_found + index_not_found_exception，提示指向 init-indices.sh', async () => {
      const err = await writer.search(`${e.personalIndex}_nope`, { size: 1 }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'not_found')
      assert.equal(err.esType, 'index_not_found_exception')
      assert.ok(formatEsError(err).includes('init-indices.sh'))
    })

    test('update 不存在的文档 → not_found（document_missing_exception）', async () => {
      const err = await writer.update(e.personalIndex, 'definitely-not-here', { status: 'expired' }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'not_found')
      assert.equal(err.esType, 'document_missing_exception')
    })

    test('写入未映射字段 → bad_request（mapping 是 dynamic:strict，字段写错不会静默放过）', async () => {
      const err = await writer
        .index(e.personalIndex, { ...doc, memory_id: randomUUID(), __field_that_does_not_exist: 'x' })
        .then(
          () => null,
          (error: unknown) => error,
        )
      assert.ok(err instanceof EsError)
      assert.equal(err.kind, 'bad_request')
      assert.equal(err.status, 400)
      assert.equal(err.esType, 'strict_dynamic_mapping_exception')
      assert.ok(formatEsError(err).includes('dynamic:strict'), '400 的提示要指向 mapping 严格模式')
    })
  })
}
