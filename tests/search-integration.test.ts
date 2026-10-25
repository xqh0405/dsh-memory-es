/**
 * `memory_search` 集成测试：真 ES + 真 Ollama，验证「写得进 → 换说法查得到 →
 * 噪声查询不给结果 → 降级仍可查」这条闭环。
 *
 * 与 save-integration 同一套纪律：只在回环实例写数据、`domain=__search_it` 标记、
 * before/after 用 elastic 清理并断言零残留。
 *
 * 另外：**所有查询都必须带 `domain: [MARKER_DOMAIN]`**。node --test 默认并发跑测试文件，
 * 别的集成文件会往同一个个人索引里写文档；不按域过滤的话 margin 判空与噪声用例会跟着抖
 * （2026-10-25 实测过一次 156/158 的假红，就是这么来的）。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { after, before, describe, test } from 'node:test'

import { createEmbedder, type Embedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { searchMemories, type SearchDeps } from '../src/memory/search.ts'
import { countByDomain, deleteByDomain } from './helpers/es-admin.ts'
import { isLoopbackUrl, loadEsTestEnv, type EsTestEnv } from './helpers/es-env.ts'

const MARKER_DOMAIN = '__search_it'
const RETRIEVAL = { topK: 20, rrfK: 60, marginFloor: 0.05, limit: 8 }

/** 三条主题互不相同的记忆，用来验“换说法也能命中”和“噪声不命中” */
const MEMORIES = [
  '北单中断开奖时，必须同时写 win_price 与 win_price_practical，否则按 practical 统计的中奖会是 0。',
  '发布流水线选错分支会白跑：生产 job 只认 main，测试 job 只认 test。',
  '本机 Ollama 停掉后，embedding 请求会直接 connection refused，写入要降级成纯关键词。',
]

const env = loadEsTestEnv()

if (!env) {
  test('memory_search 集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else if (!isLoopbackUrl(env.url)) {
  test('memory_search 集成测试', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
} else {
  defineSearchIntegration(env)
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 1
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  return port
}

function defineSearchIntegration(e: EsTestEnv): void {
  const reader = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
  const writer = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.writer })
  const embed = createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024, timeoutMs: 20_000 })

  let ollamaReady = false

  const saveDeps: SaveDeps = {
    userId: e.userId,
    personalPrefix: 'personal_memory_',
    defaultDomain: MARKER_DOMAIN,
    reader,
    writer,
    embed,
  }

  const searchDeps = (overrides: Partial<SearchDeps> = {}): SearchDeps => ({
    userId: e.userId,
    personalPrefix: 'personal_memory_',
    teamIndex: e.teamIndex,
    reader,
    embed,
    dims: 1024,
    retrieval: RETRIEVAL,
    ...overrides,
  })

  describe('真实实例：memory_search 闭环', () => {
    before(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      try {
        ollamaReady = (await embed.embed('探活')).length === 1024
      } catch {
        ollamaReady = false
      }
      // 并发写入：三条内容互不相同，去重不会互相干扰；wait_for 只等一轮 refresh
      await Promise.all(
        MEMORIES.map((content) => saveMemory(saveDeps, { content, domain: MARKER_DOMAIN, memory_type: 'fact' })),
      )
    })

    after(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      const left = await countByDomain(e, e.personalIndex, MARKER_DOMAIN)
      assert.equal(left, 0, `清理后仍有 ${left} 条残留`)
    })

    test('换说法也能命中（「比赛腰斩怎么结算」→ 北单中断开奖那条）', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达，语义召回无法验证')
      const result = await searchMemories(searchDeps(), { query: '比赛腰斩了怎么结算', domain: [MARKER_DOMAIN] })
      assert.equal(result.degraded, false)
      assert.equal(result.note, 'ok')
      assert.ok(result.hits.length >= 1, '至少要命中一条')
      assert.match(result.hits[0].content, /win_price_practical|中断开奖/)
    })

    test('精确标识符查询必中（接口名/字段名不改写）', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达')
      const result = await searchMemories(searchDeps(), { query: 'win_price_practical', domain: [MARKER_DOMAIN] })
      assert.ok(result.hits.some((hit) => hit.content.includes('win_price_practical')))
    })

    test('噪声查询不给结果（low_confidence 或 no_match，不硬凑）', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达')
      const result = await searchMemories(searchDeps(), { query: '量子比特退相干与超导薄膜的关系', domain: [MARKER_DOMAIN] })
      assert.ok(['low_confidence', 'no_match'].includes(result.note), `实际 note=${result.note}`)
      assert.deepEqual(result.hits, [])
    })

    test('返回结构是精简投影：字段齐全、没有 embedding、正文有上限', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达')
      const result = await searchMemories(searchDeps(), { query: '流水线分支选错', domain: [MARKER_DOMAIN], limit: 3 })
      assert.ok(result.hits.length >= 1)
      for (const hit of result.hits) {
        assert.deepEqual(Object.keys(hit).sort(), [
          'content',
          'domain',
          'memory_id',
          'memory_type',
          'score',
          'source',
          'updated_at',
        ])
        assert.ok(hit.content.length <= 501)
        assert.equal('embedding' in hit, false)
        assert.equal(hit.source, 'personal')
      }
      assert.match(result.text, /\[personal·fact·/)
    })

    test('scope=team 在空团队库上返回 no_match（不报错、也不越界读个人库）', async () => {
      const result = await searchMemories(searchDeps(), { query: '北单', scope: 'team', domain: [MARKER_DOMAIN] })
      assert.equal(result.note, 'no_match')
      assert.deepEqual(result.hits, [])
    })

    test('向量不可用 → 只走 BM25，degraded=true，仍能命中', async () => {
      const port = await closedPort()
      const broken = createEmbedder({ url: `http://127.0.0.1:${port}`, model: 'bge-m3', dims: 1024, timeoutMs: 2_000 })
      const result = await searchMemories(searchDeps({ embed: broken }), {
        query: 'win_price_practical',
        domain: [MARKER_DOMAIN],
      })
      assert.equal(result.degraded, true)
      assert.equal(result.note, 'ok')
      assert.ok(result.hits.some((hit) => hit.content.includes('win_price_practical')))
    })

    test('memory_type 过滤生效：查 preference 查不到这些 fact', async (t) => {
      if (!ollamaReady) return t.skip('Ollama 不可达')
      const result = await searchMemories(searchDeps(), {
        query: '北单中断开奖',
        domain: [MARKER_DOMAIN],
        memory_type: ['preference'],
      })
      assert.deepEqual(result.hits, [])
    })
  })
}
