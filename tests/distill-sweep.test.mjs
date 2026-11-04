/**
 * 蒸馏兜底清扫（runDistillSweep）的判定层。
 *
 * 2026-11-04 巡检发现的缺口：`memory_save` 的 onSaved 只覆盖工具保存这一条路，
 * 批量入库（ingest.ts 直调 saveMemory）与当时蒸馏失败的条目会永远停在
 * `distill_state=pending`（6 个用户索引积压 158 条，没有消费者）。
 *
 * 这组测试钉住清扫的四条边界：
 *  1. 只查 pending 且**够老**的条目（给 onSaved 的即时蒸馏留窗口，不双跑）；
 *  2. 已带 summary 的（巡检管线蒸馏过）直标 done，不重复烧模型；
 *  3. 内容问题计次到顶标 failed；环境问题不计次、留 pending —— 否则一次
 *     LLM 停机会把整批条目误判死；
 *  4. 非 active（归档/候选）标 skipped 收口，不让它永远挂着污染 pending 计数。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

const { runDistillSweep } = await import('../src/memory/distillRunner.ts')

/** 合法的蒸馏输出（模型给 content 就算成功） */
const GOOD_OUTPUT = JSON.stringify({ content: '改写后的正文', summary: '一句话', keywords: ['a'] })

/**
 * 造一轮清扫的依赖。
 * hits: 查询返回的条目（直接给 _source 形状）；
 * llmOutput: 模型输出文本（null = 不给 llm 服务）；
 * failUpdate: writer.update 抛错（测「标不上去」的降级）。
 */
function makeSweep(hits, { llmOutput = GOOD_OUTPUT, failUpdate = false, provider = 'p', model = 'm' } = {}) {
  const updates = []
  const searches = []
  const llmCalls = { prepare: 0 }
  const attempts = new Map()

  const deps = {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    reader: {
      get: async (_index, id) => ({ id, source: { memory_id: id, user_id: 'xqh', content: '原文', distill_state: 'pending' } }),
      search: async (index, body) => {
        searches.push({ index, body })
        // 模拟真 ES：按 size 截断（否则测不出「单轮上限」）
        const size = typeof body.size === 'number' ? body.size : hits.length
        const sliced = hits.slice(0, size)
        return { took: 1, total: hits.length, hits: sliced.map((h, i) => ({ id: h.memory_id ?? `m${i}`, score: 1, source: h })) }
      },
    },
    writer: {
      update: async (index, id, patch) => {
        if (failUpdate) throw new Error('es down')
        updates.push({ index, id, patch })
        return { id, result: 'updated', status: 200 }
      },
    },
    llm:
      llmOutput === null
        ? null
        : {
            prepareCall: async () => {
              llmCalls.prepare += 1
              return {
                config: {},
                stream: async function* () {
                  yield { type: 'text-delta', text: llmOutput }
                },
              }
            },
          },
    provider,
    model,
    timeoutMs: 1000,
    attempts,
    log: () => {},
  }
  return { deps, updates, searches, llmCalls, attempts }
}

const PENDING = { memory_id: 'm1', content: '一段需要蒸馏的正文', domain: 'general', status: 'active', distill_state: 'pending' }

describe('runDistillSweep：查询边界', () => {
  test('只查 pending、且排除刚写入的（给 onSaved 留窗口）', async () => {
    const { deps, searches } = makeSweep([])
    await runDistillSweep(deps, { minAgeMinutes: 5 })

    assert.equal(searches.length, 1)
    const body = JSON.stringify(searches[0].body)
    assert.ok(body.includes('"distill_state":"pending"'), '只扫 pending')
    assert.ok(body.includes('"created_at"'), '带年龄下限，排除刚保存的（onSaved 可能正在蒸）')
    assert.ok(body.includes('"created_at":"asc"') || body.includes('created_at') && body.includes('asc'), '最老优先，积压先清')
  })

  // 2026-11-04 部署后实测：10 个容器只有 2 个能蒸馏，其余 8 个 LLM 不可用；
  // 而它们的 pending 里绝大多数已带 summary。若把模型闸当成整轮闸，
  // 这 100+ 条会永远清不掉——所以「无模型仍要处理不需模型的分支」是硬约束。
  test('没有 llm 服务 → 仍要查队列，把「带 summary」的直标 done（不吃模型的活照做）', async () => {
    const { deps, updates, searches } = makeSweep([{ ...PENDING, summary: '已有摘要' }], { llmOutput: null })
    const result = await runDistillSweep(deps)

    assert.equal(searches.length, 1, '必须查队列——否则不需模型的分支也没机会执行')
    assert.equal(result.scanned, 1)
    assert.equal(result.markedDone, 1, '带 summary 的标 done 不需要模型')
    assert.equal(updates[0].patch.distill_state, 'done')
    assert.equal(result.envDeferred, 0, '本轮没有需要模型的条目，就不该有环境失败记录')
  })

  test('没有 llm 服务 → 非 active 仍标 skipped', async () => {
    const { deps, updates } = makeSweep([{ ...PENDING, memory_id: 'm9', status: 'archived' }], { llmOutput: null })
    const result = await runDistillSweep(deps)

    assert.equal(result.markedSkipped, 1)
    assert.equal(updates[0].patch.distill_state, 'skipped')
  })

  test('没有 llm 服务 + 条目真需要蒸馏 → envDeferred，留 pending，不判死', async () => {
    const { deps, updates, attempts } = makeSweep([PENDING], { llmOutput: null })
    const result = await runDistillSweep(deps)

    assert.equal(result.envDeferred, 1)
    assert.equal(result.markedFailed, 0, '不能因为没模型就判死')
    assert.equal(updates.length, 0)
    assert.equal(attempts.size, 0, '环境失败不吃重试预算')
    assert.equal(result.reason, 'no_llm_service')
  })

  test('选不到模型路由 → 同样只缓不判（reason=no_model），带 summary 的照样标 done', async () => {
    const { deps, updates } = makeSweep(
      [{ ...PENDING, memory_id: 'm1', summary: '已有摘要' }, { ...PENDING, memory_id: 'm2' }],
      { provider: '', model: '' },
    )
    const result = await runDistillSweep(deps)

    assert.equal(result.markedDone, 1, '有 summary 的先收口')
    assert.equal(result.envDeferred, 1, '需要模型的留 pending')
    assert.equal(result.reason, 'no_model')
    assert.deepEqual(
      updates.map((u) => u.patch.distill_state),
      ['done'],
    )
  })
})

describe('runDistillSweep：处理分支', () => {
  test('正常条目 → 蒸馏成功、attempts 清空', async () => {
    const { deps, updates, llmCalls } = makeSweep([PENDING])
    const result = await runDistillSweep(deps)

    assert.equal(result.scanned, 1)
    assert.equal(result.distilled, 1)
    assert.equal(llmCalls.prepare, 1)
    // 蒸馏写入由 distillMemory 完成：distill_state=done
    assert.equal(updates.length, 1)
    assert.equal(updates[0].patch.distill_state, 'done')
    assert.equal(deps.attempts.size, 0, '成功后清计数')
  })

  test('已带 summary（巡检管线蒸馏过）→ 直标 done，不调模型', async () => {
    const { deps, updates, llmCalls } = makeSweep([
      { ...PENDING, summary: '蒸馏稿的摘要', semantic_keywords: 'kw1 kw2' },
    ])
    const result = await runDistillSweep(deps)

    assert.equal(result.markedDone, 1)
    assert.equal(result.distilled, 0)
    assert.equal(llmCalls.prepare, 0, '重复蒸馏是纯浪费，一次模型调用都不该有')
    assert.equal(updates[0].patch.distill_state, 'done')
  })

  test('非 active（归档/候选）→ 标 skipped 收口，不烧模型', async () => {
    const { deps, updates, llmCalls } = makeSweep([
      { ...PENDING, memory_id: 'm2', status: 'archived' },
      { ...PENDING, memory_id: 'm3', status: 'pending' },
    ])
    const result = await runDistillSweep(deps)

    assert.equal(result.markedSkipped, 2)
    assert.equal(llmCalls.prepare, 0)
    assert.deepEqual(
      updates.map((u) => u.patch.distill_state),
      ['skipped', 'skipped'],
    )
  })
})

describe('runDistillSweep：失败分类（计次 vs 不计次）', () => {
  /** 模型输出垃圾 → unparsable → content_fault=true → 计次 */
  test('内容问题计次：到 maxAttempts 标 failed 终态', async () => {
    const { deps, updates, attempts } = makeSweep([PENDING], { llmOutput: '根本不是 JSON' })

    // 第 1、2 次失败：留 pending，计次
    let r = await runDistillSweep(deps, { maxAttempts: 3 })
    assert.equal(r.distilled, 0)
    assert.equal(r.markedFailed, 0)
    assert.equal(attempts.get('m1'), 1)
    assert.equal(updates.length, 0, '没到上限不判死')

    r = await runDistillSweep(deps, { maxAttempts: 3 })
    assert.equal(attempts.get('m1'), 2)

    // 第 3 次 → 标 failed
    r = await runDistillSweep(deps, { maxAttempts: 3 })
    assert.equal(r.markedFailed, 1)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].patch.distill_state, 'failed')
    assert.equal(attempts.has('m1'), false, '判死后清计数')
  })

  test('环境问题不计次：LLM 调用抛错 → 留 pending、attempts 不动', async () => {
    const { deps, attempts } = makeSweep([PENDING])
    // 让 prepareCall 抛错（模拟超时/网络断）
    deps.llm.prepareCall = async () => {
      throw new Error('ETIMEDOUT')
    }

    const r = await runDistillSweep(deps, { maxAttempts: 3 })
    assert.equal(r.distilled, 0)
    assert.equal(r.envDeferred, 1, '归类为环境缓，不是内容失败')
    assert.equal(r.markedFailed, 0)
    assert.equal(attempts.size, 0, '环境失败绝不能吃掉重试预算——否则一次停机判死整批')
  })

  test('模型中途不可用 → 不提前整轮 return，同批里不需模型的条目照常收口', async () => {
    // 第 1 条真需要蒸馏（模型炸）→ envDeferred；第 2 条带 summary → 必须仍被标 done。
    // 这条钉住 2026-11-04 的坑：提前 return 会让后面的条目一起烂在 pending。
    const { deps, updates } = makeSweep([PENDING, { ...PENDING, memory_id: 'm2', summary: '已有摘要' }])
    deps.llm.prepareCall = async () => {
      throw new Error('service gone')
    }

    const r = await runDistillSweep(deps)
    assert.equal(r.envDeferred, 1, '需要模型的那条缓一轮')
    assert.equal(r.markedDone, 1, '带 summary 的那条不能被提前 return 带走')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, 'm2')
    assert.equal(updates[0].patch.distill_state, 'done')
  })
})

describe('runDistillSweep：标不上去的降级', () => {
  test('writer.update 抛错 → 不崩整轮、不虚报成功，条目留在 pending', async () => {
    const { deps } = makeSweep([{ ...PENDING, summary: '已有摘要' }], { failUpdate: true })

    const r = await runDistillSweep(deps)
    assert.equal(r.markedDone, 0, '写失败不能算成功')
    assert.equal(r.scanned, 1, '但这一轮本身跑完了')
    // 不抛错就是行为契约：清扫是后台任务，一条写失败不能让定时器那轮整个挂掉
  })

  test('查询直接抛错（ES 挂了）→ 异常冒泡给调用方（由定时器 catch 记日志）', async () => {
    const { deps } = makeSweep([])
    deps.reader.search = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    await assert.rejects(() => runDistillSweep(deps), /ECONNREFUSED/)
  })
})

describe('runDistillSweep：批量上限', () => {
  test('单轮最多处理 batch 条（默认 5），不把一轮拖成马拉松', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...PENDING, memory_id: `m${i}` }))
    const { deps, llmCalls } = makeSweep(many)

    const r = await runDistillSweep(deps, { batch: 3 })
    assert.equal(r.scanned, 3, '查询 size=batch，只捞 3 条')
    assert.equal(llmCalls.prepare, 3)
  })
})
