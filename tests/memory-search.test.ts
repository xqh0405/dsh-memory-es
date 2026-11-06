/**
 * `memory_search` 编排单测：用进程内假 ES 固定每一路的结果，验证
 * 两路并发 → 库内 RRF → 跨库加权合并/去重 → 分层置信判定 → 投影/截断。
 *
 * 重点守两条容易写错的语义：
 *  · 置信判定用 kNN 原始 cosine + BM25 首条分（先绝对后相对），且**命中不足两条时不判空**；
 *  · 低置信**只标注、不丢弃**——丢信息的代价是模型以为没记过、转而凭印象编；
 *  · 向量不可用时只降级不报错，但 ES 报错必须**明确失败**（不做“猜到一半结果”）。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Embedder } from '../src/embedding.ts'
import { EmbeddingError } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import type { Hit } from '../src/fragment.ts'
import {
  DEFAULT_CONFIDENCE,
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

const retrieval: RetrievalConfig = { topK: 20, rrfK: 60, limit: 8 }

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
    // 阶段 20：命中回写走 `_bulk`。假 ES 不关心脚本内容，按条数回全成功。
    if (req.path.includes('/_bulk')) {
      const pairs = req.body.split('\n').filter((line) => line.trim() !== '').length / 2
      sendJson(res, 200, {
        items: Array.from({ length: pairs }, () => ({ update: { status: 200, result: 'updated' } })),
      })
      return
    }
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
  test('both：两库各两路（4 路查询合成 1 次往返）；个人库因权重排在前面', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 5)], knn: [hit('t1', 0.8)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: '北单中断开奖' })
      // 逻辑查询仍是 4 路；HTTP 往返被阶段 20 的 _msearch 合成 1 次
      assert.equal(h.requests.length, 4, 'personal+team × (bm25+knn)')
      assert.equal(h.fake.msearchCalls, 1, '4 路查询必须走一次 _msearch，而不是 4 次 search')
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
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3, shared)], knn: [hit('p1', 0.85, shared)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 9, shared)], knn: [hit('t1', 0.8, shared)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q' })
      assert.equal(result.hits.length, 1)
      assert.equal(result.hits[0].source, 'personal')
    } finally {
      await h.fake.close()
    }
  })

  test('top1 明显偏低 → low_confidence，但仍返回结果（不再丢弃）', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3), hit('p2', 2)], knn: [hit('p1', 0.5), hit('p2', 0.49)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'low_confidence')
      assert.equal(result.hits.length, 2, '低置信也要把候选给出去，让模型自己判断')
      assert.match(result.text, /相关性偏低/)
    } finally {
      await h.fake.close()
    }
  })

  test('top1 达到 autoPassTop1 → 即使 margin 很小也放行', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3), hit('p2', 2)], knn: [hit('p1', 0.85), hit('p2', 0.849)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'ok')
    } finally {
      await h.fake.close()
    }
  })

  test('中间区 margin 不够、但 BM25 够强 → 放行（关键词精确命中救回）', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 35), hit('p2', 2)], knn: [hit('p1', 0.78), hit('p2', 0.775)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'ok')
    } finally {
      await h.fake.close()
    }
  })

  test('中间区 margin 与 BM25 都不够 → 低置信，但仍返回', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 5), hit('p2', 4)], knn: [hit('p1', 0.78), hit('p2', 0.775)] },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'low_confidence')
      assert.ok(result.hits.length > 0, '低置信不等于空结果')
    } finally {
      await h.fake.close()
    }
  })

  test('向量不可用（降级）时不判低置信——没有依据就别判', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 2)] },
    })
    try {
      const result = await searchMemories(h.deps({ embed: null }), { query: 'q', scope: 'personal' })
      assert.equal(result.degraded, true)
      assert.equal(result.note, 'ok')
      assert.equal(result.hits.length, 1)
    } finally {
      await h.fake.close()
    }
  })

  test('importance=critical 在编排层生效（乘子确实接上了，不是死分支）', async () => {
    // 两路都是 p1 第一、p2 第二，RRF 分只差约 1.5%；p2 标 critical（×1.1）应当反超
    const h = await harness({
      [PERSONAL_INDEX]: {
        bm25: [hit('p1', 30), hit('p2', 29, { importance: 'critical' })],
        knn: [hit('p1', 0.7), hit('p2', 0.69, { importance: 'critical' })],
      },
    })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.hits[0].memory_id, 'm-p2', 'critical 的条目应被顶到第一')
    } finally {
      await h.fake.close()
    }
  })

  test('命中后回写热度（脚本 += 1），且不等待、不影响返回', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 30)], knn: [hit('p1', 0.9)] } })
    try {
      const deps = h.deps()
      const result = await searchMemories(
        { ...deps, hitRecorder: deps.reader as unknown as SearchDeps['hitRecorder'] },
        { query: 'q', scope: 'personal' },
      )
      assert.equal(result.note, 'ok')
      // 回写是 fire-and-forget：放一轮事件循环再断言
      await new Promise((r) => setTimeout(r, 30))
      // 阶段 20：真 EsClient 有 bulkUpdateScript，回写走一次 `_bulk`（不是逐条 `_update`）
      const updates = h.requests.filter((r) => r.path.includes('/_bulk'))
      assert.equal(updates.length, 1, '一条命中 → 一次 bulk 回写')
      assert.match(updates[0]!.body, /hit_count/)
      assert.match(updates[0]!.body, /last_hit_at/)
    } finally {
      await h.fake.close()
    }
  })

  test('不配 hitRecorder 就不回写（默认不产生写流量）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 30)], knn: [hit('p1', 0.9)] } })
    try {
      await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(h.requests.filter((r) => /\/_(update|bulk)\//.test(r.path)).length, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('库里只有一条命中时不判空（margin 至少要两个分数才成立）', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] },
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
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] },
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

  test('检索埋点：ok 分支写入 search_log_<uid>，字段可被直接聚合', async () => {
    const h = await harness({ [TEAM_INDEX]: { bm25: [hit('t1', 3)] } })
    const recorded: Array<{ index: string; doc: Record<string, unknown> }> = []
    try {
      await searchMemories(
        h.deps({
          recorder: {
            index: async (index: string, doc: Record<string, unknown>) => {
              recorded.push({ index, doc })
              return {} as never
            },
          },
          searchLogIndex: 'search_log_xqh',
        }),
        { query: '北单中断开奖', scope: 'team' },
      )
      assert.equal(recorded.length, 1, '一次检索记一条')
      assert.equal(recorded[0].index, 'search_log_xqh')
      const doc = recorded[0].doc
      assert.equal(doc.user_id, 'xqh')
      assert.equal(doc.tool, 'search')
      assert.equal(doc.query, '北单中断开奖')
      assert.equal(doc.scope, 'team')
      assert.equal(doc.note, 'ok')
      assert.equal(doc.hits, 1)
      assert.equal(doc.zero_hit, false)
      assert.equal(doc.degraded, false)
      assert.equal(typeof doc.ms, 'number')
      assert.match(String(doc.routes), /^team:bm25\+knn$/)
    } finally {
      await h.fake.close()
    }
  })

  test('检索埋点：空结果也要记（否则空结果率永远算不出来）', async () => {
    const h = await harness({ [TEAM_INDEX]: { bm25: [] } })
    const recorded: Array<Record<string, unknown>> = []
    try {
      const result = await searchMemories(
        h.deps({
          recorder: {
            index: async (_index: string, doc: Record<string, unknown>) => {
              recorded.push(doc)
              return {} as never
            },
          },
          searchLogIndex: 'search_log_xqh',
        }),
        { query: '不存在的主题', scope: 'team' },
      )
      assert.equal(result.note, 'no_match')
      assert.equal(recorded.length, 1)
      assert.equal(recorded[0].note, 'no_match')
      assert.equal(recorded[0].zero_hit, true)
      assert.equal(recorded[0].hits, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('检索埋点写失败不影响检索结果（观测通道不能变成单点故障）', async () => {
    const h = await harness({ [TEAM_INDEX]: { bm25: [hit('t1', 3)] } })
    try {
      const result = await searchMemories(
        h.deps({
          recorder: {
            index: async () => {
              throw new Error('security_exception: 403')
            },
          },
          searchLogIndex: 'search_log_xqh',
        }),
        { query: '北单中断开奖', scope: 'team' },
      )
      assert.equal(result.note, 'ok', '埋点挂了检索仍要成功')
      assert.equal(result.hits.length, 1)
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

describe('非事实类型（identity / persona / journal）默认不进检索', () => {
  /** 从 bm25 的 query.bool.filter 里取「排除了哪些 memory_type」 */
  const excludedTypes = (body: Record<string, unknown>): string[] => {
    const filters = (body.query as { bool?: { filter?: unknown[] } } | undefined)?.bool?.filter ?? []
    return filters
      .flatMap((f) => ((f as { bool?: { must_not?: unknown[] } }).bool?.must_not ?? []))
      .flatMap((m) => (m as { terms?: { memory_type?: string[] } }).terms?.memory_type ?? [])
  }

  test('默认三类全排除（persona 曾冒充事实排到第 1）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } })
    try {
      await searchMemories(h.deps(), { query: '先给结论', scope: 'personal' })
      const body = h.bodyOf(PERSONAL_INDEX, 'bm25')
      assert.ok(body, '个人库应当发出请求')
      assert.deepEqual(excludedTypes(body), ['identity', 'persona', 'journal'])
    } finally {
      await h.fake.close()
    }
  })

  test('显式选了 identity 时只放行它，另两类仍排除', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } })
    try {
      await searchMemories(h.deps(), { query: 'x', scope: 'personal', memory_type: ['identity'] })
      const body = h.bodyOf(PERSONAL_INDEX, 'bm25')
      assert.ok(body, '个人库应当发出请求')
      assert.deepEqual(excludedTypes(body), ['persona', 'journal'])
    } finally {
      await h.fake.close()
    }
  })

  test('显式选了 journal（补看某天的回顾）时，identity 与 persona 仍排除', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)] } })
    try {
      await searchMemories(h.deps(), { query: 'x', scope: 'personal', memory_type: ['journal'] })
      const body = h.bodyOf(PERSONAL_INDEX, 'bm25')
      assert.ok(body, '个人库应当发出请求')
      assert.deepEqual(excludedTypes(body), ['identity', 'persona'])
    } finally {
      await h.fake.close()
    }
  })
})

describe('defineSearchTool', () => {
  test('参数与输出 schema 合法，execute 返回声明结构', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] } })
    try {
      const def = defineSearchTool(h.deps())
      const parameters = def.parameters as { properties: Record<string, unknown> }
      assert.deepEqual(Object.keys(parameters.properties).sort(), [
        // 阶段 13：as_of 时间点回看（不传则不加过滤）
        'as_of',
        // 阶段 12：detail=summary 才砍正文（默认 full，行为不变）
        'detail',
        'domain',
        // 阶段 10：explain=true 才附回执（默认关，省 token）
        'explain',
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

describe('非事实类型门控（7.1 / 9.3 / 9.5）：默认不返回，显式选才放行', () => {
  const filtersOf = (body: Record<string, unknown>, route: 'bm25' | 'knn'): unknown[] => {
    if (route === 'knn') return ((body.knn as { filter?: unknown[] } | undefined)?.filter ?? [])
    const query = body.query as { bool?: { filter?: unknown[] } } | undefined
    return query?.bool?.filter ?? []
  }
  /** 取 must_not 里被排除的 memory_type（没有这个过滤时返回空数组） */
  const excludedOf = (filters: unknown[]): string[] =>
    filters
      .flatMap((f) => ((f as { bool?: { must_not?: unknown[] } }).bool?.must_not ?? []))
      .flatMap((m) => (m as { terms?: { memory_type?: string[] } }).terms?.memory_type ?? [])

  test('不传 memory_type：两路、两库都排除三类', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.9)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 3)], knn: [hit('t1', 0.8)] },
    })
    try {
      await searchMemories(h.deps(), { query: 'x' })
      for (const route of ['bm25', 'knn'] as const) {
        for (const index of [PERSONAL_INDEX, TEAM_INDEX]) {
          const body = h.bodyOf(index, route)
          assert.ok(body, `${index} ${route} 请求应当发出`)
          assert.deepEqual(
            excludedOf(filtersOf(body, route)),
            ['identity', 'persona', 'journal'],
            `${index} ${route} 应排除三类非事实记忆`,
          )
        }
      }
    } finally {
      await h.fake.close()
    }
  })

  test('显式选 identity：只放行它，persona/journal 仍排除', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.9)] },
      [TEAM_INDEX]: { bm25: [], knn: [] },
    })
    try {
      await searchMemories(h.deps(), { query: '我是怎么工作的', memory_type: ['identity'] })
      for (const route of ['bm25', 'knn'] as const) {
        const body = h.bodyOf(PERSONAL_INDEX, route)
        assert.ok(body, `${route} 请求应当发出`)
        assert.deepEqual(excludedOf(filtersOf(body!, route)), ['persona', 'journal'], `${route} 不该排除 identity`)
        // 仍然带着 memory_type 的收窄条件（单值 → term，不是 terms）
        assert.equal(JSON.stringify(body).includes('"term":{"memory_type":"identity"}'), true, `${route} 应带收窄`)
      }
    } finally {
      await h.fake.close()
    }
  })
})

describe('召回质量开关（2026-11-02，默认关）', () => {
  // 噪声形态：kNN 分数低且彼此贴近 → judgeConfidence 判 low
  const noisy = () => ({
    [PERSONAL_INDEX]: { bm25: [hit('n1', 11), hit('n2', 9)], knn: [hit('n1', 0.72), hit('n2', 0.711)] },
  })

  test('abstain 关（默认）：低置信照常返回结果并标注', async () => {
    const h = await harness(noisy())
    try {
      const result = await searchMemories(h.deps(), { query: 'PostgreSQL autovacuum 阈值', scope: 'personal' })
      assert.equal(result.note, 'low_confidence')
      assert.ok(result.hits.length > 0, '默认不拒答')
    } finally {
      await h.fake.close()
    }
  })

  test('abstain 开：低置信返回空，note=no_match（面板缺口清单会算成没答上）', async () => {
    const h = await harness(noisy())
    try {
      const result = await searchMemories(
        h.deps({ retrieval: { ...retrieval, abstainOnLowConfidence: true } }),
        { query: 'PostgreSQL autovacuum 阈值', scope: 'personal' },
      )
      assert.equal(result.note, 'no_match')
      assert.equal(result.hits.length, 0)
      assert.match(result.text, /拒答/)
    } finally {
      await h.fake.close()
    }
  })

  test('abstain 开但置信足够：照常返回（不能把真命中一起丢掉）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('ok1', 30)], knn: [hit('ok1', 0.86)] } })
    try {
      const result = await searchMemories(
        h.deps({ retrieval: { ...retrieval, abstainOnLowConfidence: true } }),
        { query: '北单 state 口径', scope: 'personal' },
      )
      assert.equal(result.hits.length, 1)
    } finally {
      await h.fake.close()
    }
  })

  // 实测（43 条契约）：只扩 BM25 时 should 失败仍是 10（零收益）；两路都扩才 10 → 8。
  // 所以这里钉的是「两路都吃扩展」，不是「只有词法路吃」。
  test('synonyms 两路都扩展：BM25 与向量都吃扩展词', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('s1', 20)], knn: [hit('s1', 0.8)] } })
    const embedded: string[] = []
    try {
      const deps = h.deps({
        retrieval: { ...retrieval, synonyms: { 告警: 'alert 告警规则' } },
        embed: {
          embed: async (text: string) => {
            embedded.push(text)
            return VECTOR
          },
        },
      })
      await searchMemories(deps, { query: '哪些告警归我发', scope: 'personal' })
      const bm25 = JSON.stringify(h.bodyOf(PERSONAL_INDEX, 'bm25'))
      assert.ok(bm25.includes('alert'), `BM25 没吃扩展词：${bm25}`)
      assert.ok(
        embedded.some((text) => text.includes('alert')),
        `向量路没吃扩展词：${JSON.stringify(embedded)}`,
      )
    } finally {
      await h.fake.close()
    }
  })

  // 2026-11-02 审计：scope=both 时只按个人库判置信，个人库两条窄候选会把团队库的强命中一起吞掉
  test('abstain 不会因为个人库噪声吞掉团队库的强命中（scope=both）', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('n1', 11), hit('n2', 9)], knn: [hit('n1', 0.72), hit('n2', 0.711)] },
      [TEAM_INDEX]: { bm25: [hit('t1', 40)], knn: [hit('t1', 0.95)] },
    })
    try {
      const result = await searchMemories(
        h.deps({ retrieval: { ...retrieval, abstainOnLowConfidence: true } }),
        { query: '哪些告警归我发', scope: 'both' },
      )
      assert.ok(result.hits.length > 0, '团队库有强命中就不该拒答')
      assert.ok(
        result.hits.some((hit) => hit.source === 'team'),
        `应保留团队命中：${JSON.stringify(result.hits.map((x) => x.source))}`,
      )
    } finally {
      await h.fake.close()
    }
  })

  test('abstain 拒答时也要写 search_log（面板缺口清单靠它）', async () => {
    const h = await harness({
      [PERSONAL_INDEX]: { bm25: [hit('n1', 11), hit('n2', 9)], knn: [hit('n1', 0.72), hit('n2', 0.711)] },
    })
    const docs: Array<Record<string, unknown>> = []
    try {
      await searchMemories(
        h.deps({
          retrieval: { ...retrieval, abstainOnLowConfidence: true },
          searchLogIndex: 'search_log_xqh',
          recorder: { index: async (_i: string, doc: Record<string, unknown>) => { docs.push(doc); return {} as never } },
        } as never),
        { query: 'PostgreSQL autovacuum 阈值', scope: 'personal' },
      )
      assert.equal(docs.length, 1, `应写一条埋点，实际 ${docs.length}`)
      assert.equal(docs[0]?.note, 'no_match')
      assert.equal(docs[0]?.hits, 0)
    } finally {
      await h.fake.close()
    }
  })

  test('synonyms 为空表时不改写（默认行为不变）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('x1', 20)], knn: [] } })
    const embedded: string[] = []
    try {
      await searchMemories(
        h.deps({ embed: { embed: async (text: string) => { embedded.push(text); return VECTOR } } }),
        { query: '哪些告警归我发', scope: 'personal' },
      )
      assert.ok(!JSON.stringify(h.bodyOf(PERSONAL_INDEX, 'bm25')).includes('alert'))
      assert.deepEqual(embedded, ['哪些告警归我发'], '空表时向量输入应与原句一致')
    } finally {
      await h.fake.close()
    }
  })
})

describe('阶段 13：as_of 入参', () => {
  test('非法日期直接报错（静默回落会让时间点回看骗人）', async () => {
    const h = await harness({})
    try {
      await assert.rejects(
        () => searchMemories(h.deps(), { query: 'q', scope: 'personal', as_of: '不是日期' }),
        /as_of 不是合法日期/,
      )
    } finally {
      await h.fake.close()
    }
  })

  test('合法 as_of 会进两路查询的过滤条件，并在结果里回显', async () => {
    const h = await harness({
      personal_memory_xqh: { bm25: [hit('m1', 5, { content: '一条事实' })], knn: [] },
    })
    try {
      const result = await searchMemories(h.deps(), {
        query: 'q',
        scope: 'personal',
        as_of: '2026-10-01T00:00:00.000Z',
        detail: 'full',
      })
      const body = h.bodyOf('personal_memory_xqh', 'bm25')
      assert.ok(JSON.stringify(body).includes('2026-10-01T00:00:00.000Z'), `过滤里没有 as_of：${JSON.stringify(body)}`)
      // 字段名必须与工具 output schema 一致（as_of）：
      // 曾返回 asOf，导致 DSH 的 additionalProperties:false 判整个结果非法（2026-11-02 修复）
      assert.equal(result.as_of, '2026-10-01T00:00:00.000Z')
      assert.equal('asOf' in result, false, '不应再出现 asOf 字段')
    } finally {
      await h.fake.close()
    }
  })

  test('只写日期的 as_of 按 Asia/Shanghai 当天 00:00 解释（不是 UTC 零点）', async () => {
    const h = await harness({
      personal_memory_xqh: { bm25: [hit('m1', 5, { content: '一条事实' })], knn: [] },
    })
    try {
      const result = await searchMemories(h.deps(), {
        query: 'q',
        scope: 'personal',
        as_of: '2026-10-01',
        detail: 'full',
      })
      // 北京 2026-10-01 00:00 = UTC 2026-09-30T16:00:00Z
      assert.equal(result.as_of, '2026-09-30T16:00:00.000Z')
    } finally {
      await h.fake.close()
    }
  })

  test('团队库的 as_of 过滤走 source_created_at（团队索引没有 created_at）', async () => {
    const h = await harness({
      team_knowledge: { bm25: [hit('t1', 5, { content: '团队事实', source_user: 'xqh' })], knn: [] },
    })
    try {
      await searchMemories(h.deps(), {
        query: 'q',
        scope: 'team',
        as_of: '2026-10-01T00:00:00.000Z',
        detail: 'full',
      })
      const body = JSON.stringify(h.bodyOf('team_knowledge', 'bm25'))
      assert.ok(body.includes('source_created_at'), `团队路没用 source_created_at：${body}`)
      assert.ok(!body.includes('"created_at"'), `团队路不该用 created_at：${body}`)
    } finally {
      await h.fake.close()
    }
  })
})

describe('命中回写：bulk 优先（阶段 20）', () => {
  test('有 bulk 能力时一次调用，不逐条', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] } })
    const bulkCalls: Array<readonly unknown[]> = []
    let singleCalls = 0
    try {
      await searchMemories(
        h.deps({
          hitRecorder: {
            updateScript: async () => {
              singleCalls += 1
              return { id: '', result: 'updated', status: 200 }
            },
            bulkUpdateScript: async (items) => {
              bulkCalls.push(items)
              return items.map((item) => ({ index: item.index, id: item.id, ok: true, status: 200 }))
            },
          },
        }),
        { query: '北单中断开奖' },
      )
      // 回写是 fire-and-forget，给它一个宏任务的机会
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.equal(bulkCalls.length, 1, '必须是 1 次 bulk')
      assert.equal(singleCalls, 0, '有 bulk 就不该再逐条打')
      assert.equal(bulkCalls[0]!.length, 1, '命中的 1 条要被写进 bulk')
    } finally {
      await h.fake.close()
    }
  })

  test('没有 bulk 能力时退回逐条（语义不变）', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] } })
    const single: string[] = []
    try {
      await searchMemories(
        h.deps({
          hitRecorder: {
            updateScript: async (index, id) => {
              single.push(`${index}/${id}`)
              return { id, result: 'updated', status: 200 }
            },
          },
        }),
        { query: '北单中断开奖' },
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.equal(single.length, 1, '没有 bulk 时必须逐条写')
      assert.match(single[0]!, /personal_memory_xqh\/p1/)
    } finally {
      await h.fake.close()
    }
  })
})


describe('阶段 21：中间区绝对下限（midBandFloor）', () => {
  // 0.73 是实测的闲聊档（「嗨！今天心情怎么样~」= 0.743、「在吗」= 0.7227）。
  // 这组数据刻意给了很大的 margin（0.23）和很高的 bm25（40）——
  // 旧逻辑一定判 ok，正是 7 条 noise 误报的成因。
  const fixtures = { [PERSONAL_INDEX]: { bm25: [hit('p1', 40), hit('p2', 1)], knn: [hit('p1', 0.73), hit('p2', 0.5)] } }

  test('闲聊档 0.73 直接判低置信，不再看 margin / bm25', async () => {
    const h = await harness(fixtures)
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'low_confidence')
      assert.ok(result.hits.length > 0, '低置信仍然返回结果，只是标注')
    } finally {
      await h.fake.close()
    }
  })

  test('midBandFloor=0 时回到旧行为（同一组数据判 ok）', async () => {
    const h = await harness(fixtures)
    try {
      const result = await searchMemories(
        h.deps({ confidence: { ...DEFAULT_CONFIDENCE, midBandFloor: 0 } }),
        { query: 'q', scope: 'personal' },
      )
      assert.equal(result.note, 'ok', '关掉闸门必须能精确回到旧行为')
    } finally {
      await h.fake.close()
    }
  })

  test('真相关档 0.85 不受影响', async () => {
    const h = await harness({ [PERSONAL_INDEX]: { bm25: [hit('p1', 3)], knn: [hit('p1', 0.85)] } })
    try {
      const result = await searchMemories(h.deps(), { query: 'q', scope: 'personal' })
      assert.equal(result.note, 'ok')
    } finally {
      await h.fake.close()
    }
  })
})
