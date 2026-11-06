/**
 * `apply` 契约测试：不启 dsh、不连 ES，只验证「插件加载期做了什么」。
 *
 * 钉住三件事（任何一条坏了都会让插件在真实 profile 里静默失效）：
 *  1. 加载期**不碰网络**——配置错只让本插件失败，不该在启动时探测 ES；
 *  2. 恰好注册一个工具 `memory_save`，且注册是 effect（卸载时能被回收）；
 *  3. 配置非法时抛出的消息把**每个**问题都列出来，而不是只报第一个。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { Config, type ConfigType } from '../src/config.ts'
import { apply, inject, name } from '../src/index.ts'
import { sendJson, startFakeEs, sendEsError } from './helpers/fake-es.ts'

/** 最小可用的 Config（默认值走 schema） */
// identity 允许只覆盖部分字段：schema 有默认值，测试只想改动其中一两项
function baseConfig(
  overrides: Partial<Omit<ConfigType, 'identity'>> & { identity?: Partial<ConfigType['identity']> } = {},
): ConfigType {
  const parsed = Config({
    identity: { userId: 'xqh', readPassword: 'pw-reader', writerPassword: 'pw-writer' },
    // 显式给 http：schema 默认是 https://127.0.0.1:9200，那会让 createEsClient 去自动找
    // 自签 CA —— 本机有 deploy/es/certs 才侥幸通过，CI 上没有就整片失败（2026-11-06）。
    // 这些用例只跑编排、不发真请求，端点写成什么都不影响语义。
    es: { url: 'http://127.0.0.1:9200', caCertPath: '', requestTimeoutMs: 1_000 },
    ...overrides,
  } as never) as ConfigType
  return parsed
}

/** 极简 printf：把 %s/%d/%o 换成实参，末尾多余实参按对象 JSON 追加（对齐 cordis 的行为） */
function renderLog(format: string, args: unknown[]): string {
  let index = 0
  const text = format.replace(/%[sdioO]/g, (marker) => {
    const value = args[index]
    index += 1
    return marker === '%o' || marker === '%O' ? JSON.stringify(value) : String(value)
  })
  const rest = args
    .slice(index)
    .map((value) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)))
    .join(' ')
  return rest === '' ? text : `${text} ${rest}`
}

interface FakeCtx {
  /** 喂给 apply 的假 Context（只实现本插件用到的那几个成员） */
  ctx: unknown
  registered: Array<{ name: string }>
  logs: string[]
  /** 存放 effect 注册的 disposer，用来验证卸载时能回收 */
  disposers: Array<() => void>
  /** 注册过的提示词段 */
  sections: Array<{ name: string; order: number; text: string | (() => string) }>
  /** 注册过的事件监听（阶段 6.4 起用到 ctx.on） */
  listeners: Array<{ event: string; handler: (...args: never[]) => unknown }>
}

function fakeCtx(): FakeCtx {
  const registered: Array<{ name: string }> = []
  const logs: string[] = []
  const disposers: Array<() => void> = []
  const sections: Array<{ name: string; order: number; text: string | (() => string) }> = []
  const listeners: Array<{ event: string; handler: (...args: never[]) => unknown }> = []
  const ctx = {
    logger: () => ({
      info: (format: string, ...args: unknown[]) => logs.push(renderLog(format, args)),
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
    tools: {
      register: (definition: { name: string }) => {
        registered.push(definition)
        return () => {
          registered.splice(registered.indexOf(definition), 1)
        }
      },
    },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => {
        sections.push(section)
        return () => {
          sections.splice(sections.indexOf(section), 1)
        }
      },
    },
    // 模拟 cordis 的事件总线：记录监听器，返回能解绑的 disposer
    on: (event: string, handler: (...args: never[]) => unknown) => {
      const entry = { event, handler }
      listeners.push(entry)
      return () => {
        listeners.splice(listeners.indexOf(entry), 1)
      }
    },
    // 模拟 cordis 的 ctx.effect：立即执行 body 拿到 disposer，卸载时调用
    effect: (body: () => () => void) => {
      disposers.push(body())
      return () => {}
    },
  }
  return { ctx, registered, logs, disposers, sections, listeners }
}

describe('apply', () => {
  test('加载期不访问 ES：ES 不可达也能注册成功', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, {}))
    const url = fake.url
    await fake.close()
    const harness = fakeCtx()
    apply(harness.ctx as never, baseConfig({ es: { url, caCertPath: '', requestTimeoutMs: 1000 } }))

    const requests = (fake as { requests: unknown[] }).requests
    assert.equal(requests.length, 0, '加载期不应发任何请求')
    assert.deepEqual(
      harness.registered.map((tool) => tool.name).sort(),
      ['doc_search', 'memory_distill', 'memory_get', 'memory_history', 'memory_journal', 'memory_persona', 'memory_promote', 'memory_review', 'memory_save', 'memory_search', 'memory_traits', 'memory_update_status'],
    )
    assert.equal(harness.logs.length, 2, 'ready 行 + 影子召回开启行（阶段 16 P0）')
    // 版本号在 ready 行里：部署后靠它判断「加载的是哪一版」（格式由 version.test.ts 守）
    // 不取 logs[0]：effect 在 apply 过程中执行，影子那行会先打出来
    assert.ok(
      harness.logs.some((line) => /ready: v\d+\.\d+\.\d+ user=xqh index=personal_memory_xqh/.test(line)),
      `ready 行缺失：${JSON.stringify(harness.logs)}`,
    )
  })

  test('引用要求默认不注入；prompt.citation=true 才注入（阶段 12）', () => {
    const off = fakeCtx()
    apply(off.ctx as never, baseConfig({ es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 } }))
    assert.equal(
      off.sections.some((section) => section.name === 'dsh-memory-es-citation'),
      false,
      '默认不应注入引用要求（会改变回答风格）',
    )

    const on = fakeCtx()
    apply(
      on.ctx as never,
      baseConfig({ es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 }, prompt: { citation: true } }),
    )
    const section = on.sections.find((item) => item.name === 'dsh-memory-es-citation')
    assert.ok(section !== undefined, '开启后应注入')
    assert.match(String(section.text), /引用检索到的记忆时标明出处/)
  })

  test('注册走 effect：disposer 一调，工具就注销（fiber 卸载能收干净）', () => {
    const harness = fakeCtx()
    const config = baseConfig({ es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 } })
    apply(harness.ctx as never, config)
    assert.equal(harness.registered.length, 12, '十二个工具各一次 effect')
    assert.equal(harness.sections.length, 4, '记忆 / 人格 / 心情 / 表情包 各一次 effect')
    assert.equal(
      harness.disposers.length,
      23,
      '十二个工具 + 四个提示段 + 人格缓存刷新 + 每日回顾 + 每日提炼 + 四个事件监听（心情 / 工具结果 / 影子召回 / 自动召回注入），都走 ctx.effect',
    )
    for (const dispose of harness.disposers) dispose()
    assert.equal(harness.registered.length, 0)
    assert.equal(harness.sections.length, 0)
  })

  // 2026-11-04 巡检教训：积压 158 条 pending 没人消费的根因就是「钩子只挂在一条路上」。
  // 清扫 effect 必须随 distill.enabled 注册——上面的 23 只守住「关闭时不注册」，
  // 这条守住「开启时真的注册」，否则功能等于没装。
  test('distill.enabled=true 时注册清扫定时器（关闭时不注册）', () => {
    const off = fakeCtx()
    apply(off.ctx as never, baseConfig({ es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 } }))
    const on = fakeCtx()
    apply(
      on.ctx as never,
      baseConfig({
        es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 },
        distill: { enabled: true, provider: 'deepseek-official', model: 'deepseek-flash', timeoutMs: 30_000 },
      }),
    )
    assert.equal(on.disposers.length, off.disposers.length + 1, '开着蒸馏就该多注册一个清扫 effect')
    // 卸载要能收干净（定时器必须在 disposer 里清掉，否则 fiber 卸载后还在跑）
    for (const dispose of on.disposers) dispose()
    assert.ok(true)
  })

  test('配置非法：一次列出全部问题（不只报第一个）', () => {
    const broken = Config({ identity: { userId: '' } } as never) as ConfigType
    assert.throws(
      () => apply(fakeCtx().ctx as never, broken),
      (err: unknown) => {
        const message = (err as Error).message
        assert.match(message, /identity\.userId/)
        assert.match(message, /readPassword/)
        assert.match(message, /writerPassword/)
        return true
      },
    )
  })

  test('读/写身份相同时拒绝加载（D2：唯一写入口）', () => {
    const same = baseConfig({ identity: { userId: 'xqh', readUsername: 'same', readPassword: 'a', writerUsername: 'same', writerPassword: 'b' } })
    assert.throws(() => apply(fakeCtx().ctx as never, same), /同一个用户/)
  })

  test('提示词段：名字/顺序正确，正文非空且不含会触发插值的花括号', () => {
    const harness = fakeCtx()
    apply(harness.ctx as never, baseConfig({ es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 } }))
    assert.equal(harness.sections.length, 4)
    const section = harness.sections.find((s) => s.name === 'dsh-memory-es')!
    assert.equal(section.order, 3200)
    assert.equal(typeof section.text, 'string')
    assert.ok((section.text as string).includes('memory_search'))
    assert.equal((section.text as string).includes('{{'), false)

    // 阶段 6.2：心情段紧随其后，text 是函数（平静时返回空串 → 宿主丢掉该段）
    const moodSection = harness.sections.find((s) => s.name === 'dsh-memory-es-mood')!
    assert.equal(moodSection.order, 3201)
    assert.equal(typeof moodSection.text, 'function')
    const moodText = moodSection.text as () => string
    assert.equal(moodText(), '', '平静时不注入')
    assert.equal(moodText().includes('{{'), false)
  })

  test('exports：name 与 inject 是插件契约的一部分', () => {
    assert.equal(name, 'dsh-memory-es')
    // 只声明硬依赖；llm 在运行时用 ctx.get('llm') 取（没有模型也要能加载）
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
  })
})

describe('Config schema 默认值', () => {
  test('只给必填项时，其余键都有合理默认', () => {
    const config = Config({ identity: { userId: 'xqh', readPassword: 'a', writerPassword: 'b' } } as never) as ConfigType
    assert.equal(config.es.url, 'https://127.0.0.1:9200')
    assert.equal(config.es.requestTimeoutMs, 8000)
    assert.equal(config.index.personalPrefix, 'personal_memory_')
    // 默认关闭：蒸馏要花 token，必须由用户在看板上显式打开
    assert.equal(config.distill.enabled, false)
    assert.equal(config.distill.timeoutMs, 30000)
    assert.equal(config.index.team, 'team_knowledge')
    assert.equal(config.embedding.model, 'bge-m3')
    assert.equal(config.embedding.dims, 1024)
    assert.equal(config.defaults.domain, 'general')
    assert.equal(config.retrieval.limit, 8)
  })
})

describe('apply · 情绪事件', () => {
  /** 只伺候心情文档的假 ES：GET 404 → PUT 存下 → 之后 GET 回读到 */
  async function startMoodFake() {
    let stored: Record<string, unknown> | null = null
    const fake = await startFakeEs((req, res) => {
      if (req.path.includes('/_doc/__mood__')) {
        if (req.method === 'GET') {
          if (stored === null) {
            sendEsError(res, 404, 'not_found', 'no mood yet')
            return
          }
          sendJson(res, 200, { _id: '__mood__', _index: 'personal_memory_xqh', _source: stored })
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          stored = JSON.parse(req.body) as Record<string, unknown>
          sendJson(res, 201, { _id: '__mood__', result: 'created' })
          return
        }
      }
      sendJson(res, 200, {})
    })
    return { fake, get stored() { return stored } }
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

  function moodText(harness: FakeCtx): string {
    const section = harness.sections.find((s) => s.name === 'dsh-memory-es-mood')!
    return (section.text as () => string)()
  }

  test('中性起步不注入；收到夸奖后心情段出现一行', async () => {
    const { fake } = await startMoodFake()
    try {
      const harness = fakeCtx()
      apply(harness.ctx as never, baseConfig({ es: { url: fake.url, caCertPath: '', requestTimeoutMs: 1000 } }))
      await tick()
      assert.equal(moodText(harness), '', '初始（读不到文档）应为中性')

      const listener = harness.listeners.find((l) => l.event === 'agent/inbox/inserted')!
      listener.handler({ agent: { id: 'a1' }, message: { content: [{ type: 'text', text: '太棒了！' }] } } as never)
      await tick()

      const line = moodText(harness)
      assert.match(line, /心情/, '夸奖后应注入一行心情')
      assert.match(line, /不错|愉快/)
    } finally {
      await fake.close()
    }
  })

  test('中性消息不改变心情；节流挡住连发', async () => {
    const { fake } = await startMoodFake()
    try {
      const harness = fakeCtx()
      apply(harness.ctx as never, baseConfig({ es: { url: fake.url, caCertPath: '', requestTimeoutMs: 1000 } }))
      await tick()
      const listener = harness.listeners.find((l) => l.event === 'agent/inbox/inserted')!

      listener.handler({ agent: { id: 'a1' }, message: { content: [{ type: 'text', text: '把 README 更新一下' }] } } as never)
      await tick()
      assert.equal(moodText(harness), '', '中性消息不产生事件')

      listener.handler({ agent: { id: 'a1' }, message: { content: [{ type: 'text', text: '谢谢' }] } } as never)
      await tick()
      const afterFirst = moodText(harness)
      assert.match(afterFirst, /心情/)

      listener.handler({ agent: { id: 'a1' }, message: { content: [{ type: 'text', text: '太棒了' }] } } as never)
      await tick()
      assert.equal(moodText(harness), afterFirst, '30 秒内第二条不该放大情绪')
    } finally {
      await fake.close()
    }
  })

  test('工具失败降温；自家记忆工具被忽略', async () => {
    const { fake } = await startMoodFake()
    try {
      const harness = fakeCtx()
      apply(harness.ctx as never, baseConfig({ es: { url: fake.url, caCertPath: '', requestTimeoutMs: 1000 } }))
      await tick()
      const onTool = harness.listeners.find((l) => l.event === 'tools/result')!

      onTool.handler({ name: 'memory_search', agent: { id: 'a1' } } as never, { isError: true } as never)
      await tick()
      assert.equal(moodText(harness), '', '自家工具失败不推动情绪')

      onTool.handler({ name: 'bash', agent: { id: 'a1' } } as never, { isError: true } as never)
      await tick()
      assert.equal(moodText(harness), '', '单次失败 -0.1 还没到 0.15 的注入阈值')

      // 换个 agent（节流 key 不同）再来一次 → 累积到 -0.2，越过阈值
      onTool.handler({ name: 'bash', agent: { id: 'a2' } } as never, { isError: true } as never)
      await tick()
      assert.match(moodText(harness), /闷|低落/, '累积后心情应下行')
    } finally {
      await fake.close()
    }
  })
})

/** fakeCtx 把 handler 记成 (...args: never[])，这里放宽成可调用的签名 */
function callable(handler: (...args: never[]) => unknown) {
  return handler as unknown as (
    assembly: unknown,
    context: unknown,
    next: () => Promise<unknown>,
  ) => Promise<{ sections: Array<{ name: string; text: string }> }>
}

describe('apply · 自动召回真注入（阶段 17 P0-1）', () => {
  const ASSEMBLE = 'system-prompt/assemble'
  const emptyAssembly = (): { sections: Array<{ name: string; text: string }>; contexts: []; tools: []; variables: Record<string, never> } => ({
    sections: [],
    contexts: [],
    tools: [],
    variables: {},
  })

  test('默认关：不注册 assemble 监听、也不打印开启日志', () => {
    const harness = fakeCtx()
    // 走默认配置（recallInject.enabled 默认 false）
    apply(harness.ctx as never, baseConfig({}))
    assert.equal(harness.listeners.some((l) => l.event === ASSEMBLE), false, '默认不该挂 assemble 监听')
    assert.equal(harness.logs.some((line) => line.includes('自动召回注入已开')), false)
  })

  test('开启后注册 assemble 监听并打印参数', () => {
    const harness = fakeCtx()
    apply(harness.ctx as never, baseConfig({ recallInject: { enabled: true, timeoutMs: 500 } as never }))
    assert.equal(harness.listeners.some((l) => l.event === ASSEMBLE), true)
    assert.equal(harness.logs.some((line) => line.includes('自动召回注入已开')), true)
  })

  test('没有用户消息的 agent（例如子代理）不注入，也不打检索', async () => {
    // ES 指向一个已关闭的端口：一旦真的发起检索就会失败——这里断言的是「根本不该发起」
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, {}))
    const url = fake.url
    await fake.close()

    const harness = fakeCtx()
    apply(harness.ctx as never, baseConfig({ es: { url, caCertPath: '', requestTimeoutMs: 500 }, recallInject: { enabled: true } as never }))

    const assemble = harness.listeners.find((l) => l.event === ASSEMBLE)!
    const assembly = emptyAssembly()
    const result = await callable(assemble.handler)(assembly, { agent: { id: 'sub-agent' } }, async () => assembly)

    assert.deepEqual(result.sections, [], '没有缓存消息时不该插入任何段落')
    assert.equal(harness.logs.some((line) => line.includes('注入 ')), false, '不该有注入日志')
  })
})

describe('apply · 自动召回注入真的写进 prompt', () => {
  test('有用户消息且检索命中时，assembly 多一个记忆段落', async () => {
    // 一条高分命中，交给 bm25 路；knn 路给空（embedding 指向死端口，本来就只会走 BM25）
    const fake = await startFakeEs((req, res) => {
      // 同一个 fake server 兼任 Ollama：注入门槛要看 top1 的向量分数，
      // 向量降级会被 passesInjectGate 直接拒掉（那是对的），所以这里必须给真向量。
      if (req.path.startsWith('/api/embed')) {
        sendJson(res, 200, { embeddings: [[0.1, 0.2, 0.3, 0.4]] })
        return
      }
      // GET（如心情文档读取）没有 body，别直接 JSON.parse
      const body = req.body === '' ? {} : (JSON.parse(req.body) as Record<string, unknown>)
      const isKnn = 'knn' in body
      const hits = isKnn
        ? [
            {
              _id: 'm-1',
              _score: 0.88,
              _source: {
                memory_id: 'm-1',
                content: '重启后要先用 sync-local-plugin 同步再重启 dsh-web',
                memory_type: 'fact',
                domain: 'dsh',
                updated_at: '2026-11-01T00:00:00.000Z',
                content_sha256: 'h1',
              },
            },
          ]
        : [
            {
              _id: 'm-1',
              _score: 9,
              _source: {
                memory_id: 'm-1',
                content: '重启后要先用 sync-local-plugin 同步再重启 dsh-web',
                memory_type: 'fact',
                domain: 'dsh',
                updated_at: '2026-11-01T00:00:00.000Z',
                content_sha256: 'h1',
              },
            },
          ]
      sendJson(res, 200, { took: 1, hits: { total: { value: hits.length, relation: 'eq' }, hits } })
    })

    try {
      const tmpDir = mkdtempSync(join(tmpdir(), 'mem-inject-'))
      const logPath = join(tmpDir, 'recall-inject.jsonl')

      const harness = fakeCtx()
      apply(
        harness.ctx as never,
        baseConfig({
          es: { url: fake.url, caCertPath: '', requestTimeoutMs: 1000 },
          embedding: { url: fake.url, model: 'bge-m3', dims: 4 },
          // 把置信阈值压到 0：RRF 融合分本身很小（≈1/60），默认阈值会把它判成
          // low_confidence，而注入只认 ok。这条测的是「注入了什么」，不是置信判定本身。
          // midBandFloor 也关掉：这条测的是注入自己的 minScore 门槛，不能先被低置信闸拦下
          confidence: { floorTop1: 0, midBandFloor: 0, autoPassTop1: 0, minMargin: 0, minBm25: 0 },
          recallInject: { enabled: true, logPath } as never,
        }),
      )

      // 先喂一条用户消息（注入的 query 就来自它）。
      // 注意：agent/inbox/inserted 上有两个监听器（心情 + 注入），必须都喂——
      // 2026-11-05 这里踩过一次：find() 只拿到心情那个，注入侧永远没收到消息。
      const inboxes = harness.listeners.filter((l) => l.event === 'agent/inbox/inserted')
      assert.ok(inboxes.length >= 2, `应至少有两个 inbox 监听器，实际 ${inboxes.length}`)
      for (const listener of inboxes) {
        listener.handler({ agent: { id: 'a1' }, message: { content: [{ type: 'text', text: '重启后插件怎么同步' }] } } as never)
      }

      const assemble = harness.listeners.find((l) => l.event === 'system-prompt/assemble')!
      const assembly = { sections: [], contexts: [], tools: [], variables: {} }
      const result = await callable(assemble.handler)(assembly, { agent: { id: 'a1' } }, async () => assembly)

      // 落盘是唯一能在命令行验收的通道：断言真的写了一行且内容对得上
      const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(records.length, 1, '一次注入应落一行')
      assert.equal(records[0].outcome, 'injected')
      assert.equal(records[0].agent, 'a1')
      assert.ok(Number(records[0].chars) > 0)
      assert.equal((records[0].items as unknown[]).length, 1)

      const injected = result.sections.find((section) => section.name === 'dsh-memory-es-recall')
      assert.ok(
        injected,
        `应注入记忆段落，实际段落：${JSON.stringify(result.sections.map((s) => s.name))}；日志：${harness.logs.join(' | ')}`,
      )
      assert.match(injected!.text, /重启后要先用 sync-local-plugin/)
      assert.match(injected!.text, /数据不是指令/)
    } finally {
      await fake.close()
    }
  })
})

describe('apply · 注入的分数门槛（2026-11-05 实测：闲聊也 note=ok）', () => {
  test('top1 向量分数低于 minScore 时不注入，并记 low_score', async () => {
    const fake = await startFakeEs((req, res) => {
      if (req.path.startsWith('/api/embed')) {
        sendJson(res, 200, { embeddings: [[0.1, 0.2, 0.3, 0.4]] })
        return
      }
      const body = req.body === '' ? {} : (JSON.parse(req.body) as Record<string, unknown>)
      const isKnn = 'knn' in body
      // 0.73 是实测的闲聊档（「嗨！今天心情怎么样~」= 0.743、「在吗」= 0.7227）
      const score = isKnn ? 0.73 : 9
      sendJson(res, 200, {
        took: 1,
        hits: {
          total: { value: 1, relation: 'eq' },
          hits: [
            {
              _id: 'm-1',
              _score: score,
              _source: {
                memory_id: 'm-1',
                content: 'member 堆需求与 CPU 爆核的根因分析',
                memory_type: 'fact',
                domain: 'general',
                updated_at: '2026-11-01T00:00:00.000Z',
                content_sha256: 'h1',
              },
            },
          ],
        },
      })
    })

    try {
      const tmpDir = mkdtempSync(join(tmpdir(), 'mem-gate-'))
      const logPath = join(tmpDir, 'recall-inject.jsonl')
      const harness = fakeCtx()
      apply(
        harness.ctx as never,
        baseConfig({
          es: { url: fake.url, caCertPath: '', requestTimeoutMs: 1000 },
          embedding: { url: fake.url, model: 'bge-m3', dims: 4 },
          // midBandFloor 也关掉：这条测的是注入自己的 minScore 门槛，不能先被低置信闸拦下
          confidence: { floorTop1: 0, midBandFloor: 0, autoPassTop1: 0, minMargin: 0, minBm25: 0 },
          recallInject: { enabled: true, logPath } as never,
        }),
      )

      const inboxes = harness.listeners.filter((l) => l.event === 'agent/inbox/inserted')
      for (const listener of inboxes) {
        listener.handler({ agent: { id: 'a1' }, message: { content: [{ type: 'text', text: '今天心情怎么样' }] } } as never)
      }
      const assemble = harness.listeners.find((l) => l.event === 'system-prompt/assemble')!
      const assembly = { sections: [], contexts: [], tools: [], variables: {} }
      const result = await callable(assemble.handler)(assembly, { agent: { id: 'a1' } }, async () => assembly)

      assert.deepEqual(result.sections, [], '分数不够就不该插段落')
      const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(records.length, 1)
      assert.equal(records[0].outcome, 'low_score', '要能和「本来就没命中」区分开')
      assert.equal(records[0].top1Score, 0.73, '分数要落盘，调 minScore 时才有依据')
    } finally {
      await fake.close()
    }
  })
})
