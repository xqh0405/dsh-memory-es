/**
 * 阶段 16 P0 影子召回的单元测试。
 *
 * 钉住的是四条不变式（它们比「功能对不对」更要紧）：
 *  1. 影子**永不抛出**——任何失败都收敛成一条 outcome 记录；
 *  2. 影子**永不注入**——这个模块没有能力碰会话消息；
 *  3. 超时由观察器自己保证——检索层不理会 signal 也不会把观测挂死；
 *  4. 注入预算是「条数 + 字符」双上限，影子必须和真注入同口径，否则数据会高估体积。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  pickInjection,
  shouldThrottle,
  toQuery,
  resolveShadowPath,
  createShadowWriter,
  createRecallObserver,
} = await import('../src/recall-shadow.ts')

const BASE = {
  enabled: true,
  maxItems: 3,
  maxChars: 600,
  timeoutMs: 50,
  minIntervalMs: 0,
  queryMaxChars: 400,
  path: '',
}

/** 收集写入的记录（不落盘） */
function collector() {
  const records = []
  return {
    records,
    writer: {
      write: (record) => records.push(record),
      failures: () => 0,
    },
  }
}

test('pickInjection：条数与字符双上限，按顺序累加', () => {
  const hits = [
    { memory_id: 'a', content: 'x'.repeat(100), score: 0.9 },
    { memory_id: 'b', content: 'x'.repeat(100), score: 0.8 },
    { memory_id: 'c', content: 'x'.repeat(100), score: 0.7 },
    { memory_id: 'd', content: 'x'.repeat(100), score: 0.6 },
  ]
  assert.equal(pickInjection(hits, 3, 600).length, 3, '条数上限生效')
  assert.equal(pickInjection(hits, 10, 250).length, 2, '字符上限生效（第三条会超 250）')
  assert.equal(pickInjection(hits, 10, 250).reduce((s, i) => s + i.chars, 0), 200)
})

test('pickInjection：单条就超预算时仍保留，否则长记忆永远进不了注入集', () => {
  const picked = pickInjection([{ memory_id: 'long', content: 'x'.repeat(900), score: 0.9 }], 3, 600)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].chars, 900)
})

test('pickInjection：没有 memory_id 的候选直接跳过', () => {
  const picked = pickInjection(
    [{ content: 'no id' }, { memory_id: 'ok', content: 'y', score: 0.5 }],
    3,
    600,
  )
  assert.deepEqual(picked.map((item) => item.memory_id), ['ok'])
})

test('shouldThrottle：0 不节流、首次不节流、窗口内节流、时钟回拨不节流', () => {
  assert.equal(shouldThrottle(1_000, 1_001, 0), false)
  assert.equal(shouldThrottle(0, 1_000, 60_000), false, '还没观察过就不该节流')
  assert.equal(shouldThrottle(1_000, 1_500, 60_000), true)
  assert.equal(shouldThrottle(1_000, 61_000, 60_000), false)
  // 时钟回拨：宁可多观察一次，也不要永久卡死
  assert.equal(shouldThrottle(10_000, 5_000, 60_000), false)
})

test('toQuery：折叠空白并截断', () => {
  assert.equal(toQuery('  你好\n\n世界  ', 100), '你好 世界')
  assert.equal(toQuery('x'.repeat(500), 400).length, 400)
})

test('resolveShadowPath：配置为空时落到插件私有目录', () => {
  assert.ok(resolveShadowPath('').endsWith(join('memory-es', 'recall-shadow.jsonl')))
  assert.equal(resolveShadowPath('/tmp/x.jsonl'), '/tmp/x.jsonl')
})

test('observe：开关关掉时什么都不做', async () => {
  const { records, writer } = collector()
  let called = 0
  const observe = createRecallObserver({
    config: { ...BASE, enabled: false },
    writer,
    search: async () => {
      called += 1
      return { hits: [], note: 'no_match' }
    },
  })
  await observe({ text: '任意问题', agent: 'a' })
  assert.equal(called, 0)
  assert.equal(records.length, 0)
})

test('observe：空消息记 empty，且不打检索', async () => {
  const { records, writer } = collector()
  let called = 0
  const observe = createRecallObserver({
    config: BASE,
    writer,
    search: async () => {
      called += 1
      return { hits: [], note: 'no_match' }
    },
  })
  await observe({ text: '   \n  ', agent: 'a' })
  assert.equal(called, 0)
  assert.equal(records[0].outcome, 'empty')
})

test('observe：有命中时按预算算出「会注入什么」，但不碰任何消息', async () => {
  const { records, writer } = collector()
  const observe = createRecallObserver({
    config: BASE,
    writer,
    search: async () => ({
      hits: [
        { memory_id: 'm1', content: 'x'.repeat(120), score: 0.9 },
        { memory_id: 'm2', content: 'x'.repeat(120), score: 0.7 },
      ],
      note: 'ok',
    }),
  })
  await observe({ text: '这个项目以前怎么定的', agent: 'a' })
  const record = records[0]
  assert.equal(record.outcome, 'ok')
  assert.equal(record.hits, 2)
  assert.deepEqual(record.wouldInject.map((item) => item.memory_id), ['m1', 'm2'])
  assert.equal(record.chars, 240)
  assert.equal(record.agent, 'a')
  // 记录里只有观测字段，没有任何「已注入」的痕迹
  assert.equal('injected' in record, false)
})

test('observe：note=low_confidence 单独归类', async () => {
  const { records, writer } = collector()
  const observe = createRecallObserver({
    config: BASE,
    writer,
    search: async () => ({ hits: [{ memory_id: 'm1', content: 'x', score: 0.2 }], note: 'low_confidence' }),
  })
  await observe({ text: '模糊的问题', agent: 'a' })
  assert.equal(records[0].outcome, 'low_confidence')
})

test('observe：检索抛错被吞成 outcome=error，不向调用方抛', async () => {
  const { records, writer } = collector()
  const observe = createRecallObserver({
    config: BASE,
    writer,
    search: async () => {
      throw new Error('boom')
    },
  })
  await assert.doesNotReject(() => observe({ text: '问题', agent: 'a' }))
  assert.equal(records[0].outcome, 'error')
  assert.match(records[0].note, /boom/)
})

test('observe：检索层无视 signal 时，观察器自己超时返回', async () => {
  const { records, writer } = collector()
  const observe = createRecallObserver({
    config: { ...BASE, timeoutMs: 30 },
    writer,
    // 故意永不 resolve、且完全不看 signal
    search: () => new Promise(() => {}),
  })
  await observe({ text: '慢问题', agent: 'a' })
  assert.equal(records[0].outcome, 'timeout')
})

test('observe：节流窗口内记 throttled 且不重复检索', async () => {
  const { records, writer } = collector()
  let calls = 0
  let clock = 1_000
  const observe = createRecallObserver({
    config: { ...BASE, minIntervalMs: 60_000 },
    writer,
    now: () => clock,
    search: async () => {
      calls += 1
      return { hits: [{ memory_id: 'm1', content: 'x', score: 0.9 }], note: 'ok' }
    },
  })
  await observe({ text: '第一个问题', agent: 'a' })
  clock += 1_000
  await observe({ text: '第二个问题', agent: 'a' })
  assert.equal(calls, 1)
  assert.equal(records[1].outcome, 'throttled')
})

test('writer：真落盘成 JSONL，且目录不存在也能自己建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'))
  const file = join(dir, 'nested', 'recall-shadow.jsonl')
  try {
    const writer = createShadowWriter(file)
    writer.write({
      ts: '2026-11-03T00:00:00.000Z',
      agent: 'a',
      query: 'q',
      outcome: 'ok',
      ms: 1,
      hits: 1,
      wouldInject: [{ memory_id: 'm1', chars: 3, score: 0.9 }],
      chars: 3,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).wouldInject[0].memory_id, 'm1')
    assert.equal(writer.failures(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writer：写失败不抛，只累加 failures（影子不能影响主流程）', () => {
  // 用「拿文件当目录」（ENOTDIR）制造确定性失败。
  // ⚠️ 别用 /proc 下的路径：procfs 上 mkdir 不报错而是**挂死**（2026-11-03 实测，整份测试卡住）。
  const dir = mkdtempSync(join(tmpdir(), 'shadow-fail-'))
  try {
    const notADir = join(dir, 'file')
    writeFileSync(notADir, 'x', 'utf8')
    const writer = createShadowWriter(join(notADir, 'recall-shadow.jsonl'))
    assert.doesNotThrow(() =>
      writer.write({
        ts: '2026-11-03T00:00:00.000Z',
        agent: 'a',
        query: 'q',
        outcome: 'ok',
        ms: 1,
        hits: 0,
        wouldInject: [],
        chars: 0,
      }),
    )
    assert.equal(writer.failures(), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
