/**
 * 阶段 36 · 跨用户隔离的机制断言。
 *
 * 「A 的 query 不得命中 B 的个人索引」在实现上的唯一保证是：
 * 检索的索引名必须由 `deps.userId` 拼出来，且**只**拼这一个。
 *
 * 为什么不用真机契约测：契约 runner 一次只持有一个账号的配置，
 * 而临时造第二个 ES 账号要改集群角色——为一条测试扩大权限面不划算。
 * 这里用进程内假 ES 直接观察请求路径，比「结果里没看到别人的 id」更强：
 * 只要路径里出现了别人的索引，测试立刻红，不依赖对方库里有没有数据。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { buildFilters } from '../src/es/dsl.ts'
import { DEFAULT_RANKING } from '../src/fragment.ts'
import { searchMemories, type RetrievalConfig, type SearchDeps } from '../src/memory/search.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const DIMS = 4
const retrieval: RetrievalConfig = { topK: 20, rrfK: 60, limit: 8 }

function doc(memoryId: string, content: string): Record<string, unknown> {
  return {
    memory_id: memoryId,
    content,
    memory_type: 'fact',
    domain: 'general',
    updated_at: '2026-10-20T00:00:00.000Z',
  }
}

/** 按索引名返回不同候选：个人索引给一条，团队索引给空 */
function startScopedFake() {
  return startFakeEs((req, res) => {
    const index = /^\/([^/]+)\/_search/.exec(req.path)?.[1] ?? ''
    const personal = index.startsWith('personal_memory_')
    sendJson(res, 200, {
      took: 1,
      hits: {
        total: { value: personal ? 1 : 0, relation: 'eq' },
        hits: personal
          ? [{ _id: 'm-1', _score: 10, _source: doc('m-1', '北单同步要逐位对拍赔率列') }]
          : [],
      },
    })
  })
}

function makeDeps(url: string, userId: string): SearchDeps {
  return {
    userId,
    personalPrefix: 'personal_memory_',
    teamIndex: 'team_knowledge',
    reader: createEsClient({ url, username: 'u', password: 'p' }),
    // 不传 embed：只走 BM25，少一次请求也不会让「索引名」这条断言变弱
    embed: null,
    dims: DIMS,
    retrieval,
    ranking: { ...DEFAULT_RANKING },
    now: () => new Date('2026-11-16T00:00:00Z'),
  }
}

describe('阶段 36：检索的索引作用域', () => {
  test('只查「自己的个人索引 + 团队索引」，路径里不出现别人的索引名', async () => {
    const fake = await startScopedFake()
    try {
      const deps = makeDeps(fake.url, 'alice')
      const result = await searchMemories(deps, { query: '北单 同步', scope: 'both', limit: 5 })

      const paths = fake.requests.map((r) => r.path)
      assert.ok(paths.length > 0, '应该有请求发生')
      for (const path of paths) {
        assert.match(path, /^\/(personal_memory_alice|team_knowledge)\/_search/)
      }
      // 换成 alice 之后，绝不能还带着别人的前缀
      assert.ok(!paths.some((p) => p.includes('personal_memory_xqh')), `出现了别人的索引：${paths.join(', ')}`)
      // 结果确实来自 alice 的索引
      assert.deepEqual(result.hits.map((h) => h.memory_id), ['m-1'])
    } finally {
      await fake.close()
    }
  })

  test('只查个人作用域时不碰团队索引', async () => {
    const fake = await startScopedFake()
    try {
      await searchMemories(makeDeps(fake.url, 'bob'), { query: '北单 同步', scope: 'personal', limit: 5 })
      const paths = fake.requests.map((r) => r.path)
      assert.ok(paths.every((p) => p.startsWith('/personal_memory_bob/_search')))
    } finally {
      await fake.close()
    }
  })
})

describe('阶段 36：失效条目不得被检索到（机制断言）', () => {
  test('检索请求的 filter 必须带 status=active', async () => {
    const fake = await startScopedFake()
    try {
      await searchMemories(makeDeps(fake.url, 'xqh'), { query: '北单 同步', scope: 'both', limit: 5 })
      const bodies = fake.requests.map((r) => JSON.parse(r.body) as {
        query?: { bool?: { filter?: unknown[] } }
      })
      assert.ok(bodies.length > 0, '应该有请求发生')
      for (const body of bodies) {
        const filters = JSON.stringify(body.query?.bool?.filter ?? [])
        assert.match(filters, /"status":"active"/, `请求里没有 status 过滤：${filters}`)
      }
    } finally {
      await fake.close()
    }
  })

  test('buildFilters 的默认值是 active；传 null 才放开（这道闸的唯一开关）', () => {
    assert.match(JSON.stringify(buildFilters({})), /"status":"active"/)
    assert.doesNotMatch(JSON.stringify(buildFilters({ status: null })), /"status"/)
  })
})
