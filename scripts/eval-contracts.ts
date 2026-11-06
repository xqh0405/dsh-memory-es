#!/usr/bin/env node
/**
 * 契约式回归评测 runner（阶段 13）。
 *
 * 与 `eval-search.ts` 的分工：
 *  · eval-search —— 「排序质量」：hit@k / MRR / 噪声误报，回答「排得准不准」；
 *  · 本脚本     —— 「行为契约」：该出现的出现了吗、不该出现的混进来了吗、结构对不对。
 *
 * 判定逻辑全在 `scripts/lib/contracts.ts`（纯函数、可单测），这里只负责取数与汇总。
 *
 * 闸门（`--gate`，将来进 CI 用）：
 *  · 任何 `must` 失败 → 非零退出；
 *  · `should` 失败数 **多于基线** → 非零退出（允许持平，不允许变差）。
 *
 * 用法：
 *   node scripts/eval-contracts.ts                    # 跑一遍，与基线对比（不拦）
 *   node scripts/eval-contracts.ts --gate             # 拦：must 全过且 should 不回退
 *   node scripts/eval-contracts.ts --update-baseline  # 覆盖基线（确认改进后才用）
 *   node scripts/eval-contracts.ts --contracts tests/eval/contracts.jsonl
 *
 * 不传 recorder：跑评测不会写 search_log，不污染观测数据。
 *
 * @module scripts/eval-contracts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_RANKING } from '../src/fragment.ts'
import { searchMemories, type SearchDeps } from '../src/memory/search.ts'
import {
  evaluateContract,
  parseContractLine,
  summarizeContracts,
  type ContractCase,
  type ContractOutcome,
} from './lib/contracts.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')

interface ContractBaseline {
  createdAt: string
  /** 基线时的失败数：should 只允许持平或减少 */
  mustFailed: number
  shouldFailed: number
  /** must 契约的全集快照；`check-contracts.ts` 靠它发现「must 被降级成 should」 */
  mustIds?: string[]
  passedIds: string[]
  failedIds: string[]
}

function parseArgs(argv: string[]) {
  const opts = {
    contracts: join(ROOT, 'tests/eval/contracts.jsonl'),
    baseline: join(ROOT, 'tests/eval/contracts.baseline.json'),
    config: DEFAULT_CONFIG_PATH,
    gate: false,
    updateBaseline: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--gate') opts.gate = true
    else if (a === '--update-baseline') opts.updateBaseline = true
    else if (a === '--contracts') opts.contracts = resolve(argv[++i])
    else if (a === '--baseline') opts.baseline = resolve(argv[++i])
    else if (a === '--config') opts.config = resolve(argv[++i])
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

function loadContracts(path: string): ContractCase[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, i) => parseContractLine(line, i + 1))
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const cases = loadContracts(opts.contracts)
  console.log(`配置：${opts.config}`)
  console.log(`ES  ：${cfg.esUrl}  索引：${cfg.personalPrefix}${cfg.userId}`)
  console.log(`契约：${cases.length} 条（must=${cases.filter((c) => c.severity === 'must').length}）\n`)

  const reader = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: cfg.requestTimeoutMs,
    username: cfg.username,
    password: cfg.password,
  })
  const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
  const deps: SearchDeps = {
    userId: cfg.userId,
    personalPrefix: cfg.personalPrefix,
    teamIndex: cfg.teamIndex,
    reader,
    embed,
    dims: cfg.dims,
    // 与运行时默认一致；改这里等于改评测口径
    retrieval: { topK: 20, rrfK: 60, limit: 8 },
    ranking: { ...DEFAULT_RANKING },
  }

  const outcomes = new Map<string, ContractOutcome>()
  let degraded = 0
  for (const item of cases) {
    try {
      const result = await searchMemories(deps, {
        query: item.query,
        scope: item.scope ?? 'both',
        limit: item.limit ?? 5,
        ...(item.require_receipts === true ? { explain: true } : {}),
      })
      if (result.degraded) degraded += 1
      outcomes.set(item.id, evaluateContract(item, result))
    } catch (err) {
      outcomes.set(item.id, { pass: false, reasons: [`执行失败：${String(err).slice(0, 160)}`] })
    }
  }

  const summary = summarizeContracts(cases, outcomes)
  console.log('== 本轮结果 ==')
  console.log(`通过 ${summary.passed}/${summary.total}  must 失败 ${summary.mustFailed}  should 失败 ${summary.shouldFailed}`)
  if (degraded > 0) console.log(`⚠️ ${degraded} 条走了降级（向量不可用，只走 BM25）`)
  if (summary.failures.length > 0) {
    const byId = new Map(cases.map((c) => [c.id, c]))
    for (const failure of summary.failures) {
      const item = byId.get(failure.id)
      console.log(`  ✗ [${failure.severity}] ${failure.id}  ${item?.query ?? ''}`)
      for (const reason of failure.reasons) console.log(`      - ${reason}`)
    }
  }

  const baseline: ContractBaseline | null = existsSync(opts.baseline)
    ? (JSON.parse(readFileSync(opts.baseline, 'utf8')) as ContractBaseline)
    : null
  if (baseline !== null) {
    console.log(`\n== 与基线对比（${baseline.createdAt.slice(0, 19)}）==`)
    console.log(`  must 失败 ${baseline.mustFailed} → ${summary.mustFailed}`)
    console.log(`  should 失败 ${baseline.shouldFailed} → ${summary.shouldFailed}`)
  } else {
    console.log('\n（还没有基线；确认当前状态可接受后加 --update-baseline）')
  }

  if (opts.updateBaseline) {
    const payload: ContractBaseline = {
      createdAt: new Date().toISOString(),
      mustFailed: summary.mustFailed,
      shouldFailed: summary.shouldFailed,
      // 快照 must 全集：只有计数的话，「把 must 改成 should」一个数字都不动（实测漏过）
      mustIds: cases.filter((c) => c.severity === 'must').map((c) => c.id),
      passedIds: cases.filter((c) => outcomes.get(c.id)?.pass === true).map((c) => c.id),
      failedIds: summary.failures.map((f) => f.id),
    }
    writeFileSync(opts.baseline, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`\n已写入基线：${opts.baseline}`)
    return
  }

  if (opts.gate) {
    const problems: string[] = []
    if (summary.mustFailed > 0) problems.push(`must 契约失败 ${summary.mustFailed} 条`)
    if (baseline !== null) {
      // 只比数量会被「修好一条、又坏一条」骗过去：所以再比**失败集合**，新增即拦。
      if (summary.shouldFailed > baseline.shouldFailed) {
        problems.push(`should 失败从 ${baseline.shouldFailed} 涨到 ${summary.shouldFailed}`)
      }
      const before = new Set(baseline.failedIds)
      const added = summary.failures.filter((f) => f.severity === 'should' && !before.has(f.id)).map((f) => f.id)
      if (added.length > 0) problems.push(`新增 should 失败：${added.join(', ')}`)
    }
    if (baseline === null) problems.push('没有基线，无法判断是否回退（先跑 --update-baseline）')
    if (problems.length > 0) {
      console.error(`\n闸门未过：${problems.join('；')}`)
      process.exitCode = 1
    } else {
      console.log('\n闸门通过：must 全过，should 未回退')
    }
  }
}

await main()
