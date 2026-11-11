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

  // 2026-11-10 审查 #12：content_sha256 必须与 buildMemoryDoc 同口径（sha256 64 位）。
  // 旧版写 `hashContent()`（FNV-1a **8 位**），而 dedupeBody（dsl.ts:283）校验 64 位 hex、
  // 校验不过会直接抛 → 候选与 memory_save 永远互相认不出，同一正文两边各存一份。
  test('content_sha256 与 memory_save 同口径（dedupeBody 能互相命中）', async () => {
    const { writeTraitCandidate } = await import('../src/memory/traits.ts')
    const { buildMemoryDoc } = await import('../src/memory/save.ts')
    const { dedupeBody } = await import('../src/es/dsl.ts')

    let doc: Record<string, unknown> | undefined
    const deps = {
      userId: 'u1',
      personalPrefix: 'personal_memory_',
      reader: { search: async () => ({ hits: [] }) },
      writer: {
        index: async (_i: string, d: unknown) => {
          doc = d as Record<string, unknown>
          return { id: 'x', result: 'created', status: 200 }
        },
      },
    }
    const content = '你倾向于先给结论，再解释理由'
    await writeTraitCandidate(deps as never, { content, evidence_ids: ['a1'] }, 14)
    assert.ok(doc, '候选应当写出去了')

    // 同一条正文走 memory_save 的口径，两边必须算出同一个 sha
    const viaSave = buildMemoryDoc(
      { content },
      { userId: 'u1', personalPrefix: 'personal_memory_', defaultDomain: 'general' },
      { now: new Date(), memoryId: 'probe', embedding: null },
    )
    assert.equal(
      doc!.content_sha256,
      viaSave.contentSha256,
      '候选的去重键必须与 memory_save 一致，否则同正文两边各存一份',
    )
    // 这一句是判据本体：旧版（8 位 FNV）会抛「需要 64 位小写十六进制」
    assert.doesNotThrow(() => dedupeBody(String(doc!.content_sha256)), 'dedupeBody 必须认得这个 sha')
    assert.equal(doc!.content_exact, content, '标识符字段也要与正文同源')
  })

  // 2026-11-02 评审：LLM 产物也必须过写入准入（此前只挂在 memory_save 上）
  test('候选里含凭据 → 不落库、标 quarantined', async () => {
    const { writeTraitCandidate } = await import('../src/memory/traits.ts')
    const wrote: unknown[] = []
    const deps = {
      userId: 'u1',
      personalPrefix: 'personal_memory_',
      reader: { search: async () => ({ hits: [] }) },
      writer: { index: async (_i: string, doc: unknown) => { wrote.push(doc); return { id: 'x', result: 'created', status: 200 } } },
    }
    const result = await writeTraitCandidate(
      deps as never,
      { content: '你常用口令是 Abcd1234ef', evidence_ids: [] },
      14,
    )
    assert.equal(result.written, false)
    assert.equal(result.quarantined, true)
    assert.equal(wrote.length, 0, '命中准入就不该写库')
  })
})

describe('output schema：additionalProperties:false 下漏声明就是整条非法', () => {
  // 2026-11-02 审计发现：runTraitsJob 返回新增的 blocked，但 schema 没声明 →
  // memory_traits 真跑一次就会 `value.blocked is not a declared property`（与 asOf 同型）。
  test('blocked 必须被 schema 声明', async () => {
    const { defineTraitsTool } = await import('../src/memory/traits.ts')
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
    const tool = defineTraitsTool({} as never)
    const value = {
      sources: 1,
      candidates: 1,
      written: 0,
      duplicates: 0,
      quotaSkipped: 0,
      concreteSkipped: 0,
      blocked: 1,
      skipped: '',
      text: 'x',
    }
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
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

  // 2026-11-10 审查 #15：`[诊断]` 原文必须在 **dry_run=false** 时也能看到。
  // 旧版 rawPreview 只在干跑分支填，而线上跑的恰恰是 dry_run=false ——
  // 于是「模型给了 0 条候选」与「路由没配好、模型返回了 [诊断]…」在返回上一模一样，
  // 用户只看到 0，静默失败无从发现（v0.6.48 的启动预警只看配置字符串非空，兜不住「填错」）。
  test('0 候选且非干跑 → 返回里带模型原始输出（能区分「真没得提炼」与「路由坏了」）', async () => {
    const { defineTraitsTool } = await import('../src/memory/traits.ts')
    const DIAG = '[诊断] 选不到模型路由（provider/model 为空或无效）'
    const tool = defineTraitsTool({
      userId: 'u1',
      personalPrefix: 'personal_memory_',
      reader: { search: async () => ({ hits: SOURCES.map((s) => ({ source: s })) }) },
      writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
      summarize: async () => DIAG,
    } as never)

    const value = (await tool.execute(
      { dry_run: false },
      { signal: new AbortController().signal } as never,
    )) as { candidates: number; text: string; rawPreview?: string }

    assert.equal(value.candidates, 0, '诊断字符串解析不出候选')
    assert.ok(value.rawPreview?.includes('[诊断]'), `rawPreview 必须带原文，实际 ${String(value.rawPreview)}`)
    assert.ok(
      value.text.includes('[诊断]'),
      `返回 text 也要能看到 —— 否则用户只看到「0 条候选」：${value.text}`,
    )
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

/**
 * 判重：模型每批都换句措辞，精确内容哈希拦不住同义重复。
 * 2026-10-31 实测：一次提炼新写的 7 条里 3 条是旧 pending 的同义改写。
 */
describe('判重：同义候选不重复写入', () => {
  const ONE_CANDIDATE = '[{"content":"你偏好先给结论","evidence_ids":["a1","c3"]}]'

  /** reader 会被调用两次：取素材（无 knn）与判重（有 knn），必须分开回放 */
  function makeReader(near: Array<{ id: string; score: number; source: Record<string, unknown> }>) {
    return {
      search: async (_index: string, body: Record<string, unknown>) => {
        if (body['knn'] !== undefined) return { hits: near }
        return { hits: SOURCES.map((s) => ({ source: s })) }
      },
    }
  }

  const EMBED = { embed: async () => [0.1, 0.2, 0.3, 0.4] }

  test('相似度达到阈值时跳过，不写入', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    let wrote = 0
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: makeReader([{ id: 'trait-old', score: 0.95, source: { memory_id: 'trait-old', status: 'pending' } }]),
        writer: { index: async () => { wrote += 1; return { id: 'x', result: 'created', status: 200 } } },
        embed: EMBED, dims: 4,
      } as never,
      { days: 14, summarize: async () => ONE_CANDIDATE },
    )
    assert.equal(result.duplicates, 1)
    assert.equal(result.written, 0)
    assert.equal(wrote, 0, '被判定重复时不应调用写入')
  })

  test('相似度低于阈值时照常写入', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    let wrote = 0
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: makeReader([{ id: 'trait-other', score: 0.6, source: { memory_id: 'trait-other', status: 'pending' } }]),
        writer: { index: async () => { wrote += 1; return { id: 'x', result: 'created', status: 200 } } },
        embed: EMBED, dims: 4,
      } as never,
      { days: 14, summarize: async () => ONE_CANDIDATE },
    )
    assert.equal(result.duplicates, 0)
    assert.equal(result.written, 1)
    assert.equal(wrote, 1)
  })

  test('已拒绝(archived)的旧候选不参与判重——后来找到更强证据应当能重新提出', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: makeReader([{ id: 'trait-old', score: 0.99, source: { memory_id: 'trait-old', status: 'archived' } }]),
        writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
        embed: EMBED, dims: 4,
      } as never,
      { days: 14, summarize: async () => ONE_CANDIDATE },
    )
    assert.equal(result.written, 1)
    assert.equal(result.duplicates, 0)
  })

  test('embedding 不可用时跳过判重、照常写入（判重不能把提炼卡死）', async () => {
    const { runTraitsJob } = await import('../src/memory/traits.ts')
    const result = await runTraitsJob(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: makeReader([{ id: 'trait-old', score: 0.99, source: { memory_id: 'trait-old', status: 'pending' } }]),
        writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
        // 不给 embed / dims
      } as never,
      { days: 14, summarize: async () => ONE_CANDIDATE },
    )
    assert.equal(result.written, 1)
    assert.equal(result.duplicates, 0)
  })

  test('写入的候选带 embedding 向量（没有向量，下一批就查不到它）', async () => {
    const { writeTraitCandidate } = await import('../src/memory/traits.ts')
    let captured: Record<string, unknown> | null = null
    await writeTraitCandidate(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: { search: async () => ({ hits: [] }) },
        writer: { index: async (_i: string, doc: unknown) => { captured = doc as Record<string, unknown>; return { id: 'x', result: 'created', status: 200 } } },
        embed: EMBED, dims: 4,
      } as never,
      { content: '你偏好先给结论', evidence_ids: ['a1', 'c3'] },
      14,
    )
    assert.deepEqual((captured as unknown as Record<string, unknown>)['embedding'], [0.1, 0.2, 0.3, 0.4])
  })

  test('embedding 失败时不阻断写入（只是这条以后查不到向量）', async () => {
    const { writeTraitCandidate } = await import('../src/memory/traits.ts')
    let captured: Record<string, unknown> | null = null
    const result = await writeTraitCandidate(
      {
        userId: 'u1', personalPrefix: 'personal_memory_',
        reader: { search: async () => ({ hits: [] }) },
        writer: { index: async (_i: string, doc: unknown) => { captured = doc as Record<string, unknown>; return { id: 'x', result: 'created', status: 200 } } },
        embed: { embed: async () => { throw new Error('ollama down') } }, dims: 4,
      } as never,
      { content: '你偏好先给结论', evidence_ids: ['a1', 'c3'] },
      14,
    )
    assert.equal(result.written, true, '向量失败不能把候选一起丢掉')
    assert.equal((captured as unknown as Record<string, unknown>)['embedding'], undefined)
  })
})

// ── 每日配额：候选攒到人手审不过来，是这一段的起因（2026-11-01 一天 22 条）──

function quotaDeps(alreadyWrittenToday: number, pendingTotal = 0) {
  const written: string[] = []
  const deps = {
    userId: 'tester',
    personalPrefix: 'personal_memory_',
    reader: {
      search: async (_index: string, body: Record<string, unknown>) => {
        const text = JSON.stringify(body)
        // 判重用的 kNN：一律「没有相似条目」，把变量控制在配额这一条上
        if (text.includes('"knn"')) return { total: 0, hits: [] }
        // 两条计数查询都含 "pending"，靠 range 区分（存量闸门不带 created_at 范围）：
        //  · 每日增量配额：status ∈ {pending,active} + created_at range
        //  · 待审存量闸门（2026-11-03）：只 status=pending，无 range
        if (text.includes('"pending"') && text.includes('"range"')) return { total: alreadyWrittenToday, hits: [] }
        if (text.includes('"pending"')) return { total: pendingTotal, hits: [] }
        // 其余是素材查询：给两条真实 sense，否则 too_few_sources 会先挡住
        return {
          total: 2,
          hits: [
            { id: 'm1', score: 1, source: { memory_id: 'm1', content: '素材一：改动前先验证', memory_type: 'fact' } },
            { id: 'm2', score: 1, source: { memory_id: 'm2', content: '素材二：结论要有证据', memory_type: 'fact' } },
          ],
        }
      },
    },
    writer: {
      index: async (_i: string, _doc: unknown, opts: { id?: string }) => {
        written.push(String(opts.id))
        return { id: String(opts.id), result: 'created', status: 200 }
      },
    },
    now: () => new Date('2026-11-01T10:00:00+08:00'),
  }
  return { deps, written }
}

const sixCandidates = JSON.stringify(
  Array.from({ length: 6 }, (_, i) => ({
    content: `第 ${i} 条稳定倾向：处理某类问题时我会先定位根因再动手，编号 ${i}`,
    evidence_ids: ['m1', 'm2'],
  })),
)

test('配额：今天已经写满，就一条都不写', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps, written } = quotaDeps(5)
  const result = await runTraitsJob(
    { ...deps, maxPerDay: 5 } as never,
    { days: 7, summarize: async () => sixCandidates },
  )
  assert.equal(result.skipped, 'quota_exhausted')
  assert.equal(result.written, 0)
  assert.equal(written.length, 0, '配额满了不能写任何一条')
})

test('配额：今天还剩 3 个名额，只写 3 条，其余计入 quotaSkipped', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps, written } = quotaDeps(2)
  const result = await runTraitsJob(
    { ...deps, maxPerDay: 5, maxOutput: 6 } as never,
    { days: 7, summarize: async () => sixCandidates },
  )
  assert.equal(result.written, 3)
  assert.equal(result.quotaSkipped, 3)
  assert.equal(written.length, 3)
})

// ── 存量闸门：待审不能超过 maxPending（用户 2026-11-03 定：超过不继续增长）──
// 与每日配额互补：每日闸管「今天写几条」，这个管「一共攒几条」。

test('存量：待审达到 20 条，连模型都不调，一条不写', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps, written } = quotaDeps(0, 20)
  let summarizeCalled = 0
  const result = await runTraitsJob(
    { ...deps, maxPending: 20 } as never,
    { days: 7, summarize: async () => { summarizeCalled += 1; return sixCandidates } },
  )
  assert.equal(result.skipped, 'pending_full')
  assert.equal(result.written, 0)
  assert.equal(written.length, 0)
  assert.equal(summarizeCalled, 0, '满了不该调模型——LLM 是这条链上最贵的一步')
  assert.equal(result.pendingCount, 20, '要把存量带出来，文案才能说清为什么没跑')
  assert.equal(result.maxPending, 20)
})

test('存量：19 条时不拦（上限是「达到才停」，不是「到了就停」）', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps, written } = quotaDeps(0, 19)
  const result = await runTraitsJob(
    { ...deps, maxPending: 20, maxPerDay: 5 } as never,
    { days: 7, summarize: async () => sixCandidates },
  )
  assert.notEqual(result.skipped, 'pending_full')
  assert.ok(written.length > 0, '19 条还没满，应该继续写')
})

test('存量：dry_run 满了也停——写不进去，预演没有意义', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps } = quotaDeps(0, 25)
  const result = await runTraitsJob(
    { ...deps, maxPending: 20 } as never,
    { days: 7, dryRun: true, summarize: async () => sixCandidates },
  )
  assert.equal(result.skipped, 'pending_full')
  assert.equal(result.pendingCount, 25, '超上限的存量如实报出来，不是报 20')
})

test('存量与每日闸门互不干扰：存量没满时每日闸门照常生效', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  // 今日已写 5（每日满），存量只有 3（没满）→ 应该是 quota_exhausted 而不是 pending_full
  const { deps, written } = quotaDeps(5, 3)
  const result = await runTraitsJob(
    { ...deps, maxPending: 20, maxPerDay: 5 } as never,
    { days: 7, summarize: async () => sixCandidates },
  )
  assert.equal(result.skipped, 'quota_exhausted')
  assert.equal(written.length, 0)
})

test('存量：默认上限 20（TRAITS_MAX_PENDING），配置没传也生效', async () => {
  const { runTraitsJob, TRAITS_MAX_PENDING } = await import('../src/memory/traits.ts')
  assert.equal(TRAITS_MAX_PENDING, 20, '用户定的数：待审核不能超过 20 条')
  const { deps } = quotaDeps(0, 20)
  // 不传 maxPending：应该回落到常量 20 并触发
  const result = await runTraitsJob(
    { ...deps } as never,
    { days: 7, summarize: async () => sixCandidates },
  )
  assert.equal(result.skipped, 'pending_full')
  assert.equal(result.maxPending, 20)
})

test('配额：maxPerDay 生效，单次模型吐 8 条也只写 5 条', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps, written } = quotaDeps(0)
  const eight = JSON.stringify(
    Array.from({ length: 8 }, (_, i) => ({
      content: `倾向 ${i}：这类问题我会先看真实数据再下结论，编号 ${i}`,
      evidence_ids: ['m1', 'm2'],
    })),
  )
  const result = await runTraitsJob(
    { ...deps, maxPerDay: 5, maxOutput: 8 } as never,
    { days: 7, summarize: async () => eight },
  )
  assert.equal(result.written, 5, '写入数被 maxPerDay 截住')
  assert.equal(result.quotaSkipped, 3)
  assert.equal(written.length, 5)
})

// ── 抽象度：具体到项目操作就不该进候选（用户 2026-11-01："不要这么具体"）──

test('isTooConcrete：命令/路径/端口/字段名/版本号都算太具体', async () => {
  const { isTooConcrete } = await import('../src/memory/traits.ts')
  const tooConcrete = [
    'framework 改动必须先 `mvn deploy` 到 Nexus 再触发构建',
    '改完要去 /data/dsh/profiles 里确认',
    'ES 只绑在 <ES_HOST>:9200',
    '写之前先看 t_lottery_order 的 win_price 列',
    '镜像要打 v0.4.0 这个 tag',
  ]
  for (const text of tooConcrete) {
    assert.equal(isTooConcrete(text), true, `应判为太具体：${text}`)
  }
})

test('isTooConcrete：抽象表述不该被误杀', async () => {
  const { isTooConcrete } = await import('../src/memory/traits.ts')
  const fine = [
    '你倾向于先给结论再解释理由',
    '判断是否生效看外部可验证的结果，而不是返回值有没有报错',
    '破坏性变更先完成不可逆的前置准备，再动代码',
    '处理时间先确认时区，再下结论',
    '排查数据库问题时先看执行计划',
  ]
  for (const text of fine) {
    assert.equal(isTooConcrete(text), false, `不该判为太具体：${text}`)
  }
})

test('提炼：写得太具体的候选会被丢弃，不计入写入', async () => {
  const { runTraitsJob } = await import('../src/memory/traits.ts')
  const { deps, written } = quotaDeps(0)
  const mixed = JSON.stringify([
    { content: '改动要先 `docker compose up` 再验证', evidence_ids: ['m1', 'm2'] },
    { content: '你判断是否生效看外部可验证的结果，而不是返回值', evidence_ids: ['m1', 'm2'] },
  ])
  const result = await runTraitsJob(
    { ...deps, maxPerDay: 5, maxOutput: 5 } as never,
    { days: 7, summarize: async () => mixed },
  )
  assert.equal(result.written, 1, '抽象那条应写入')
  assert.equal(result.concreteSkipped, 1, '具体那条应被丢弃')
  assert.equal(written.length, 1)
})

// ── 锚点：定过稿的条目用更严的阈值判重（用户 2026-11-01）──

function dupDeps(hit: { score: number; anchor: boolean }) {
  const deps = {
    userId: 'tester',
    personalPrefix: 'personal_memory_',
    // 判重依赖向量服务：没有 embed/dims 就直接短路返回 null（按设计）
    embed: { embed: async () => new Array(1024).fill(0.01) },
    dims: 1024,
    reader: {
      search: async (_index: string, body: Record<string, unknown>) => {
        const text = JSON.stringify(body)
        // 判重走的 kNN 查询：返回一条「像但不够像」的既有自述
        if (text.includes('"knn"')) {
          return {
            total: 1,
            hits: [
              {
                id: 'old-1',
                score: hit.score,
                source: {
                  memory_id: 'old-1',
                  content: '你倾向于先给结论再解释理由',
                  status: 'active',
                  ...(hit.anchor ? { anchor: true } : {}),
                },
              },
            ],
          }
        }
        return { total: 0, hits: [] }
      },
    },
    writer: { index: async () => ({ id: 'x', result: 'created', status: 200 }) },
  }
  return deps
}

test('判重：普通条目 0.85 不算重复（阈值 0.88）', async () => {
  const { findTraitDuplicate } = await import('../src/memory/traits.ts')
  const dup = await findTraitDuplicate(dupDeps({ score: 0.85, anchor: false }) as never, '你倾向于先给结论再解释')
  assert.equal(dup, null)
})

test('判重：锚定条目 0.85 就算重复（阈值降到 0.82）', async () => {
  const { findTraitDuplicate } = await import('../src/memory/traits.ts')
  const dup = await findTraitDuplicate(dupDeps({ score: 0.85, anchor: true }) as never, '你倾向于先给结论再解释')
  assert.ok(dup !== null, '锚定条目应该拦住')
  assert.equal(dup.anchored, true)
  assert.equal(dup.threshold, 0.82)
})

test('判重：锚定条目 0.80 仍然不算重复（比阈值低 0.02）', async () => {
  const { findTraitDuplicate } = await import('../src/memory/traits.ts')
  const dup = await findTraitDuplicate(dupDeps({ score: 0.8, anchor: true }) as never, '你倾向于先给结论再解释')
  assert.equal(dup, null, '低于 0.82 不该拦')
})
