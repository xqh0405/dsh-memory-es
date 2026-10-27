/**
 * `memory_search` 编排单测：用进程内假 ES 固定每一路的结果，验证
 * 两路并发 → 库内 RRF → 跨库加权合并/去重 → margin 判空 → 投影/截断。
 *
 * 重点守两条容易写错的语义：
 *  · margin 只用 kNN 原始 cosine，且**命中不足两条时不判空**（否则库里只有一条记忆就永远查不到）；
 *  · 向量不可用时只降级不报错，但 ES 报错必须**明确失败**（不做“猜到一半结果”）。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Embedder } from '../src/embedding.ts'
import { EmbeddingError } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import type { Hit } from '../src/fragment.ts'
import {
  defineSearchTool,
  MAX_RESULT_LIMIT,
  searchMemories,
  type RetrievalConfig,
  type SearchDeps,
} from '../src/memory/search.ts'
import { sendEsError, sendJson, startFakeEs, type CapturedRequest, type FakeEs } from './helpers/fake-es.ts'

const PERSONAL_INDEX = 'personal_memory_xqh'
const TEAM_INDEX = 'team_knowledge'
const DIMS = 4
const VECTOR = [0.1, 0.2, 0.3, 0.4]
const NOW = new Date('2026-10-25T12:00:00.000Z')

const retrieval: RetrievalConfig = { topK: 20, rrfK: 60, marginFloor: 0.05, limit: 8 }

function doc(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_id: `m-${id}`,
    content: `内容-${id}`,
    memory_type: 'fact',
    domain: 'lottery-cloud',
    updated_at: '2026-10-20T00:00:00.000Z',
    content_sha256: `hash-${id}`,
    ...extra,
  }
}

function hit(id: string, score: number, extra: Record<string, unknown> = {}): Hit {
  return { id, score, source: doc(id, extra) }
}

interface RouteData {
  bm25?: Hit[]
  knn?: Hit[]
}

interface Harness {
  fake: FakeEs
  requests: CapturedRequest[]
  /** 取某个索引、某一路（判定依据是 body 里有没有 knn）的请求体 */
  bodyOf(index: string, route: 'bm25' | 'knn'): Record<string, unknown> | undefined
  deps(overrides?: Partial<SearchDeps>): SearchDeps
}

async function harness(
  data: Record<string, RouteData>,
  options: { failIndex?: string } = {},
): Promise<Harness> {
  const fake = await startFakeEs((req, res) => {
    const index = /^\/([^/]+)\/_search/.exec(req.path)?.[1] ?? ''
    const body = JSON.parse(req.body) as Record<string, unknown>
    const route = 'knn' in body ? 'knn' : 'bm25'
    if (options.failIndex === index) {
      sendEsError(res, 404, 'index_not_found_exception', `no such index [${index}]`)
      return
    }
    const hits = data[index]?.[route] ?? []
    sendJson(res, 200, {
      took: 1,
      hits: {
        total: { value: hits.length, relation: 'eq' },
        hits: hits.map((item) => ({ _id: item.id, _score: item.score, _source: item.source })),
      },
    })
  })

  const reader = createEsClient({ url: fake.url, username: 'mem-reader-xqh', password: 'pw' })
  return {
    fake,
    requests: fake.requests,
    bodyOf(index, route) {
      const found = fake.requests.find((req) => {
        if (!req.path.startsWith(`/${index}/_search`)) return false
        const body = JSON.parse(req.body) as Record<string, unknown>
        return route === 'knn' ? 'knn' in body : !('knn' in body)
      })
      return found === undefined ? undefined : (JSON.parse(found.body) as Record<string, unknown>)
    },
    deps(overrides = {}) {
      return {
        userId: 'xqh',
        personalPrefix: 'personal_memory_',
        teamIndex: TEAM_INDEX,
        reader,
        embed: { embed: async () => VECTOR } satisfies Pick<Embedder, 'embed'>,
        dims: DIMS,
        retrieval,
        now: () => NOW,
        ...overrides,
      }
    },
  }
}

describe('searchMemories 编排', () => {
  test('both：两库各两路，共 4 次请求；个人库因权重排在前面', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.62)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 5)], knn: [hit('t1', 0.45)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: '北单中断开奖' })
      assert.equal(h.requests.length, 4, 'personal+team × (bm25+knn)')
      assert.equal(result.note, 'ok')
      assert.equal(result.degraded, false)
      assert.equal(result.filtered, false)
      assert.deepEqual(result.hits.map((item) => item.source), ['personal', 'team'])
      assert.equal(result.hits[0].memory_id, 'm-p1')
      assert.match(result.text, /^1\. \[personal·fact/)
    } finally {
      await h.fake.close()
    }
  })

  test('同一条被晋升到团队库（content_sha256 相同）只返回一次，且标为 personal', async () => {
    const shared = { content_sha256: 'same-hash' }
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3, shared)], knn: [hit('p1', 0.62, shared)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 9, shared)], knn: [hit('t1', 0.45, shared)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q' })
      assert.equal(result.hits.length, 1)
      assert.equal(result.hits[0].source, 'personal')
    } finally {
      await h.fake.close()
    }
  })

  test('kNN 前两名分数贴近（margin < 0.05）→ low_confidence，不返回半信半疑的结果', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3), hit('p2', 2)], knn: [hit('p1', 0.5), hit('p2', 0.49)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'low_confidence')
      assert.deepEqual(result.hits, [])
      assert.match(result.text, /区分度太低/)
    } finally {
      await h.fake.close()
    }
  })

  test('库里只有一条命中时不判空（margin 至少要两个分数才成立）', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.62)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'ok')
      assert.equal(result.hits.length, 1, '唯一一条也必须返回')
    } finally {
      await h.fake.close()
    }
  })

  test('两路都空 → no_match，并且文本明确说“没有找到”', async () => {
    const h = await harness({ [PERSONAL_INDEX]: {}, [TEAM_INDEX]: {} })
    try {
      const result = await searchMemories(h.deps(), { query: 'q' })
      assert.equal(result.note, 'no_match')
      assert.deepEqual(result.hits, [])
      assert.equal(result.text, '没有找到相关记忆。')
    } finally {
      await h.fake.close()
    }
  })

  test('embedding 失败 → 只走 BM25，degraded=true，不抛错', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.9)] } })
    try {
      const deps = h.deps({
        embed: {
          embed: async () => {
            throw new EmbeddingError('down', { kind: 'unavailable' })
          },
        },
      })
      const result = await searchMemories(deps, { query: 'q', scope: 'personal' })
      assert.equal(result.degraded, true)
      assert.equal(h.requests.length, 1, '只应有 BM25 一次请求')
      assert.equal('knn' in (JSON.parse(h.requests[0].body) as object), false)
      assert.equal(result.hits.length, 1)
    } finally {
      await h.fake.close()
    }
  })

  test('scope=personal 不碰团队索引；scope=team 不碰个人索引', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.62)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 3)], knn: [hit('t1', 0.62)] },
    })
    try {
      await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(h.requests.every((req) => req.path.startsWith(`/${PERSONAL_INDEX}/`)), true)

      h.requests.length = 0
      await searchMemories(h.deps(), { query: 'q', scope: 'team' })
      assert.equal(h.requests.every((req) => req.path.startsWith(`/${TEAM_INDEX}/`)), true)
    } finally {
      await h.fake.close()
    }
  })

  test('团队库兜底时间窗：没有任何收窄条件时补 365 天，filtered=false', async () => {
    const h = await harness({ [TEAM_INDEX]: { bm25: [hit('t1', 3)] } })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'team' })
      assert.equal(result.filtered, false)
      const body = h.bodyOf(TEAM_INDEX, 'bm25') as {
        query: { bool: { filter: Array<Record<string, unknown>> } }
      }
      const range = body.query.bool.filter.find((item) => 'range' in item)
      assert.ok(range, '应当带时间窗')
      const gte = (range as { range: { updated_at: { gte: string } } }).range.updated_at.gte
      assert.equal(gte, new Date(NOW.getTime() - 365 * 86_400_000).toISOString())
    } finally {
      await h.fake.close()
    }
  })

  test('给了 domain 就不再加兜底时间窗，filtered=true，且多值走 terms（团队库额外放行 general）', async () => {
    const h = await harness({ [TEAM_INDEX]: { bm25: [hit('t1', 3)] } })
    try {
      const result = await searchMemories(h.deps(), {
        query: 'q',
        scope: 'team',
        domain: ['lottery-cloud', 'backup-server'],
      })
      assert.equal(result.filtered, true)
      const body = h.bodyOf(TEAM_INDEX, 'bm25') as {
        query: { bool: { filter: Array<Record<string, unknown>> } }
      }
      assert.equal(body.query.bool.filter.some((item) => 'range' in item), false)
      // 按 domain 分层：团队库放行「本域 + general」，否则跨域通用知识永远看不到
      assert.deepEqual(
        body.query.bool.filter.find((item) => 'terms' in item),
        { terms: { domain: ['lottery-cloud', 'backup-server', 'general'] } },
      )
    } finally {
      await h.fake.close()
    }
  })

  test('time_range 解析成 updated_at 过滤（个人库也生效）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal', time_range: 'now-30d' })
      assert.equal(result.filtered, true)
      const body = h.bodyOf(PERSONAL_INDEX, 'bm25') as {
        query: { bool: { filter: Array<Record<string, unknown>> } }
      }
      const range = body.query.bool.filter.find((item) => 'range' in item) as {
        range: { updated_at: { gte: string } }
      }
      assert.equal(range.range.updated_at.gte, new Date(NOW.getTime() - 30 * 86_400_000).toISOString())
    } finally {
      await h.fake.close()
    }
  })

  test('limit 被夹到上限，size 跟着变（默认取配置）', async () => {
    const many = Array.from({ length: 30 }, (_v, i) => hit(`p${i}`, 3 - i * 0.01))
    const h = await harness({ [PERSONAL_INDEX]: { bm25: many } })
    try {
      const clamped = await searchMemories(h.deps(), { query: 'q', scope: 'personal', limit: 999 })
      assert.equal((h.bodyOf(PERSONAL_INDEX, 'bm25') as { size: number }).size, retrieval.topK)
      assert.equal(clamped.hits.length, MAX_RESULT_LIMIT)

      const defaults = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(defaults.hits.length, retrieval.limit)
    } finally {
      await h.fake.close()
    }
  })

  test('query 为空 / time_range 非法 → 抛错且不发请求', async () => {
    const h = await harness({})
    try {
      await assert.rejects(searchMemories(h.deps(), { query: '  ' }), /query 不能为空/)
      await assert.rejects(searchMemories(h.deps(), { query: 'q', time_range: 'last week' }), /time_range/)
      assert.equal(h.requests.length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('ES 出错 → 明确抛错（不返回残缺结果）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } }, { failIndex: TEAM_INDEX })
    try {
      await assert.rejects(searchMemories(h.deps(), { query: 'q' }), /index_not_found_exception/)
    } finally {
      await h.fake.close()
    }
  })

  test('日志不含 query 原文，只留统计', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } })
    const events: Record<string, unknown>[] = []
    try {
      await searchMemories(h.deps({ log: (event) => events.push(event) }), {
        query: '不该进日志的查询词-zzz',
        scope: 'personal',
      })
      assert.equal(JSON.stringify(events).includes('不该进日志的查询词'), false)
      assert.equal(events.length, 1)
      assert.equal(events[0].hits, 1)
    } finally {
      await h.fake.close()
    }
  })
})

describe('团队库审核闸（S9）：pending/rejected 不进检索', () => {
  /** bm25 的过滤在 query.bool.filter；knn 的过滤在顶层 knn.filter —— 两种形态分开取 */
  const filtersOf = (body: Record<string, unknown>, route: 'bm25' | 'knn'): unknown[] => {
    if (route === 'knn') return ((body.knn as { filter?: unknown[] } | undefined)?.filter ?? [])
    const query = body.query as { bool?: { filter?: unknown[] } } | undefined
    return query?.bool?.filter ?? []
  }
  const hasReviewGate = (filters: unknown[]): boolean =>
    filters.some((f) => JSON.stringify(f) === JSON.stringify({ terms: { review_state: ['auto', 'approved'] } }))

  test('团队库两路都带 review_state=[auto,approved]，个人库不带', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.9)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 3)], knn: [hit('t1', 0.8)] },
    })
    try {
      await searchMemories(h.deps(), { query: 'x' })
      for (const route of ['bm25', 'knn'] as const) {
      const team = h.bodyOf(TEAM_INDEX, route)
      const personal = h.bodyOf(PERSONAL_INDEX, route)
      assert.ok(team, `团队库 ${route} 请求应当发出`)
      assert.equal(hasReviewGate(filtersOf(team, route)), true, `团队库 ${route} 必须带审核闸`)
      // 个人索引没有 review_state 字段：带上这个过滤会查空，所以绝不能带
      assert.equal(
        JSON.stringify(personal).includes('review_state'),
        false,
          '个人库请求不能带 review_state 过滤',
        )
      }
    } finally {
      // 每个 harness 起一个假 ES 服务器；不关掉的话 node --test 不会退出（实测会挂到超时）
      await h.fake.close()
    }
  })

  test('scope=personal 时完全不查团队库（审核闸也就无从泄漏）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } })
    try {
      await searchMemories(h.deps(), { query: 'x', scope: 'personal' })
      assert.equal(h.bodyOf(TEAM_INDEX, 'bm25'), undefined)
    } finally {
      await h.fake.close()
    }
  })
})

describe('defineSearchTool', () => {
  test('参数与输出 schema 合法，execute 返回声明结构', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.7)] } })
    try {
      const def = defineSearchTool(h.deps())
      const parameters = def.parameters as { properties: Record<string, unknown> }
      assert.deepEqual(Object.keys(parameters.properties).sort(), [
        'domain',
        'limit',
        'memory_type',
        'query',
        'scope',
        'time_range',
      ])
      const value = (await def.execute({ query: 'q', scope: 'personal' }, {
        signal: new AbortController().signal,
      } as never)) as { hits: unknown[]; note: string; text: string }
      assert.equal(value.note, 'ok')
      assert.equal(value.hits.length, 1)
      const [block] = def.output.render({} as never, value as never)
      assert.equal((block as { text: string }).text.includes('内容-p1'), true)
    } finally {
      await h.fake.close()
    }
  })
})
