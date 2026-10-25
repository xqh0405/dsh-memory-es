/**
 * `apply` 契约测试：不启 dsh、不连 ES，只验证「插件加载期做了什么」。
 *
 * 钉住三件事（任何一条坏了都会让插件在真实 profile 里静默失效）：
 *  1. 加载期**不碰网络**——配置错只让本插件失败，不该在启动时探测 ES；
 *  2. 恰好注册一个工具 `memory_save`，且注册是 effect（卸载时能被回收）；
 *  3. 配置非法时抛出的消息把**每个**问题都列出来，而不是只报第一个。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Config, type ConfigType } from '../src/config.ts'
import { apply, inject, name } from '../src/index.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

/** 最小可用的 Config（默认值走 schema） */
function baseConfig(overrides: Partial<ConfigType> = {}): ConfigType {
  const parsed = Config({
    identity: { userId: 'xqh', readPassword: 'pw-reader', writerPassword: 'pw-writer' },
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
  sections: Array<{ name: string; order: number; text: string }>
}

function fakeCtx(): FakeCtx {
  const registered: Array<{ name: string }> = []
  const logs: string[] = []
  const disposers: Array<() => void> = []
  const sections: Array<{ name: string; order: number; text: string }> = []
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
    // 模拟 cordis 的 ctx.effect：立即执行 body 拿到 disposer，卸载时调用
    effect: (body: () => () => void) => {
      disposers.push(body())
      return () => {}
    },
  }
  return { ctx, registered, logs, disposers, sections }
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
      ['memory_distill', 'memory_promote', 'memory_save', 'memory_search', 'memory_update_status'],
    )
    assert.equal(harness.logs.length, 1)
    assert.match(harness.logs[0], /ready: user=xqh index=personal_memory_xqh/)
  })

  test('注册走 effect：disposer 一调，工具就注销（fiber 卸载能收干净）', () => {
    const harness = fakeCtx()
    const config = baseConfig({ es: { url: 'http://127.0.0.1:1', caCertPath: '', requestTimeoutMs: 1000 } })
    apply(harness.ctx as never, config)
    assert.equal(harness.registered.length, 5, '五个工具各一次 effect（含 memory_distill）')
    assert.equal(harness.sections.length, 1, '提示词段也要走 effect')
    assert.equal(harness.disposers.length, 6, '应当通过 ctx.effect 注册（而不是裸 register）')
    for (const dispose of harness.disposers) dispose()
    assert.equal(harness.registered.length, 0)
    assert.equal(harness.sections.length, 0)
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
    assert.equal(harness.sections.length, 1)
    const [section] = harness.sections
    assert.equal(section.name, 'dsh-memory-es')
    assert.equal(section.order, 3200)
    assert.ok(section.text.includes('memory_search'))
    assert.equal(section.text.includes('{{'), false)
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
