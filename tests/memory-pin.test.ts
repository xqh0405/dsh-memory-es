/**
 * 阶段 33：pinned 的写入路径（`memory_save{pinned}` 与 `memory_update_status{pin|unpin}`）。
 *
 * 守四件事：
 *  1. 写入时显式落 `pinned: false`（不是省略）——否则「没置顶」与「老文档缺字段」在统计口径上混在一起；
 *  2. **去重分支不能吞掉 pinned**：库里已有同内容但未置顶时，补一次只改 pinned 的写；
 *  3. pin/unpin 只改 pinned 一位，不动 status（置顶与可见性是两条正交的轴）；
 *  4. pin 一条非 active 的记忆要**如实说它不会注入**，不能给「已生效」的错觉。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildMemoryDoc, saveMemory, type SaveDeps } from '../src/memory/save.ts'
import {
  composeInjection,
  normalizePinnedHits,
  pinnedSearchBody,
  PINNED_FETCH_SIZE,
  PINNED_MAX_ITEMS,
} from '../src/recall-inject.ts'
import { defineStatusTool, updateStatus, type UpdateStatusDeps } from '../src/memory/status.ts'
import { createEsClient } from '../src/es/http.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'

const NOW = new Date('2026-11-09T10:00:00.000Z')
const INDEX = 'personal_memory_xqh'
const VECTOR = new Array(1024).fill(0.01)

interface Captured {
  writes: Array<{ path: string; body: Record<string, unknown> }>
}

async function startFake(
  docs: Record<string, Record<string, unknown>> = {},
  opts: { duplicate?: string | null } = {},
) {
  const captured: Captured = { writes: [] }
  const fake = await startFakeEs((req, res) => {
    if (req.path.includes('/_search')) {
      const dupId = opts.duplicate ?? null
      sendJson(res, 200, {
        took: 1,
        hits: {
          total: { value: dupId ? 1 : 0, relation: 'eq' },
          hits: dupId ? [{ _id: dupId, _score: 1, _source: { memory_id: dupId, pinned: false } }] : [],
        },
      })
      return
    }
    const getMatch = /^\/[^/]+\/_doc\/([^/?]+)/.exec(req.path)
    const updateMatch = /^\/[^/]+\/_update\/([^/?]+)/.exec(req.path)
    if (getMatch && req.method === 'GET') {
      const id = decodeURIComponent(getMatch[1])
      const source = docs[id]
      if (!source) {
        sendJson(res, 404, { _index: INDEX, _id: id, found: false })
        return
      }
      sendJson(res, 200, { _index: INDEX, _id: id, found: true, _source: source })
      return
    }
    const body = req.body.trim() === '' ? {} : (JSON.parse(req.body) as Record<string, unknown>)
    captured.writes.push({ path: req.path, body })
    if (updateMatch) {
      const id = decodeURIComponent(updateMatch[1])
      const patch = (body.doc ?? body) as Record<string, unknown>
      Object.assign(docs[id] ?? (docs[id] = {}), patch)
      sendJson(res, 200, { _index: INDEX, _id: id, result: 'updated' })
      return
    }
    const id = (body.memory_id as string) ?? 'generated'
    docs[id] = body
    sendJson(res, 201, { _index: INDEX, _id: id, result: 'created' })
  })
  return { fake, captured, docs }
}

function saveDeps(fakeUrl: string, overrides: Partial<SaveDeps> = {}): SaveDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    defaultDomain: 'general',
    reader: createEsClient({ url: fakeUrl, username: 'r', password: 'p' }),
    writer: createEsClient({ url: fakeUrl, username: 'w', password: 'p' }),
    embed: { embed: async () => VECTOR },
    now: () => NOW,
    ...overrides,
  }
}

function statusDeps(fakeUrl: string): UpdateStatusDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    reader: createEsClient({ url: fakeUrl, username: 'r', password: 'p' }),
    writer: createEsClient({ url: fakeUrl, username: 'w', password: 'p' }),
    now: () => NOW,
  }
}

describe('memory_save 的 pinned 参数', () => {
  test('pinned=true 写进文档', async () => {
    const { fake, docs } = await startFake()
    try {
      const result = await saveMemory(saveDeps(fake.url), { content: '回复先给结论再给理由', pinned: true })
      assert.equal(result.status, 'created')
      const doc = Object.values(docs)[0]
      assert.equal(doc.pinned, true)
    } finally {
      await fake.close()
    }
  })

  test('不给 pinned 时显式写 false（不是省略）', async () => {
    const { fake, docs } = await startFake()
    try {
      await saveMemory(saveDeps(fake.url), { content: '一条普通事实' })
      const doc = Object.values(docs)[0]
      assert.equal(doc.pinned, false, '缺失与 false 在统计口径上不等价，必须显式写')
    } finally {
      await fake.close()
    }
  })

  test('去重时 pinned=true 仍会升级已有条目（不能静默吞掉）', async () => {
    const { fake, captured, docs } = await startFake({ existing1: { memory_id: 'existing1', pinned: false } }, { duplicate: 'existing1' })
    try {
      const result = await saveMemory(saveDeps(fake.url), { content: '回复先给结论', pinned: true })
      assert.equal(result.status, 'merged')
      assert.match(result.text, /置为常驻/)
      const update = captured.writes.find((w) => w.path.includes('/_update/'))
      assert.ok(update, '必须补一次 update')
      assert.equal((update.body.doc as Record<string, unknown>).pinned, true)
      assert.equal(docs.existing1.pinned, true)
    } finally {
      await fake.close()
    }
  })

  test('去重且没要求置顶时，不写任何东西', async () => {
    const { fake, captured } = await startFake({ existing1: { memory_id: 'existing1', pinned: false } }, { duplicate: 'existing1' })
    try {
      const result = await saveMemory(saveDeps(fake.url), { content: '重复内容' })
      assert.equal(result.status, 'merged')
      assert.equal(captured.writes.length, 0, '没置顶诉求就不该有写操作')
    } finally {
      await fake.close()
    }
  })
})

describe('buildMemoryDoc 的 pinned 字段', () => {
  test('缺省 false、true 时 true（纯函数层）', () => {
    const deps = { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'general' } as never
    const base = { content: '甲', memoryId: 'm1', embedding: null, now: NOW }
    const a = buildMemoryDoc({ content: '甲' }, deps, base as never)
    const b = buildMemoryDoc({ content: '甲', pinned: true }, deps, base as never)
    assert.equal(a.doc.pinned, false)
    assert.equal(b.doc.pinned, true)
  })
})

describe('memory_update_status 的 pin / unpin', () => {
  test('pin 只改 pinned，不动 status', async () => {
    const { fake, docs } = await startFake({ m1: { memory_id: 'm1', user_id: 'xqh', status: 'active', pinned: false } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm1', action: 'pin' })
      assert.equal(result.status, 'active', 'status 不该被 pin 改动')
      assert.equal(docs.m1.pinned, true)
      assert.match(result.text, /每轮注入/)
    } finally {
      await fake.close()
    }
  })

  // 2026-11-10 审查 #14：回执不能只承诺「每轮注入都会带上它」——
  // 常驻段实际有 8 条上限、单条截断到 200 字，第 9 条被挤掉时旧回执毫无提示。
  test('pin 回执必须带上限与当前数量（不能只承诺「每轮都会带上」）', async () => {
    const { fake } = await startFake({ m1: { memory_id: 'm1', user_id: 'xqh', status: 'active', pinned: false } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm1', action: 'pin' })
      assert.match(result.text, /每轮注入/, '原承诺保留')
      assert.match(result.text, /8 条/, '要说出常驻段的条数上限')
      assert.match(result.text, /200 字/, '要说出单条会被截断')
      assert.match(result.text, /常驻共 \d+ 条/, '要报当前数量，否则第 9 条被挤掉时无从察觉')
    } finally {
      await fake.close()
    }
  })

  test('数不出常驻数时回执降级成静态上限，且 pin 本身不失败', async () => {
    // 只给 get、不给 search 的 deps（MemoryStoreDeps 里 search 是可选能力）
    const { fake, docs } = await startFake({ m1: { memory_id: 'm1', user_id: 'xqh', status: 'active', pinned: false } })
    try {
      const deps = statusDeps(fake.url)
      const limited = { ...deps, reader: { get: deps.reader.get.bind(deps.reader) } }
      const result = await updateStatus(limited as never, { memory_id: 'm1', action: 'pin' })
      assert.equal(docs.m1.pinned, true, 'pin 必须照常生效')
      assert.match(result.text, /8 条/, '降级时仍要报静态上限')
      assert.doesNotMatch(result.text, /常驻共/, '没有数就不编一个数出来')
    } finally {
      await fake.close()
    }
  })

  test('unpin 取消常驻，但仍可被检索命中', async () => {
    const { fake, docs } = await startFake({ m1: { memory_id: 'm1', user_id: 'xqh', status: 'active', pinned: true } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm1', action: 'unpin' })
      assert.equal(docs.m1.pinned, false)
      assert.match(result.text, /不再每轮注入/)
    } finally {
      await fake.close()
    }
  })

  test('pin 一条 archived 的记忆：如实说它不会注入（不给「已生效」的错觉）', async () => {
    const { fake } = await startFake({ m2: { memory_id: 'm2', user_id: 'xqh', status: 'archived', pinned: false } })
    try {
      const result = await updateStatus(statusDeps(fake.url), { memory_id: 'm2', action: 'pin' })
      assert.equal(result.status, 'archived')
      assert.match(result.text, /不会注入/)
      assert.match(result.text, /restore/)
    } finally {
      await fake.close()
    }
  })

  test('工具描述里写清 pin 的语义（模型靠描述选工具）', () => {
    const tool = defineStatusTool(statusDeps('http://127.0.0.1:1')) as unknown as {
      description: string
      parameters: { properties: Record<string, { enum?: string[]; description?: string }> }
    }
    assert.match(tool.description, /pin/)
    assert.match(tool.description, /常驻/)
    const action = tool.parameters.properties.action
    assert.equal(action.enum?.includes('pin'), true)
    assert.equal(action.enum?.includes('unpin'), true)
    assert.match(String(action.description), /常驻/)
  })
})

// 2026-11-10 审查 #13：pinned 段的**取数**（不是注入，是取数）。
// 旧版 `pinnedSearchBody(PINNED_MAX_ITEMS * 2)` 且**没有 sort** —— filter 查询 `_score` 恒定，
// 一旦置顶数超过 size，「哪 size 条进候选」由分片内部顺序决定：
// 每轮注入集合可能抖动、部分常驻规则静默消失。线上单用户最多 4 条（尚未发作），属潜伏雷。
describe('pinned 取数池（审查 #13）', () => {
  test('取数池必须明显大于注入上限，且带确定性排序', () => {
    assert.ok(
      PINNED_FETCH_SIZE > PINNED_MAX_ITEMS * 2,
      `池子要够大，进程内按 importance 挑才有意义（${PINNED_FETCH_SIZE} vs 上限 ${PINNED_MAX_ITEMS}）`,
    )
    const body = pinnedSearchBody(PINNED_FETCH_SIZE)
    assert.equal(body.size, PINNED_FETCH_SIZE)
    assert.deepEqual(
      body.sort,
      [{ updated_at: 'desc' }],
      '没有 sort 时 size 截断选中哪批是不确定的 —— 同一份数据两次查询可能给出不同顺序',
    )
  })

  // 检索段一直排除 identity/persona/journal（自述/人格/日记会挤占事实召回），
  // pinned 段却绕过了它 —— 被 pin 的未审核自述能每轮注入（2026-11-10 审查 #14）。
  // 两段口径必须一致；第二道闸是 #10 让 memory_save(identity) 只落 pending（status 过滤）。
  test('pinned 段排除非事实三类（与检索段口径一致）', () => {
    const body = pinnedSearchBody(PINNED_FETCH_SIZE) as {
      query: { bool: { must_not?: Array<{ terms?: { memory_type?: string[] } }> } }
    }
    const mustNot = body.query.bool.must_not
    assert.ok(Array.isArray(mustNot) && mustNot.length > 0, '必须有 must_not 排除')
    const types = mustNot[0]?.terms?.memory_type ?? []
    for (const type of ['identity', 'persona', 'journal']) {
      assert.ok(types.includes(type), `${type} 必须被 pinned 段排除，实际 ${JSON.stringify(types)}`)
    }
    assert.equal(types.includes('preference'), false, '正常类型（如 preference）不该被排除')
  })

  test('取数池常量与注入上限的关系没被改反', () => {
    // 这条是防呆：哪天有人把 PINNED_FETCH_SIZE 改成 ≤ PINNED_MAX_ITEMS，
    // 上面那条 20 条候选的用例会先红；这里给出更直白的失败信息。
    assert.ok(PINNED_FETCH_SIZE >= 32, '池子至少要给 4 倍余量，否则 importance 排序形同虚设')
  })

  test('20 条候选：连续 3 次挑出的集合一致，且 critical 全部落选之外为零', () => {
    // 20 条 = 6 条 critical + 14 条 normal，顺序刻意打乱（模拟分片返回顺序随机）
    const rows: Array<{ id: string; source: Record<string, unknown> }> = []
    for (let i = 0; i < 14; i += 1) {
      rows.push({
        id: `n${i}`,
        source: {
          memory_id: `n${i}`,
          content: `普通常驻规则第 ${i} 条`,
          importance: 'normal',
          updated_at: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`,
          memory_type: 'fact',
          domain: 'general',
        },
      })
    }
    for (let i = 0; i < 6; i += 1) {
      rows.push({
        id: `c${i}`,
        source: {
          memory_id: `c${i}`,
          content: `关键常驻规则第 ${i} 条`,
          importance: 'critical',
          updated_at: `2026-11-0${(i % 9) + 1}T01:00:00.000Z`,
          memory_type: 'fact',
          domain: 'general',
        },
      })
    }

    const pick = (): string[] =>
      composeInjection({
        pinned: normalizePinnedHits(rows),
        hits: [],
        pinnedEnabled: true,
        pinnedMaxChars: 800,
        maxItems: 3,
        maxChars: 600,
      }).pinned.map((item) => item.memory_id)

    const first = pick()
    const second = pick()
    const third = pick()

    assert.equal(first.length, PINNED_MAX_ITEMS, '注入上限 8 条')
    assert.deepEqual(second, first, '第二次必须与第一次一致（不能每轮抖动）')
    assert.deepEqual(third, first, '第三次必须与第一次一致')

    const critical = new Set(['c0', 'c1', 'c2', 'c3', 'c4', 'c5'])
    const pickedCritical = first.filter((id) => critical.has(id))
    assert.equal(pickedCritical.length, 6, `6 条 critical 必须全部入选，实际 ${JSON.stringify(first)}`)
    assert.equal(first.length - pickedCritical.length, 2, '剩 2 个名额给 normal')
  })
})
