/**
 * 阶段 9：`memory_save` 的准入落库行为（用进程内假 ES 走真实 HTTP）。
 *
 * 断言的三件事，都是「代码写得对但线上会错」的地方：
 *  1. 隔离是**写进库**（status=quarantine）而不是丢弃 → 面板审得到、可以恢复；
 *  2. 隔离条目**不花一次向量调用**、也不建边 → 否则每次误触发都白烧一次 embedding；
 *  3. `similar_to` 只提示不阻塞 → 同义改写是值钱的，不能一刀切判重。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const FIXED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const NOW = new Date('2026-11-01T12:00:00.000Z')
const DIMS = 4
const VECTOR = [0.1, 0.2, 0.3, 0.4]

interface FakeState {
  neighbors: Array<{ memoryId: string; score: number }>
  existingRelated: unknown
}

async function startAdmissionFake(state: Partial<FakeState> = {}): Promise<{
  fake: FakeEs
  state: FakeState
  written: Record<string, unknown>[]
  requests: number
}> {
  const resolved: FakeState = { neighbors: [], existingRelated: [], ...state }
  const written: Record<string, unknown>[] = []
  const counter = { requests: 0 }

  const fake = await startFakeEs((req, res) => {
    counter.requests += 1

    if (req.path.includes('/_search')) {
      const body = JSON.parse(req.body || '{}') as { knn?: unknown }
      // 去重查询（sha term）与 kNN 查询共用 /_search：按 body 是否带 knn 区分
      if (body.knn !== undefined) {
        sendJson(res, 200, {
          took: 1,
          hits: {
            total: { value: resolved.neighbors.length, relation: 'eq' },
            hits: resolved.neighbors.map((item) => ({
              _id: item.memoryId,
              _score: item.score,
              _source: { memory_id: item.memoryId },
            })),
          },
        })
        return
      }
      sendJson(res, 200, { took: 1, hits: { total: { value: 0, relation: 'eq' }, hits: [] } })
      return
    }

    if (req.method === 'GET' && req.path.includes('/_doc/')) {
      sendJson(res, 200, {
        _id: FIXED_ID,
        _index: 'personal_memory_xqh',
        _source: { related: resolved.existingRelated },
      })
      return
    }

    if (req.method === 'PUT' && req.path.includes('/_doc/')) {
      written.push(JSON.parse(req.body) as Record<string, unknown>)
      sendJson(res, 201, { _id: FIXED_ID, result: 'created' })
      return
    }

    if (req.method === 'POST' && req.path.includes('/_update/')) {
      sendJson(res, 200, { _id: FIXED_ID, result: 'updated' })
      return
    }

    sendJson(res, 400, { error: { type: 'bad_request', reason: `unhandled ${req.method} ${req.path}` } })
  })

  return { fake, state: resolved, written, requests: counter.requests }
}

function makeDeps(fake: FakeEs, overrides: Partial<SaveDeps> = {}): SaveDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    defaultDomain: 'general',
    reader: createEsClient({ url: fake.url, username: 'r', password: 'r' }),
    writer: createEsClient({ url: fake.url, username: 'w', password: 'w' }),
    embed: { embed: async () => VECTOR },
    now: () => NOW,
    newId: () => FIXED_ID,
    admission: { enabled: true },
    similar: { enabled: true, score: 0.85, dims: DIMS },
    ...overrides,
  }
}

describe('saveMemory 准入：凭据', () => {
  test('含口令 → 写 status=quarantine、带原因、不进检索', async () => {
    const { fake, written } = await startAdmissionFake()
    try {
      const result = await saveMemory(makeDeps(fake), {
        content: '生产库 password: Passw0rd123! 记一下',
      })
      assert.equal(result.quarantined, true)
      assert.equal(result.deduped, false)
      assert.match(result.text, /隔离待审/)
      assert.equal(written.length, 1, '隔离也要落库，不能丢弃')
      assert.equal(written[0].status, 'quarantine')
      assert.match(String(written[0].quarantine_reason), /隔离/)
      assert.equal(written[0].distill_state, 'skipped', '隔离条目不进后台蒸馏')
      assert.equal(written[0].embedding, undefined, '隔离不该白花一次向量调用')
    } finally {
      await fake.close()
    }
  })

  test('隔离结果里不含完整凭据', async () => {
    const { fake } = await startAdmissionFake()
    try {
      const result = await saveMemory(makeDeps(fake), { content: '数据库 password: Passw0rd123!' })
      assert.ok(!JSON.stringify(result).includes('Passw0rd123'), `返回值泄露凭据：${JSON.stringify(result)}`)
    } finally {
      await fake.close()
    }
  })

  test('总开关关闭时同样的内容照常入库（用于排查误拦）', async () => {
    const { fake, written } = await startAdmissionFake()
    try {
      const result = await saveMemory(makeDeps(fake, { admission: { enabled: false } }), {
        content: '数据库 password: Passw0rd123!',
      })
      assert.equal(result.quarantined, false)
      assert.equal(written[0].status, 'active')
    } finally {
      await fake.close()
    }
  })
})

describe('saveMemory 准入：检索原文再摄取', () => {
  test('与最近命中高度重复 → 隔离', async () => {
    const { fake, written } = await startAdmissionFake()
    const recalled =
      '生产库慢查询要看 infra_api_access_log，保留 14 天、每批删 100 行；查询时先按时间收窄。'
    try {
      const result = await saveMemory(
        makeDeps(fake, { recentRecalls: () => [{ memoryId: 'mem-old', content: recalled }] }),
        { content: recalled },
      )
      assert.equal(result.quarantined, true)
      assert.match(result.text, /隔离待审/)
      assert.equal(written[0].status, 'quarantine')
      assert.match(String(written[0].quarantine_reason), /mem-old/)
    } finally {
      await fake.close()
    }
  })

  test('没有检索素材时不判（同义改写必须放行）', async () => {
    const { fake } = await startAdmissionFake()
    try {
      const result = await saveMemory(makeDeps(fake), {
        content: 'AccessLogCleanJob 每批只删 100 行，导致 43.9GB 的表三天才降下来。',
      })
      assert.equal(result.quarantined, false)
    } finally {
      await fake.close()
    }
  })
})

describe('saveMemory 来源戳与近似去重', () => {
  test('缺省 origin=agent；ingest 会原样写入', async () => {
    const { fake, written } = await startAdmissionFake()
    try {
      await saveMemory(makeDeps(fake), { content: '一条普通事实，用来确认来源戳默认值' })
      assert.equal(written[0].origin, 'agent')

      await saveMemory(makeDeps(fake), {
        content: '巡检蒸馏出来的一条事实，来源应标 ingest',
        origin: 'ingest',
      })
      assert.equal(written[1].origin, 'ingest')
    } finally {
      await fake.close()
    }
  })

  test('未知 origin 直接拒绝（不静默回退）', async () => {
    const { fake } = await startAdmissionFake()
    try {
      await assert.rejects(
        () => saveMemory(makeDeps(fake), { content: '一条事实', origin: 'weird' as never }),
        /未知 origin/,
      )
    } finally {
      await fake.close()
    }
  })

  test('库里有近似条目 → similar_to 提示但照常写入', async () => {
    const { fake, written } = await startAdmissionFake({
      neighbors: [
        { memoryId: FIXED_ID, score: 0.99 }, // 自身：不算近似
        { memoryId: 'mem-twin', score: 0.91 },
        { memoryId: 'mem-far', score: 0.4 },
      ],
    })
    try {
      const result = await saveMemory(makeDeps(fake), { content: '一条与前文相近、但有新增信息的事实' })
      assert.deepEqual(result.similar_to, ['mem-twin'])
      assert.match(result.text, /内容相近/)
      assert.equal(written.length, 1, '近似去重只提示，不阻塞')
    } finally {
      await fake.close()
    }
  })
})
