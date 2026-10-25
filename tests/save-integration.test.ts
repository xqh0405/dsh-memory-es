/**
 * `memory_save` 集成测试：真 ES + 真 Ollama（bge-m3），验证「写入 → 立刻可检索 →
 * 重复内容不重复写 → 向量服务不可用仍能存」这条闭环。
 *
 * 前提与纪律同 es-integration：`deploy/es/.env` 存在、只在回环实例写数据、
 * `domain=__save_it` 标记、before/after 用 elastic 清理并断言零残留。
 *
 * 关于「停掉 Ollama 验降级」：本机 Ollama 是共用的常驻服务，不为一次测试去停它；
 * 改成把 embedder 指向一个**没人监听的端口**，效果等价（都走 EmbeddingError →
 * degraded=true），且没有副作用。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { after, before, describe, test } from 'node:test'

import { createEmbedder, type Embedder } from '../src/embedding.ts'
import { bm25Body } from '../src/es/dsl.ts'
import { createEsClient } from '../src/es/http.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { countByDomain, deleteByDomain, getAdminDoc } from './helpers/es-admin.ts'
import { isLoopbackUrl, loadEsTestEnv, type EsTestEnv } from './helpers/es-env.ts'

const MARKER_DOMAIN = '__save_it'
const CONTENT = '集成测试记忆：北单中断开奖要同时写 win_price 与 win_price_practical。'
/** 故意用全角空格 + 多余空白，证明「归一化后哈希相同 → 命中去重」 */
const CONTENT_RESPELLED = '　集成测试记忆：北单中断开奖要同时写 win_price 与 win_price_practical。　'

const env = loadEsTestEnv()

if (!env) {
  test('memory_save 集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else if (!isLoopbackUrl(env.url)) {
  test('memory_save 集成测试', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
} else {
  defineSaveIntegration(env)
}

/** 找一个当前没人监听的端口，用来模拟「embedding 服务挂了」 */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 1
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  return port
}

function defineSaveIntegration(e: EsTestEnv): void {
  const reader = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
  const writer = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.writer })
  const embed = createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024, timeoutMs: 20_000 })

  let ollamaReady = false
  let firstMemoryId = ''

  const deps = (embedder: Pick<Embedder, 'embed'> | null): SaveDeps => ({
    userId: e.userId,
    personalPrefix: 'personal_memory_',
    defaultDomain: MARKER_DOMAIN,
    reader,
    writer,
    embed: embedder,
  })

  describe('真实实例：memory_save 闭环', () => {
    before(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      try {
        const probe = await embed.embed('探活')
        ollamaReady = probe.length === 1024
      } catch {
        ollamaReady = false
      }
    })

    after(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      const left = await countByDomain(e, e.personalIndex, MARKER_DOMAIN)
      assert.equal(left, 0, `清理后仍有 ${left} 条残留`)
    })

    test('写入正文 → deduped=false；Ollama 不可达时这一条会降级（用于隔离环境）', async (t) => {
      const result = await saveMemory(deps(ollamaReady ? embed : null), { content: CONTENT })
      firstMemoryId = result.memory_id
      assert.equal(result.deduped, false)
      assert.equal(result.degraded, ollamaReady === false)
      assert.equal(result.text, ollamaReady ? '已保存' : '已保存（向量服务不可用，仅关键词可检索）')
    })

    test('落库字段正确：注入 user_id、status=active、sha 64 位、向量 1024 维', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达，跳过需要真实向量的断言')
      const { status, source } = await getAdminDoc(e, e.personalIndex, firstMemoryId)
      assert.equal(status, 200)
      assert.ok(source)
      assert.equal(source.user_id, e.userId)
      assert.equal(source.status, 'active')
      assert.equal(source.domain, MARKER_DOMAIN)
      assert.equal(source.memory_type, 'fact')
      assert.match(String(source.content_sha256), /^[0-9a-f]{64}$/)
      assert.equal(String(source.content).trim(), CONTENT.trim())
      const vector = source.embedding
      assert.ok(Array.isArray(vector), '文档里应当有 embedding')
      assert.equal(vector.length, 1024)
      assert.equal(typeof vector[0], 'number')
      assert.ok(Number.isFinite(vector[0]))
    })

    test('BM25 立刻能搜到（refresh=wait_for 生效），且 _source 不回传向量', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达，写入已降级；BM25 用例由下一条单独覆盖')
      const res = await reader.search(e.personalIndex, bm25Body('中断开奖 win_price', { domain: MARKER_DOMAIN }, 5))
      const hit = res.hits.find((h) => h.id === firstMemoryId)
      assert.ok(hit, 'BM25 应命中刚写入的文档')
      assert.equal('embedding' in hit.source, false)
    })

    test('同一内容换写法（全角空格/多余空白）→ 命中去重，不重复写', async () => {
      const again = await saveMemory(deps(ollamaReady ? embed : null), { content: CONTENT_RESPELLED })
      assert.equal(again.deduped, true)
      assert.equal(again.memory_id, firstMemoryId, '命中去重应返回已有 id')
      assert.match(again.text, /未重复写入/)
      assert.equal(await countByDomain(e, e.personalIndex, MARKER_DOMAIN), 1, '库里应当只有一条')
    })

    test('embedding 服务不可达 → degraded=true，仍写入且 BM25 可检索', async () => {
      const port = await closedPort()
      const broken = createEmbedder({ url: `http://127.0.0.1:${port}`, model: 'bge-m3', dims: 1024, timeoutMs: 2_000 })
      const other = '集成测试：向量服务不可用时记忆仍应可写入并可关键词检索。'

      const result = await saveMemory(deps(broken), { content: other })
      assert.equal(result.deduped, false)
      assert.equal(result.degraded, true)
      assert.match(result.text, /向量服务不可用/)

      const { source } = await getAdminDoc(e, e.personalIndex, result.memory_id)
      assert.ok(source)
      assert.equal('embedding' in source, false, '降级时不应写 embedding 字段')

      const res = await reader.search(e.personalIndex, bm25Body('向量服务不可用', { domain: MARKER_DOMAIN }, 5))
      assert.ok(res.hits.some((h) => h.id === result.memory_id), '降级写入的文档也要能被 BM25 检索到')
    })
  })
}
