/**
 * 契约评测的纯函数单测（阶段 13）。
 *
 * 为什么值得单测：契约是「闸门」，闸门自己错了比没有闸更糟——
 * 一条写错的 expect_not_contains 可能让所有查询都"通过"，也可能让正确的实现一直红。
 * 所以这里把解析、逐项判定、汇总三件事都钉住。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  evaluateContract,
  parseContractLine,
  summarizeContracts,
  type ContractCase,
} from '../scripts/lib/contracts.ts'

const HITS = [
  { memory_id: 'a', content: '北单同步要逐位对拍赔率列', memory_type: 'fact' },
  { memory_id: 'b', content: '备用库一律从 GG 取数', memory_type: 'fact' },
]

function makeCase(overrides: Partial<ContractCase> = {}): ContractCase {
  return {
    id: 'c1',
    severity: 'must',
    kind: 'recall',
    query: '北单 同步',
    ...overrides,
  }
}

describe('parseContractLine', () => {
  test('合法行解析出全部字段', () => {
    const item = parseContractLine(
      JSON.stringify({
        id: 'c1',
        severity: 'must',
        kind: 'exclude',
        query: 'q',
        limit: 3,
        expect_excluded_types: ['identity'],
        require_receipts: true,
      }),
      1,
    )
    assert.equal(item.id, 'c1')
    assert.equal(item.severity, 'must')
    assert.deepEqual(item.expect_excluded_types, ['identity'])
    assert.equal(item.require_receipts, true)
  })

  test('缺 id / 未知 severity / 未知 kind / 缺 query 都直接报错', () => {
    assert.throws(() => parseContractLine('{"severity":"must","kind":"recall","query":"q"}', 1), /缺 id/)
    assert.throws(() => parseContractLine('{"id":"c","severity":"x","kind":"recall","query":"q"}', 2), /severity/)
    assert.throws(() => parseContractLine('{"id":"c","severity":"must","kind":"x","query":"q"}', 3), /kind/)
    assert.throws(() => parseContractLine('{"id":"c","severity":"must","kind":"recall"}', 4), /缺 query/)
  })

  test('数组字段必须是字符串数组', () => {
    assert.throws(
      () => parseContractLine('{"id":"c","severity":"must","kind":"recall","query":"q","expect_ids":[1]}', 1),
      /expect_ids/,
    )
  })
})

describe('evaluateContract', () => {
  test('expect_ids：全部命中才算过，缺谁报谁', () => {
    assert.equal(evaluateContract(makeCase({ expect_ids: ['a'] }), { hits: HITS, note: 'ok' }).pass, true)
    const miss = evaluateContract(makeCase({ expect_ids: ['a', 'z'] }), { hits: HITS, note: 'ok' })
    assert.equal(miss.pass, false)
    assert.match(miss.reasons.join(' '), /z/)
  })

  test('expect_contains / expect_not_contains 走正文拼接', () => {
    assert.equal(
      evaluateContract(makeCase({ expect_contains: ['赔率', 'GG'] }), { hits: HITS, note: 'ok' }).pass,
      true,
    )
    const bad = evaluateContract(makeCase({ expect_not_contains: ['GG'] }), { hits: HITS, note: 'ok' })
    assert.equal(bad.pass, false)
    assert.match(bad.reasons.join(' '), /不该出现/)
  })

  test('expect_max_hits：噪声契约要求一条都不返回', () => {
    const noise = makeCase({ kind: 'noise', expect_max_hits: 0 })
    assert.equal(evaluateContract(noise, { hits: [], note: 'no_match' }).pass, true)
    assert.equal(evaluateContract(noise, { hits: HITS, note: 'ok' }).pass, false)
  })

  test('expect_note 与执行失败要能区分', () => {
    assert.equal(evaluateContract(makeCase({ expect_note: 'no_match' }), { hits: [], note: 'no_match' }).pass, true)
    assert.equal(evaluateContract(makeCase({ expect_note: 'no_match' }), { hits: HITS, note: 'ok' }).pass, false)
  })

  test('expect_excluded_types：identity/persona 混进事实要红', () => {
    const mixed = [...HITS, { memory_id: 'i1', content: '用户偏好简洁', memory_type: 'identity' }]
    const outcome = evaluateContract(makeCase({ expect_excluded_types: ['identity'] }), { hits: mixed, note: 'ok' })
    assert.equal(outcome.pass, false)
    assert.match(outcome.reasons.join(' '), /identity/)
  })

  test('expect_not_ids：心情文档 __mood__ 不该被检索出来', () => {
    const withMood = [...HITS, { memory_id: '__mood__', content: '情绪状态' }]
    const outcome = evaluateContract(makeCase({ expect_not_ids: ['__mood__'] }), { hits: withMood, note: 'ok' })
    assert.equal(outcome.pass, false)
  })

  test('require_receipts：缺失或长度不符都算失败', () => {
    assert.equal(
      evaluateContract(makeCase({ require_receipts: true }), { hits: HITS, note: 'ok', receipts: [{}, {}] }).pass,
      true,
    )
    assert.equal(
      evaluateContract(makeCase({ require_receipts: true }), { hits: HITS, note: 'ok' }).pass,
      false,
    )
    assert.equal(
      evaluateContract(makeCase({ require_receipts: true }), { hits: HITS, note: 'ok', receipts: [{}] }).pass,
      false,
    )
  })

  test('多条失败会一次全列出（不早退，方便一次改完）', () => {
    const outcome = evaluateContract(
      makeCase({ expect_note: 'no_match', expect_max_hits: 0, expect_not_contains: ['赔率'] }),
      { hits: HITS, note: 'ok' },
    )
    assert.equal(outcome.pass, false)
    assert.ok(outcome.reasons.length >= 3, `期望 ≥3 条原因，实际 ${outcome.reasons.join(' | ')}`)
  })
})

describe('summarizeContracts', () => {
  test('must 与 should 分开计数；没有结果的按失败算', () => {
    const cases = [
      makeCase({ id: 'm1', severity: 'must' }),
      makeCase({ id: 'm2', severity: 'must' }),
      makeCase({ id: 's1', severity: 'should' }),
    ]
    const outcomes = new Map([
      ['m1', { pass: true, reasons: [] }],
      ['m2', { pass: false, reasons: ['boom'] }],
      // s1 没有结果：应当算失败，而不是被忽略
    ])
    const summary = summarizeContracts(cases, outcomes)
    assert.equal(summary.total, 3)
    assert.equal(summary.passed, 1)
    assert.equal(summary.mustFailed, 1)
    assert.equal(summary.shouldFailed, 1)
    assert.deepEqual(summary.failures.map((f) => f.id).sort(), ['m2', 's1'])
  })
})
