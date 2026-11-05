/**
 * 契约静态闸（scripts/lib/contract-lint.ts）的回归。
 *
 * 两条主线：
 *  · 仓库里**真实**的契约与基线必须始终自洽——这是产品级的门；
 *  · 每种腐化都要能被抓到——否则闸门只是摆设。
 *
 * 后者尤其重要：一个「永远返回空问题」的 lint 也能让 CI 变绿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { MIN_MUST_CONTRACTS, lintContracts, type LintReport } from '../scripts/lib/contract-lint.ts'

const REAL_CONTRACTS = readFileSync(new URL('./eval/contracts.jsonl', import.meta.url), 'utf8')
const REAL_BASELINE = readFileSync(new URL('./eval/contracts.baseline.json', import.meta.url), 'utf8')

/** 一条合法的 must 契约（带期望，否则会先撞上「恒真」那条检查）。 */
function line(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, severity: 'must', kind: 'recall', query: 'q', expect_min_hits: 1, ...overrides })
}

/** 造一批满足 must 下限的契约，用来单独验某一条规则。 */
function contractsOf(...lines: string[]): string {
  const filler: string[] = []
  while (lines.length + filler.length < MIN_MUST_CONTRACTS) {
    filler.push(line(`filler-${filler.length + 1}`))
  }
  return [...lines, ...filler].join('\n')
}

function baselineOf(
  passed: string[],
  failed: string[],
  mustFailed: number,
  shouldFailed: number,
  mustIds: string[] | null = ['c1', 'c2', 'c3'],
): string {
  return JSON.stringify({
    createdAt: '2026-11-05T00:00:00.000Z',
    mustFailed,
    shouldFailed,
    ...(mustIds === null ? {} : { mustIds }),
    passedIds: passed,
    failedIds: failed,
  })
}

function codes(report: LintReport): string[] {
  return report.problems.map((problem) => problem.code)
}

/** 一份「全绿」的最小输入：三条 must 契约，基线覆盖全部、无失败。 */
function healthy(): { contracts: string; baseline: string } {
  const ids = ['c1', 'c2', 'c3']
  return {
    contracts: ids.map((id) => line(id)).join('\n'),
    baseline: baselineOf(ids, [], 0, 0),
  }
}

describe('契约静态闸 · 真实仓库文件', () => {
  test('仓库里的 contracts.jsonl 与 baseline 自洽（应为 0 问题）', () => {
    const report = lintContracts({ contracts: REAL_CONTRACTS, baseline: REAL_BASELINE })
    assert.deepEqual(report.problems, [], `真实文件不该有问题，实际：${JSON.stringify(report.problems)}`)
    assert.ok(report.stats.total > 0)
    assert.equal(report.stats.must + report.stats.should, report.stats.total)
    assert.equal(report.stats.baselinePassed + report.stats.baselineFailed, report.stats.total)
  })
})

describe('契约静态闸 · 契约文件腐化', () => {
  test('空文件直接报 contracts-empty', () => {
    const report = lintContracts({ contracts: '\n\n', baseline: null })
    assert.ok(codes(report).includes('contracts-empty'))
  })

  test('坏行报 contracts-parse，并带行号', () => {
    const base = healthy()
    const report = lintContracts({ contracts: `${base.contracts}\n{不是 JSON`, baseline: base.baseline })
    const problem = report.problems.find((item) => item.code === 'contracts-parse')
    assert.ok(problem, '应报解析失败')
    assert.match(problem!.message, /第 4 行/)
  })

  test('id 重复报 contracts-duplicate-id', () => {
    const base = healthy()
    const report = lintContracts({ contracts: `${base.contracts}\n${line('c1')}`, baseline: base.baseline })
    assert.ok(codes(report).includes('contracts-duplicate-id'))
  })

  test('没有期望字段的契约报「恒真」', () => {
    const filler = ['c2', 'c3'].map((id) => line(id)).join('\n')
    const truthy = JSON.stringify({ id: 'c1', severity: 'must', kind: 'recall', query: 'q' })
    const base = healthy()
    const report = lintContracts({ contracts: `${truthy}\n${filler}`, baseline: base.baseline })
    const problem = report.problems.find((item) => item.code === 'contract-no-expectation')
    assert.ok(problem)
    assert.match(problem!.message, /c1/)
  })

  test('require_receipts=true 也算有期望（形状契约的特殊情形）', () => {
    const shape = JSON.stringify({ id: 'c1', severity: 'must', kind: 'shape', query: 'q', require_receipts: true })
    const filler = ['c2', 'c3'].map((id) => line(id)).join('\n')
    const base = healthy()
    const report = lintContracts({ contracts: `${shape}\n${filler}`, baseline: base.baseline })
    assert.ok(!codes(report).includes('contract-no-expectation'))
  })

  test('must 数量低于下限要报（防全降成 should）', () => {
    const shouldOnly = ['c1', 'c2', 'c3'].map((id) => line(id, { severity: 'should' })).join('\n')
    const report = lintContracts({ contracts: shouldOnly, baseline: baselineOf(['c1', 'c2', 'c3'], [], 0, 0, null) })
    const problem = report.problems.find((item) => item.code === 'contracts-too-few-must')
    assert.ok(problem)
    assert.match(problem!.message, new RegExp(`下限 ${MIN_MUST_CONTRACTS}`))
  })

  test('must 被降级成 should 要报（count 检查抓不到的那一类）', () => {
    // 4 条 must，把 c1 降成 should 后仍剩 3 条（不触发下限），
    // mustFailed / failedIds 一个数字都不动 —— 只有 mustIds 快照能发现。
    const ids = ['c1', 'c2', 'c3', 'c4']
    const contracts = ids.map((id) => line(id)).join('\n')
    const baseline = baselineOf(ids, [], 0, 0, ids)
    const downgraded = ids.map((id) => line(id, id === 'c1' ? { severity: 'should' } : {})).join('\n')

    const report = lintContracts({ contracts: downgraded, baseline })
    const problem = report.problems.find((item) => item.code === 'contract-must-downgraded')
    assert.ok(problem, `应报降级，实际：${JSON.stringify(codes(report))}`)
    assert.match(problem!.message, /c1/)
    // 反证：这条改动不会触发计数不一致（所以只靠 count 是抓不到的）
    assert.ok(!codes(report).includes('baseline-count-mismatch'))
  })

  test('should 升成 must 也要报（基线没同步）', () => {
    const ids = ['c1', 'c2', 'c3', 'c4']
    // 基线里 c4 还不是 must；现在升上去了，基线必须重跑
    const baseline = baselineOf(ids, [], 0, 0, ['c1', 'c2', 'c3'])
    const upgraded = ids.map((id) => line(id)).join('\n')

    const report = lintContracts({ contracts: upgraded, baseline })
    const problem = report.problems.find((item) => item.code === 'contract-must-added')
    assert.ok(problem, `应报升级，实际：${JSON.stringify(codes(report))}`)
    assert.match(problem!.message, /c4/)
  })

  test('基线缺 mustIds 快照要报（否则降级无从发现）', () => {
    const base = healthy()
    const report = lintContracts({ contracts: base.contracts, baseline: baselineOf(['c1', 'c2', 'c3'], [], 0, 0, null) })
    assert.ok(codes(report).includes('baseline-no-must-snapshot'))
  })
})

describe('契约静态闸 · 基线腐化', () => {
  test('没有基线报 baseline-missing（闸门无判断依据）', () => {
    const base = healthy()
    const report = lintContracts({ contracts: base.contracts, baseline: null })
    assert.ok(codes(report).includes('baseline-missing'))
  })

  test('基线不是合法 JSON 报 baseline-parse', () => {
    const base = healthy()
    const report = lintContracts({ contracts: base.contracts, baseline: '{坏的' })
    assert.ok(codes(report).includes('baseline-parse'))
  })

  test('基线里有已删除契约的 id 报 baseline-unknown-id', () => {
    const base = healthy()
    const report = lintContracts({
      contracts: base.contracts,
      baseline: baselineOf(['c1', 'c2', 'c3', 'ghost'], [], 0, 0),
    })
    assert.ok(codes(report).includes('baseline-unknown-id'))
  })

  test('新加契约没进基线报 baseline-missing-id', () => {
    const base = healthy()
    const report = lintContracts({
      contracts: `${base.contracts}\n${line('c4')}`,
      baseline: baselineOf(['c1', 'c2', 'c3'], [], 0, 0),
    })
    assert.ok(codes(report).includes('baseline-missing-id'))
  })

  test('同一个 id 既在 passedIds 又在 failedIds 报 baseline-duplicate-id', () => {
    const base = healthy()
    const report = lintContracts({
      contracts: base.contracts,
      baseline: baselineOf(['c1', 'c2', 'c3'], ['c1'], 0, 1),
    })
    assert.ok(codes(report).includes('baseline-duplicate-id'))
  })

  test('mustFailed 与 failedIds 的严重级对不上报 baseline-count-mismatch', () => {
    const base = healthy()
    // c1 是 must，却记成 shouldFailed=1、mustFailed=0 —— 手改基线最典型的一种
    const report = lintContracts({
      contracts: base.contracts,
      baseline: baselineOf(['c2', 'c3'], ['c1'], 0, 1),
    })
    const mismatch = report.problems.filter((item) => item.code === 'baseline-count-mismatch')
    assert.ok(mismatch.length > 0, '应报计数不一致')
  })
})