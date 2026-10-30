/**
 * `memory_save` 单测：用进程内假 ES 打真实 `createEsClient`，覆盖
 * 注入（F2）、幂等去重、embedding 降级、F3 断言、参数校验与工具定义本身。
 *
 * 这里刻意**不 mock EsClient**：让请求真的走一遍 TLS/Basic/路径拼装，
 * 才能抓到「索引名拼错」「refresh 丢了」这类只有在线上才会暴露的错。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import type { Embedder } from '../src/embedding.ts'
import { EmbeddingError } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import {
  assertDocOwner,
  buildMemoryDoc,
  defineSaveTool,
  MAX_CONTENT_CHARS,
  saveMemory,
  type SaveDeps,
  type SaveInput,
} from '../src/memory/save.ts'
import { normalizeContent, sha256Hex } from '../src/fragment.ts'
import { sendEsError, sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const FIXED_ID = '11111111-2222-3333-4444-555555555555'
const NOW = new Date('2026-10-25T12:00:00.000Z')
const DIMS = 4
const VECTOR = [0.1, 0.2, 0.3, 0.4]

interface FakeState {
  /** 非 null = 去重查询命中这条 */
  duplicate: { memoryId: string } | null
  /** 非 null = 写入请求返回这个错误 */
  failWrite: { status: number; type: string } | null
  failSearch: { status: number; type: string } | null
}

async function startSaveFake(state: Partial<FakeState> = {}): Promise<{
  fake: FakeEs
  state: FakeState
  written: Record<string, unknown>[]
}> {
  const resolved: FakeState = { duplicate: null, failWrite: null, failSearch: null, ...state }
  const written: Record<string, unknown>[] = []
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('/_search')) {
      if (resolved.failSearch) {
        sendEsError(res, resolved.failSearch.status, resolved.failSearch.type, 'search boom')
        return
      }
      const hit = resolved.duplicate
      sendJson(res, 200, {
        took: 1,
        hits: {
          total: { value: hit ? 1 : 0, relation: 'eq' },
          hits: hit
            ? [{ _id: hit.memoryId, _score: 1, _source: { memory_id: hit.memoryId } }]
            : [],
        },
      })
      return
    }
    if (resolved.failWrite) {
      sendEsError(res, resolved.failWrite.status, resolved.failWrite.type, 'write boom')
      return
    }
    const doc = JSON.parse(req.body) as Record<string, unknown>
    written.push(doc)
    sendJson(res, 201, { _id: doc.memory_id, result: 'created' })
  })
  return { fake, state: resolved, written }
}

function makeDeps(
  fake: FakeEs,
  overrides: Partial<SaveDeps> = {},
  embed: Partial<Pick<Embedder, 'embed'>> | null = {},
): SaveDeps {
  const reader = createEsClient({ url: fake.url, username: 'mem-reader-xqh', password: 'pw-reader' })
  const writer = createEsClient({ url: fake.url, username: 'mem-writer', password: 'pw-writer' })
  const defaultEmbed =
    embed === null
      ? null
      : {
          embed: async () => VECTOR,
          ...embed,
        }
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    defaultDomain: 'general',
    reader,
    writer,
    embed: defaultEmbed,
    now: () => NOW,
    newId: () => FIXED_ID,
    ...overrides,
  }
}

/** defineTool 的 execute 需要一个 RunContext；本工具不读它，给个最小假对象即可 */
const EXEC = { signal: new AbortController().signal } as unknown as ToolRunContext

describe('buildMemoryDoc（纯函数）', () => {
  test('注入 user_id、状态、时间；sha 用归一化正文；原文照存', () => {
    const built = buildMemoryDoc(
      { content: '  北单中断开奖要同时写 win_price 和 practical  ' },
      { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'lottery-cloud' },
      { now: NOW, memoryId: FIXED_ID, embedding: VECTOR },
    )
    assert.equal(built.index, 'personal_memory_xqh')
    assert.equal(built.doc.memory_id, FIXED_ID)
    assert.equal(built.doc.user_id, 'xqh')
    assert.equal(built.doc.status, 'active')
    assert.equal(built.doc.promote_state, 'none')
    assert.equal(built.doc.memory_type, 'fact')
    assert.equal(built.doc.privacy, 'normal')
    assert.equal(built.doc.domain, 'lottery-cloud', '缺省 domain 取配置')
    assert.equal(built.doc.created_at, NOW.toISOString())
    assert.equal(built.doc.updated_at, NOW.toISOString())
    assert.equal(built.doc.content, '  北单中断开奖要同时写 win_price 和 practical  ', '原文照存')
    assert.equal(built.doc.content_exact, built.doc.content, '标识符字段与正文同源（standard 分词副本）')
    assert.equal(built.doc.importance, 'normal', '缺省 normal：没有信号时排序不偏')
    assert.equal(built.contentSha256, sha256Hex(normalizeContent('  北单中断开奖要同时写 win_price 和 practical  ')))
    assert.deepEqual(built.doc.embedding, VECTOR)
  })

  test('阶段 6.1：valence/arousal 可选，给了才写字段', () => {
    const withMood = buildMemoryDoc(
      { content: '那天他很高兴', valence: 0.6, arousal: 0.4 },
      { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'general' },
      { now: NOW, memoryId: FIXED_ID, embedding: null },
    )
    assert.equal(withMood.doc.valence, 0.6)
    assert.equal(withMood.doc.arousal, 0.4)

    const plain = buildMemoryDoc(
      { content: '一条普通事实' },
      { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'general' },
      { now: NOW, memoryId: FIXED_ID, embedding: null },
    )
    assert.equal('valence' in plain.doc, false, '不标就不写字段（缺失 ≠ 中性）')
    assert.equal('arousal' in plain.doc, false)
  })

  test('阶段 6.1：越界值直接拒绝，不静默截断', () => {
    const deps = { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'general' }
    const opts = { now: NOW, memoryId: FIXED_ID, embedding: null }
    assert.throws(() => buildMemoryDoc({ content: 'x', valence: 1.5 }, deps, opts), /valence 必须是 -1~1/)
    assert.throws(() => buildMemoryDoc({ content: 'x', arousal: -0.1 }, deps, opts), /arousal 必须是 0~1/)
    assert.throws(() => buildMemoryDoc({ content: 'x', valence: Number.NaN }, deps, opts), /valence 必须是 -1~1/)
  })

  test('归一化口径：全角空格/半角多空格折叠后哈希相同（幂等的依据）', () => {
    const a = buildMemoryDoc(
      { content: '　记录　一条　事实　' },
      { userId: 'u', personalPrefix: 'p_', defaultDomain: 'd' },
      { now: NOW, memoryId: 'a', embedding: null },
    )
    const b = buildMemoryDoc(
      { content: '记录 一条 事实' },
      { userId: 'u', personalPrefix: 'p_', defaultDomain: 'd' },
      { now: NOW, memoryId: 'b', embedding: null },
    )
    assert.equal(a.contentSha256, b.contentSha256)
    assert.equal(b.contentSha256, sha256Hex('记录 一条 事实'), 'NFKC 后全角空格变半角、连续空白折叠')
  })

  test('embedding 为 null 时不写该字段（而不是写空数组）', () => {
    const built = buildMemoryDoc(
      { content: '一句事实' },
      { userId: 'u', personalPrefix: 'p_', defaultDomain: 'd' },
      { now: NOW, memoryId: 'a', embedding: null },
    )
    assert.equal('embedding' in built.doc, false)
  })

  test('ttl_days → expires_at（按注入时钟算）', () => {
    const built = buildMemoryDoc(
      { content: '临时约定', ttl_days: 7 },
      { userId: 'u', personalPrefix: 'p_', defaultDomain: 'd' },
      { now: NOW, memoryId: 'a', embedding: null },
    )
    assert.equal(built.doc.expires_at, '2026-11-01T12:00:00.000Z')
  })

  test('显式 domain 优先于缺省值', () => {
    const built = buildMemoryDoc(
      { content: '一句事实', domain: 'backup-server' },
      { userId: 'u', personalPrefix: 'p_', defaultDomain: 'general' },
      { now: NOW, memoryId: 'a', embedding: null },
    )
    assert.equal(built.doc.domain, 'backup-server')
  })

  test('拒绝清单：空内容 / 超长 / 未知枚举 / 非法 ttl / 缺 userId', () => {
    const deps = { userId: 'u', personalPrefix: 'p_', defaultDomain: 'd' }
    const opts = { now: NOW, memoryId: 'a', embedding: null }
    assert.throws(() => buildMemoryDoc({ content: '   ' }, deps, opts), /content 不能为空/)
    assert.throws(() => buildMemoryDoc({ content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }, deps, opts), /过长/)
    assert.throws(
      () => buildMemoryDoc({ content: 'x', memory_type: 'nope' as never }, deps, opts),
      /memory_type/,
    )
    assert.throws(() => buildMemoryDoc({ content: 'x', privacy: 'secret' as never }, deps, opts), /privacy/)
    assert.throws(() => buildMemoryDoc({ content: 'x', ttl_days: 0 }, deps, opts), /ttl_days/)
    assert.throws(() => buildMemoryDoc({ content: 'x', ttl_days: 1.5 }, deps, opts), /ttl_days/)
    assert.throws(
      () => buildMemoryDoc({ content: 'x' }, { ...deps, userId: '' }, opts),
      /identity\.userId/,
    )
  })
})

describe('assertDocOwner（F3）', () => {
  test('一致时安静通过', () => {
    assert.doesNotThrow(() => assertDocOwner({ user_id: 'xqh' }, 'xqh'))
  })

  test('不一致时报错并点明两边值', () => {
    assert.throws(
      () => assertDocOwner({ user_id: 'someone-else' }, 'xqh'),
      /身份校验失败.*someone-else.*xqh/s,
    )
  })
})

describe('saveMemory 编排', () => {
  test('正常路径：先按 sha 去重、再写文档（refresh=wait_for、带 id）', async () => {
    const { fake, written } = await startSaveFake()
    const events: Record<string, unknown>[] = []
    try {
      const result = await saveMemory(makeDeps(fake, { log: (e) => events.push(e) }), { content: '一条事实' })
      assert.deepEqual(result, {
        memory_id: FIXED_ID,
        deduped: false,
        degraded: false,
        text: '已保存',
      })
      assert.equal(fake.requests.length, 2)
      assert.equal(fake.requests[0].path, '/personal_memory_xqh/_search')
      assert.equal(fake.requests[1].method, 'PUT')
      assert.equal(fake.requests[1].path, `/personal_memory_xqh/_doc/${FIXED_ID}?refresh=wait_for`)
      assert.equal(written.length, 1)
      assert.equal(written[0].user_id, 'xqh')
      assert.equal(events.length, 1)
      assert.equal(events[0].deduped, false)
    } finally {
      await fake.close()
    }
  })

  test('幂等：命中 content_sha256 → 不写、返回已有 id', async () => {
    const { fake, written } = await startSaveFake({ duplicate: { memoryId: 'existing-1' } })
    try {
      const result = await saveMemory(makeDeps(fake), { content: '一条事实' })
      assert.equal(result.deduped, true)
      assert.equal(result.memory_id, 'existing-1')
      assert.match(result.text, /未重复写入/)
      assert.equal(fake.requests.length, 1, '命中去重后不应再发写请求')
      assert.equal(written.length, 0)
      // 去重查询用的是 sha term，不是相似度
      const body = JSON.parse(fake.requests[0].body) as { query: { bool: { filter: unknown[] } } }
      assert.deepEqual(body.query.bool.filter[0], {
        term: { content_sha256: sha256Hex(normalizeContent('一条事实')) },
      })
      assert.deepEqual(body.query.bool.filter[1], { term: { status: 'active' } })
    } finally {
      await fake.close()
    }
  })

  test('embedding 失败 → degraded=true，doc 无 embedding，仍写入', async () => {
    const { fake, written } = await startSaveFake()
    try {
      const deps = makeDeps(fake, {}, {
        embed: async () => {
          throw new EmbeddingError('down', { kind: 'unavailable' })
        },
      })
      const result = await saveMemory(deps, { content: '一条事实' })
      assert.equal(result.deduped, false)
      assert.equal(result.degraded, true)
      assert.match(result.text, /向量服务不可用/)
      assert.equal(written.length, 1)
      assert.equal('embedding' in written[0], false)
    } finally {
      await fake.close()
    }
  })

  test('不配 embedder（null）→ 同样按降级处理', async () => {
    const { fake, written } = await startSaveFake()
    try {
      const result = await saveMemory(makeDeps(fake, {}, null), { content: '一条事实' })
      assert.equal(result.degraded, true)
      assert.equal(written.length, 1)
    } finally {
      await fake.close()
    }
  })

  test('ES 写失败 → 原样抛出（不允许假成功）', async () => {
    const { fake, written } = await startSaveFake({ failWrite: { status: 503, type: 'unavailable_shards_exception' } })
    try {
      const err = await saveMemory(makeDeps(fake), { content: '一条事实' }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(err instanceof Error)
      assert.match(err.message, /503/)
      assert.equal(written.length, 0)
    } finally {
      await fake.close()
    }
  })

  test('去重查询失败也抛（不能把“读不到”当成“没有重复”）', async () => {
    const { fake } = await startSaveFake({ failSearch: { status: 404, type: 'index_not_found_exception' } })
    try {
      await assert.rejects(saveMemory(makeDeps(fake), { content: '一条事实' }), /404/)
    } finally {
      await fake.close()
    }
  })

  test('参数里塞 user_id 也无效（F1：只认配置注入的身份）', async () => {
    const { fake, written } = await startSaveFake()
    try {
      const args = { content: '一条事实', user_id: 'someone-else', userId: 'someone-else' } as unknown as SaveInput
      await saveMemory(makeDeps(fake), args)
      assert.equal(written[0].user_id, 'xqh')
      assert.equal(fake.requests[1].path.includes('someone-else'), false, '索引名也只能来自配置')
    } finally {
      await fake.close()
    }
  })

  test('内容校验失败时不发任何 HTTP 请求', async () => {
    const { fake } = await startSaveFake()
    try {
      await assert.rejects(saveMemory(makeDeps(fake), { content: '   ' }), /content 不能为空/)
      assert.equal(fake.requests.length, 0)
    } finally {
      await fake.close()
    }
  })

  test('日志里不出现正文（§15.7：不记录 content）', async () => {
    const { fake } = await startSaveFake()
    const secret = '这是不该进日志的正文-xyz'
    const events: Record<string, unknown>[] = []
    try {
      await saveMemory(makeDeps(fake, { log: (e) => events.push(e) }), { content: secret })
      const serialized = JSON.stringify(events)
      assert.equal(serialized.includes(secret), false)
      assert.equal(serialized.includes('embedding'), false)
      assert.ok(serialized.includes('xqh'), '至少要能定位到人')
    } finally {
      await fake.close()
    }
  })
})

describe('defineSaveTool', () => {
  test('参数表里没有 user_id（F1 的结构性保证）', () => {
    // 这个用例只看定义，不真发请求，给个占位 client 就够
    const def = defineSaveTool(makeDeps({ url: 'http://127.0.0.1:1', requests: [], close: async () => {} } as unknown as FakeEs))
    const parameters = def.parameters as { properties: Record<string, unknown> }
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      'arousal',
      'content',
      'domain',
      'importance',
      'memory_type',
      'privacy',
      'ttl_days',
      'valence',
    ])
    assert.equal(JSON.stringify(def.parameters).includes('user_id'), false)
    assert.match(def.description, /memory_save|记忆/)
    // 新契约（S9 还债）：声明 timeoutMs **且真的把 exec.signal 转发进内部请求**。
    // 只有二者同时成立才不算假承诺——所以下面用行为断言，不只看数字。
    assert.equal(typeof def.timeoutMs, 'number')
    assert.ok((def.timeoutMs as number) > 0)
  })

  test('execute 把 exec.signal 一路转发到去重检索 / 向量 / 写入（timeoutMs 才不算假承诺）', async () => {
    const readerSignal: Array<AbortSignal | undefined> = []
    const writeSignal: Array<AbortSignal | undefined> = []
    const embedSignal: Array<AbortSignal | undefined> = []
    const deps: SaveDeps = {
      userId: 'xqh',
      personalPrefix: 'personal_memory_',
      defaultDomain: 'd',
      reader: {
        search: async (_index, _body, call) => {
          readerSignal.push(call?.signal)
          return { took: 1, total: 0, hits: [] }
        },
      },
      writer: {
        index: async (_index, _doc, options) => {
          writeSignal.push(options?.signal)
          return { id: 'x', result: 'created', status: 201 }
        },
      },
      embed: {
        embed: async (_text, call) => {
          embedSignal.push(call?.signal)
          return VECTOR
        },
      },
    }

    const controller = new AbortController()
    const def = defineSaveTool(deps)
    await def.execute({ content: '转发信号验证' }, { signal: controller.signal } as unknown as ToolRunContext)

    assert.deepEqual(readerSignal, [controller.signal], '去重检索要带同一个 signal')
    assert.deepEqual(embedSignal, [controller.signal], '向量调用要带同一个 signal')
    assert.deepEqual(writeSignal, [controller.signal], '写入要带同一个 signal')
  })

  test('execute 返回的值满足声明的 output schema，render 给一行文本', async () => {
    const { fake } = await startSaveFake()
    try {
      const def = defineSaveTool(makeDeps(fake))
      const value = (await def.execute({ content: '一条事实' }, EXEC)) as Record<string, unknown>
      assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
      assert.deepEqual(def.output.render({ content: '一条事实' }, value as never), [
        { type: 'text', text: '已保存' },
      ])
    } finally {
      await fake.close()
    }
  })
})
