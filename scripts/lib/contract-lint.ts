/**
 * 契约闸门的**离线静态校验**（阶段 17 P0-4）。
 *
 * 为什么需要这一层：`eval-contracts.ts --gate` 是真正的质量闸，但它必须连
 * 真实 ES + Ollama（契约按 memory_id 命中，数据是真实工作记忆、不在仓库里）。
 * 所以它在 GitHub CI 上**跑不了**——那台 runner 没有索引、也不该有。
 *
 * 于是在 CI 上闸的是另一类退化，它们不需要 ES 就能抓：
 *  · 契约文件被改坏（语法错、id 重复、一行写坏整个评测挂死）；
 *  · 「恒真契约」——一个期望字段都不写，跑起来永远绿；
 *  · 悄悄降级——把 must 改成 should，闸门就形同虚设；
 *  · 基线漂移——删了契约但基线还留着它、新加契约没进基线、
 *    失败计数与失败名单对不上（`mustFailed: 0` 但 failedIds 里躺着 must）。
 *
 * 这些正是「靠自觉」最容易失守的地方。真正的召回质量仍由
 * `npm run eval:contracts:gate` 在能连 ES 的环境（内网 / Jenkins）跑。
 *
 * @module scripts/lib/contract-lint
 */

import {
  CONTRACT_KINDS,
  CONTRACT_SEVERITIES,
  parseContractLine,
  type ContractCase,
} from './contracts.ts'

/** must 契约的下限。低于它等于闸门失效（全改成 should 就永远绿）。 */
export const MIN_MUST_CONTRACTS = 3

/** 一个问题项：`code` 是稳定标识，测试与日志按它断言，不按中文文案断言。 */
export interface LintProblem {
  code: string
  message: string
}

export interface LintStats {
  total: number
  must: number
  should: number
  baselinePassed: number
  baselineFailed: number
}

export interface LintReport {
  problems: LintProblem[]
  stats: LintStats
}

export interface LintInput {
  /** contracts.jsonl 全文 */
  contracts: string
  /** contracts.baseline.json 全文；null / undefined 表示文件不存在 */
  baseline?: string | null
}

interface BaselineShape {
  passedIds?: unknown
  failedIds?: unknown
  /** must 契约的全集快照；缺了它就无法发现「must 被悄悄降级成 should」。 */
  mustIds?: unknown
  mustFailed?: unknown
  shouldFailed?: unknown
}

/** 一条契约至少要有一个「会因结果不同而变」的期望，否则它恒真。 */
const EXPECTATION_FIELDS = [
  'expect_ids',
  'expect_contains',
  'expect_not_contains',
  'expect_note',
  'expect_min_hits',
  'expect_max_hits',
  'expect_excluded_types',
  'expect_not_ids',
] as const

function hasExpectation(item: ContractCase): boolean {
  if (item.require_receipts === true) return true
  return EXPECTATION_FIELDS.some((field) => item[field] !== undefined)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * 纯函数：吃两份文件文本，吐问题清单。不做任何 IO，方便单测。
 */
export function lintContracts(input: LintInput): LintReport {
  const problems: LintProblem[] = []
  const stats: LintStats = { total: 0, must: 0, should: 0, baselinePassed: 0, baselineFailed: 0 }

  // ---- 1. 契约文件本身 ----
  const lines = input.contracts.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) {
    problems.push({ code: 'contracts-empty', message: '契约文件里一条都没有——闸门没有可跑的东西' })
    return { problems, stats }
  }

  const cases: ContractCase[] = []
  const seen = new Map<string, number>()
  lines.forEach((line, index) => {
    const lineNo = index + 1
    let item: ContractCase
    try {
      item = parseContractLine(line, lineNo)
    } catch (err) {
      problems.push({
        code: 'contracts-parse',
        message: `第 ${lineNo} 行解析失败：${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    const firstLine = seen.get(item.id)
    if (firstLine !== undefined) {
      problems.push({
        code: 'contracts-duplicate-id',
        message: `id «${item.id}» 重复出现（第 ${firstLine} 行与第 ${lineNo} 行）`,
      })
    } else {
      seen.set(item.id, lineNo)
    }
    if (!hasExpectation(item)) {
      problems.push({
        code: 'contract-no-expectation',
        message: `«${item.id}» 一个期望字段都没写，这条契约永远会过（恒真）`,
      })
    }
    cases.push(item)
  })

  stats.total = cases.length
  stats.must = cases.filter((item) => item.severity === 'must').length
  stats.should = cases.filter((item) => item.severity === 'should').length

  if (stats.must < MIN_MUST_CONTRACTS) {
    problems.push({
      code: 'contracts-too-few-must',
      message: `must 契约只有 ${stats.must} 条，低于下限 ${MIN_MUST_CONTRACTS}——全降成 should 就永远绿`,
    })
  }

  // 防御性：parseContractLine 已校验，这里再确认常量与文件口径一致，
  // 免得哪天有人放宽了校验函数而这边没跟上。
  for (const item of cases) {
    if (!(CONTRACT_SEVERITIES as readonly string[]).includes(item.severity)) {
      problems.push({ code: 'contracts-bad-severity', message: `«${item.id}» severity=«${item.severity}» 不在允许集合里` })
    }
    if (!(CONTRACT_KINDS as readonly string[]).includes(item.kind)) {
      problems.push({ code: 'contracts-bad-kind', message: `«${item.id}» kind=«${item.kind}» 不在允许集合里` })
    }
  }

  // ---- 2. 基线 ----
  const baselineRaw = input.baseline
  if (baselineRaw === undefined || baselineRaw === null || baselineRaw.trim() === '') {
    problems.push({
      code: 'baseline-missing',
      message: '没有 contracts.baseline.json——没有基线就无法判断 should 是否回退（先跑 --update-baseline 并提交）',
    })
    return { problems, stats }
  }

  let baseline: BaselineShape
  try {
    baseline = JSON.parse(baselineRaw) as BaselineShape
  } catch (err) {
    problems.push({
      code: 'baseline-parse',
      message: `基线不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    })
    return { problems, stats }
  }

  const passedIds = baseline.passedIds
  const failedIds = baseline.failedIds
  if (!isStringArray(passedIds) || !isStringArray(failedIds)) {
    problems.push({ code: 'baseline-shape', message: '基线缺少 passedIds / failedIds 字符串数组' })
    return { problems, stats }
  }
  if (typeof baseline.mustFailed !== 'number' || typeof baseline.shouldFailed !== 'number') {
    problems.push({ code: 'baseline-shape', message: '基线缺少 mustFailed / shouldFailed 数字字段' })
    return { problems, stats }
  }

  stats.baselinePassed = passedIds.length
  stats.baselineFailed = failedIds.length

  const known = new Set(cases.map((item) => item.id))
  const byId = new Map(cases.map((item) => [item.id, item]))

  const recorded = new Set<string>()
  const duplicated = new Set<string>()
  for (const id of passedIds) {
    if (!known.has(id)) problems.push({ code: 'baseline-unknown-id', message: `基线里有契约中不存在的 id «${id}»（契约被删了但基线没更新）` })
    if (recorded.has(id)) duplicated.add(id)
    recorded.add(id)
  }
  for (const id of failedIds) {
    if (!known.has(id)) problems.push({ code: 'baseline-unknown-id', message: `基线里有契约中不存在的 id «${id}»（契约被删了但基线没更新）` })
    if (recorded.has(id)) duplicated.add(id)
    recorded.add(id)
  }
  for (const id of duplicated) {
    problems.push({ code: 'baseline-duplicate-id', message: `«${id}» 同时出现在 passedIds 与 failedIds（或重复记录）` })
  }

  for (const item of cases) {
    if (!recorded.has(item.id)) {
      problems.push({ code: 'baseline-missing-id', message: `«${item.id}» 没有基线记录（新加的契约要先跑一次评测再提交基线）` })
    }
  }

  // must 全集必须与基线快照一致。
  // 没有这层，「把 must 改成 should」不会动 mustFailed/failedIds 任何一个数字，
  // 却能悄悄把闸门削弱一半——实测这个场景 count 检查抓不到（2026-11-05）。
  const mustIdsRaw = baseline.mustIds
  if (mustIdsRaw === undefined) {
    problems.push({
      code: 'baseline-no-must-snapshot',
      message: '基线没有 mustIds 快照——补一次 --update-baseline（否则「must 降级成 should」不会被发现）',
    })
  } else if (!isStringArray(mustIdsRaw)) {
    problems.push({ code: 'baseline-shape', message: '基线 mustIds 必须是字符串数组' })
  } else {
    const baselineMust = new Set(mustIdsRaw)
    const currentMust = new Set(cases.filter((item) => item.severity === 'must').map((item) => item.id))
    for (const id of currentMust) {
      if (!baselineMust.has(id)) {
        problems.push({
          code: 'contract-must-added',
          message: `«${id}» 现在是 must，但基线里不是（改了严重级要重跑基线）`,
        })
      }
    }
    for (const id of baselineMust) {
      if (currentMust.has(id)) continue
      problems.push({
        code: 'contract-must-downgraded',
        message: known.has(id)
          ? `«${id}» 基线里是 must，现在被降成 should——闸门被悄悄削弱`
          : `«${id}» 基线里是 must，但契约已被删除`,
      })
    }
  }

  // 计数与名单必须自洽：手改基线最容易在这里露馅。
  const failedMust = failedIds.filter((id) => byId.get(id)?.severity === 'must').length
  const failedShould = failedIds.filter((id) => byId.get(id)?.severity === 'should').length
  if (failedMust !== baseline.mustFailed) {
    problems.push({
      code: 'baseline-count-mismatch',
      message: `mustFailed=${baseline.mustFailed}，但 failedIds 里有 ${failedMust} 条 must`,
    })
  }
  if (failedShould !== baseline.shouldFailed) {
    problems.push({
      code: 'baseline-count-mismatch',
      message: `shouldFailed=${baseline.shouldFailed}，但 failedIds 里有 ${failedShould} 条 should`,
    })
  }

  return { problems, stats }
}