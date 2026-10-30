/**
 * 阶段 7.2：夜间提炼的判定层。
 *
 * 重点在「不要写垃圾」：模型给的东西必须过三关——带证据、证据真在素材里、
 * 条数与长度受控。这些关卡的失败方式都必须是"丢弃"，不是"报错"。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildTraitsPrompt,
  hashContent,
  parseTraitsOutput,
  TRAIT_MAX_CHARS,
  TRAITS_MAX_OUTPUT,
  TRAITS_SYSTEM,
  type TraitSource,
} from '../src/memory/traits.ts'

const SOURCES: TraitSource[] = [
  { memory_id: 'a1', content: '先给结论再解释理由', memory_type: 'preference' },
  { memory_id: 'b2', content: '不确定时承认不确定，不猜', memory_type: 'preference' },
  { memory_id: 'c3', content: '改动前先确认表结构', memory_type: 'decision' },
]
const IDS = new Set(SOURCES.map((s) => s.memory_id))

describe('buildTraitsPrompt', () => {
  test('带上 id、类型与天数，模型才能给证据', () => {
    const prompt = buildTraitsPrompt(SOURCES, 14)
    assert.match(prompt, /最近 14 天/)
    assert.match(prompt, /3 条记忆/)
    for (const s of SOURCES) {
      assert.ok(prompt.includes(`[${s.memory_id}]`), `应包含证据 id ${s.memory_id}`)
      assert.ok(prompt.includes(s.content))
    }
  })
})

describe('parseTraitsOutput', () => {
  test('正常 JSON 数组', () => {
    const out = parseTraitsOutput(
      '[{"content":"你倾向于先给结论","evidence_ids":["a1","b2"]}]',
      IDS,
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]?.content, '你倾向于先给结论')
    assert.deepEqual(out[0]?.evidence_ids, ['a1', 'b2'])
  })

  test('容忍 ```json 围栏与前后废话', () => {
    const out = parseTraitsOutput(
      '好的，结果如下：\n```json\n[{"content":"你偏好先确认再动手","evidence_ids":["a1","c3"]}]\n```\n以上。',
      IDS,
    )
    assert.equal(out.length, 1)
  })

  test('证据不足两条的直接丢弃', () => {
    assert.equal(parseTraitsOutput('[{"content":"你很快乐","evidence_ids":["a1"]}]', IDS).length, 0)
    assert.equal(parseTraitsOutput('[{"content":"你很快乐","evidence_ids":[]}]', IDS).length, 0)
  })

  test('证据重复不算多条', () => {
    assert.equal(parseTraitsOutput('[{"content":"你很快乐","evidence_ids":["a1","a1","a1"]}]', IDS).length, 0)
  })

  test('编造的 id 整条丢弃（不静默裁掉那条证据）', () => {
    const out = parseTraitsOutput(
      '[{"content":"你倾向于先给结论","evidence_ids":["a1","fake-id"]}]',
      IDS,
    )
    assert.equal(out.length, 0, '有假 id 就整条不要，避免"看起来有两条支撑"')
  })

  test('超长内容丢弃', () => {
    const long = 'x'.repeat(TRAIT_MAX_CHARS + 1)
    assert.equal(parseTraitsOutput(`[{"content":"${long}","evidence_ids":["a1","b2"]}]`, IDS).length, 0)
  })

  test('空数组与不可解析都返回空', () => {
    assert.deepEqual(parseTraitsOutput('[]', IDS), [])
    assert.deepEqual(parseTraitsOutput('我觉得没什么可提炼的', IDS), [])
    assert.deepEqual(parseTraitsOutput('[{"broken":', IDS), [])
  })

  test(`一次最多 ${TRAITS_MAX_OUTPUT} 条`, () => {
    const many = Array.from({ length: TRAITS_MAX_OUTPUT + 5 }, (_, i) => ({
      content: `模式 ${i}`,
      evidence_ids: ['a1', 'b2'],
    }))
    assert.equal(parseTraitsOutput(JSON.stringify(many), IDS).length, TRAITS_MAX_OUTPUT)
  })

  test('不给 sourceIds 时不做 id 校验（供离线回放用）', () => {
    assert.equal(parseTraitsOutput('[{"content":"x","evidence_ids":["任意","id"]}]').length, 1)
  })
})

describe('hashContent', () => {
  test('归一化后稳定：全角/多空格/大小写不影响', () => {
    assert.equal(hashContent('先给结论  再解释'), hashContent('先给结论 再解释'))
    assert.equal(hashContent('ＡＢＣ'), hashContent('ABC'))
    assert.equal(hashContent('Hello'), hashContent('hello'))
  })

  test('不同内容不同哈希（用于候选幂等键）', () => {
    assert.notEqual(hashContent('甲'), hashContent('乙'))
  })
})

describe('TRAITS_SYSTEM', () => {
  test('明确要求"宁可空不要凑"与证据要求', () => {
    assert.match(TRAITS_SYSTEM, /宁可空/)
    assert.match(TRAITS_SYSTEM, /证据|支撑/)
  })
})

describe('collectTraitSources：素材范围', () => {
  test('只要 active、排除 identity、排除情绪文档、带时间窗', async () => {
    let captured: Record<string, unknown> | null = null
    const deps = {
      userId: 'u1',
      personalPrefix: 'personal_memory_',
      now: () => new Date('2026-10-30T12:00:00.000Z'),
      reader: {
        search: async (_index: string, body: unknown) => {
          captured = body as Record<string, unknown>
          return { hits: [{ source: { memory_id: 'a1', content: 'x', memory_type: 'fact' } }] }
        },
      },
      writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
    }
    const { collectTraitSources } = await import('../src/memory/traits.ts')
    const sources = await collectTraitSources(deps as never, 14)
    assert.equal(sources.length, 1)
    const text = JSON.stringify(captured)
    assert.ok(text.includes('"status":{"term":{"status":"active"}}') || text.includes('"term":{"status":"active"}'), '只要 active')
    assert.ok(text.includes('"must_not"'), '有排除条件')
    assert.ok(text.includes('"identity"'), '排除 identity')
    assert.ok(text.includes('"mood"'), '排除情绪文档')
    assert.ok(text.includes('2026-10-16'), '时间窗 = 14 天前')
  })
})

describe('writeTraitCandidate：幂等', () => {
  test('同内容重复写入时第二次返回 written=false（409 不覆盖已采纳/已拒绝）', async () => {
    const { writeTraitCandidate } = await import('../src/memory/traits.ts')
    const written: string[] = []
    let conflict = false
    const deps = {
      userId: 'u1',
      personalPrefix: 'personal_memory_',
      reader: { search: async () => ({ hits: [] }) },
      writer: {
        index: async (_i: string, doc: unknown, opts: { id?: string }) => {
          if (conflict) throw { status: 409 }
          written.push(String(opts.id))
          return { id: String(opts.id), result: 'created', status: 200 }
        },
      },
    }
    const trait = { content: '你倾向于先给结论', evidence_ids: ['a1', 'b2'] }
    const first = await writeTraitCandidate(deps as never, trait, 14)
    assert.equal(first.written, true)
    conflict = true
    const second = await writeTraitCandidate(deps as never, trait, 14)
    assert.equal(second.written, false)
    assert.equal(second.memory_id, first.memory_id, '同一个内容 → 同一个 id')
  })
})

describe('runTraitsJob：编排与降级', () => {
  test('素材不足两条时跳过，不调用模型', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    let called = false
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: { search: async () => ({ hits: [{ source: { memory_id: 'a1', content: 'x', memory_type: 'fact' } }] }) },
        writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
      } as never,
      { days: 14, summarize: async () => { called = true; return '[]' } },
    )
    assert.equal(result.skipped, 'too_few_sources')
    assert.equal(called, false)
  })

  test('dry_run 不落库', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    let wrote = 0
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: { search: async () => ({ hits: SOURCES.map((s) => ({ source: s })) }) },
        writer: { index: async () => { wrote += 1; return { id: 'x', result: 'created', status: 200 } } },
      } as never,
      { days: 14, summarize: async () => '[{"content":"你偏好先确认","evidence_ids":["a1","c3"]}]', dryRun: true },
    )
    assert.equal(result.candidates, 1)
    assert.equal(result.written, 0)
    assert.equal(wrote, 0)
    assert.equal(result.skipped, 'dry_run')
  })

  test('模型给空数组时零候选，不报错', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: { search: async () => ({ hits: SOURCES.map((s) => ({ source: s })) }) },
        writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
      } as never,
      { days: 14, summarize: async () => '[]' },
    )
    assert.equal(result.candidates, 0)
    assert.equal(result.written, 0)
  })
})

describe('偏好类证据：一条即可支撑（阶段 7.2 修正）', () => {
  test('preference 类型单条证据能通过', () => {
    const types = new Map([['p1', 'preference'], ['f1', 'fact']])
    const out = parseTraitsOutput(
      '[{"content":"你希望提交合并成一次","evidence_ids":["p1"]}]',
      new Set(['p1', 'f1']),
      types,
    )
    assert.equal(out.length, 1)
    assert.deepEqual(out[0]?.evidence_ids, ['p1'])
  })

  test('fact 类型单条证据仍然被拒（必须两条互相印证）', () => {
    const types = new Map([['f1', 'fact']])
    const out = parseTraitsOutput(
      '[{"content":"你倾向于先验证","evidence_ids":["f1"]}]',
      new Set(['f1']),
      types,
    )
    assert.equal(out.length, 0)
  })

  test('不传 sourceTypes 时退回严格模式（向后兼容）', () => {
    const out = parseTraitsOutput(
      '[{"content":"x","evidence_ids":["a"]}]',
      new Set(['a']),
    )
    assert.equal(out.length, 0)
  })
})
