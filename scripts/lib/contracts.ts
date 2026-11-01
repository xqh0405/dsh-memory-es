/**
 * 契约式回归评测（阶段 13）——纯函数部分。
 *
 * 为什么要它：现有的 `queries.jsonl` 只测「排序质量」（hit@k / MRR），
 * 回答不了另一类问题：**结果里出现了本来不该出现的东西**吗？
 * （identity/persona 挤进事实、心情文档被当记忆、噪声 query 也返回一堆结果、
 *  explain 打开却拿不到回执）。这些「不该发生」的约束一旦被改动破坏，
 * hit@k 可能一点看不出来，用户却立刻能感觉到。
 *
 * 所以契约分两个严重级：
 *  · `must`   —— 不许失败。破了就是 bug，CI 直接红；
 *  · `should` —— 允许失败，但不许比基线更差（比如噪声 query 目前 6/6 都误报，
 *               那是已知缺口，记录在案，等收敛而不是自欺欺人）。
 *
 * 格式（每行一条 JSON，与 queries.jsonl 并列）：
 *   { "id": "...", "severity": "must|should", "kind": "recall|noise|exclude|shape",
 *     "query": "...", "scope": "personal|team|both", "limit": 5,
 *     "expect_ids": [...], "expect_contains": [...], "expect_not_contains": [...],
 *     "expect_note": "ok|no_match|low_confidence", "expect_min_hits": 1, "expect_max_hits": 0,
 *     "expect_excluded_types": [...], "expect_not_ids": [...], "require_receipts": true }
 *
 * 判定是**纯函数**：runner 只负责取数与汇总，这样契约语义可以单测。
 *
 * @module scripts/lib/contracts
 */

export const CONTRACT_KINDS = ['recall', 'noise', 'exclude', 'shape'] as const
export type ContractKind = (typeof CONTRACT_KINDS)[number]

export const CONTRACT_SEVERITIES = ['must', 'should'] as const
export type ContractSeverity = (typeof CONTRACT_SEVERITIES)[number]

export interface ContractCase {
  id: string
  severity: ContractSeverity
  kind: ContractKind
  query: string
  scope?: 'both' | 'personal' | 'team'
  limit?: number
  /** top-k 里必须出现这些 memory_id（精确；id 稳定，迁移不变） */
  expect_ids?: string[]
  /** top-k 的正文拼接里必须包含这些子串（内容级契约） */
  expect_contains?: string[]
  /** 正文拼接里不得包含任何这些子串 */
  expect_not_contains?: string[]
  /** 期望的判别结论 */
  expect_note?: 'ok' | 'no_match' | 'low_confidence'
  expect_min_hits?: number
  expect_max_hits?: number
  /** 这些 memory_type 不得出现在结果里（identity/persona/journal 默认不进检索） */
  expect_excluded_types?: string[]
  /** 这些 memory_id 不得出现（如心情文档 `__mood__`） */
  expect_not_ids?: string[]
  /** explain=true 时必须带回执，且与 hits 同长 */
  require_receipts?: boolean
}

export interface ContractHitLike {
  memory_id: string
  content: string
  memory_type?: string
  source?: string
}

export interface ContractResultLike {
  hits: ReadonlyArray<ContractHitLike>
  note: string
  receipts?: ReadonlyArray<unknown>
}

export interface ContractOutcome {
  pass: boolean
  /** 失败原因（人话，汇总时直接打印） */
  reasons: string[]
}

/** 解析一行契约；格式问题一律抛错（评测集写错比跑错更该早暴露） */
export function parseContractLine(line: string, lineNo: number): ContractCase {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (err) {
    throw new Error(`第 ${lineNo} 行不是合法 JSON：${(err as Error).message}`)
  }
  if (raw === null || typeof raw !== 'object') throw new Error(`第 ${lineNo} 行不是对象`)
  const value = raw as Record<string, unknown>
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '')

  const id = text('id')
  if (id === '') throw new Error(`第 ${lineNo} 行缺 id`)
  const severity = text('severity')
  if (!CONTRACT_SEVERITIES.includes(severity as ContractSeverity)) {
    throw new Error(`第 ${lineNo} 行（${id}）severity 必须是 ${CONTRACT_SEVERITIES.join(' / ')}`)
  }
  const kind = text('kind')
  if (!CONTRACT_KINDS.includes(kind as ContractKind)) {
    throw new Error(`第 ${lineNo} 行（${id}）kind 必须是 ${CONTRACT_KINDS.join(' / ')}`)
  }
  const query = text('query')
  if (query === '') throw new Error(`第 ${lineNo} 行（${id}）缺 query`)

  const strings = (key: string): string[] | undefined => {
    const list = value[key]
    if (list === undefined) return undefined
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      throw new Error(`第 ${lineNo} 行（${id}）${key} 必须是字符串数组`)
    }
    return list as string[]
  }
  const numbers = (key: string): number | undefined => {
    const item = value[key]
    if (item === undefined) return undefined
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error(`第 ${lineNo} 行（${id}）${key} 必须是数字`)
    }
    return item
  }

  return {
    id,
    severity: severity as ContractSeverity,
    kind: kind as ContractKind,
    query,
    scope: (text('scope') || undefined) as ContractCase['scope'],
    limit: numbers('limit'),
    expect_ids: strings('expect_ids'),
    expect_contains: strings('expect_contains'),
    expect_not_contains: strings('expect_not_contains'),
    expect_note: (text('expect_note') || undefined) as ContractCase['expect_note'],
    expect_min_hits: numbers('expect_min_hits'),
    expect_max_hits: numbers('expect_max_hits'),
    expect_excluded_types: strings('expect_excluded_types'),
    expect_not_ids: strings('expect_not_ids'),
    require_receipts: value.require_receipts === true,
  }
}

/**
 * 判一条契约。**只看 result，不碰网络**——runner 负责取数，这样语义可单测。
 * 返回的 reasons 为空 = 通过；多条失败会全部列出（不早退，方便一次改完）。
 */
export function evaluateContract(c: ContractCase, result: ContractResultLike): ContractOutcome {
  const reasons: string[] = []
  const hits = result.hits
  const haystack = hits.map((hit) => hit.content).join('\n')

  if (c.expect_note !== undefined && result.note !== c.expect_note) {
    reasons.push(`note 期望 ${c.expect_note}，实际 ${result.note}`)
  }
  if (c.expect_min_hits !== undefined && hits.length < c.expect_min_hits) {
    reasons.push(`命中数期望 ≥${c.expect_min_hits}，实际 ${hits.length}`)
  }
  if (c.expect_max_hits !== undefined && hits.length > c.expect_max_hits) {
    reasons.push(`命中数期望 ≤${c.expect_max_hits}，实际 ${hits.length}`)
  }

  if (c.expect_ids !== undefined && c.expect_ids.length > 0) {
    const got = new Set(hits.map((hit) => hit.memory_id))
    const missing = c.expect_ids.filter((id) => !got.has(id))
    if (missing.length > 0) reasons.push(`缺少期望条目 ${missing.join(', ')}`)
  }

  for (const needle of c.expect_contains ?? []) {
    if (!haystack.includes(needle)) reasons.push(`正文里没有「${needle}」`)
  }
  for (const needle of c.expect_not_contains ?? []) {
    if (haystack.includes(needle)) reasons.push(`正文里不该出现「${needle}」`)
  }

  if (c.expect_excluded_types !== undefined && c.expect_excluded_types.length > 0) {
    const banned = new Set(c.expect_excluded_types)
    const offenders = hits.filter((hit) => hit.memory_type !== undefined && banned.has(hit.memory_type))
    if (offenders.length > 0) {
      reasons.push(`出现了不该有的类型：${[...new Set(offenders.map((hit) => hit.memory_type))].join(', ')}`)
    }
  }

  if (c.expect_not_ids !== undefined && c.expect_not_ids.length > 0) {
    const banned = new Set(c.expect_not_ids)
    const offenders = hits.filter((hit) => banned.has(hit.memory_id))
    if (offenders.length > 0) reasons.push(`出现了不该有的 id：${offenders.map((hit) => hit.memory_id).join(', ')}`)
  }

  if (c.require_receipts === true) {
    if (result.receipts === undefined) reasons.push('explain=true 但没有回执')
    else if (result.receipts.length !== hits.length) {
      reasons.push(`回执条数 ${result.receipts.length} 与命中 ${hits.length} 不一致`)
    }
  }

  return { pass: reasons.length === 0, reasons }
}

export interface ContractSummary {
  total: number
  passed: number
  /** must 级失败数：非 0 就该拦 */
  mustFailed: number
  /** should 级失败数：与基线比较，不许变多 */
  shouldFailed: number
  failures: Array<{ id: string; severity: ContractSeverity; reasons: string[] }>
}

/** 汇总：must 失败单独计数（闸门只看它 + 基线的 should 不回退） */
export function summarizeContracts(
  cases: readonly ContractCase[],
  outcomes: ReadonlyMap<string, ContractOutcome>,
): ContractSummary {
  let passed = 0
  let mustFailed = 0
  let shouldFailed = 0
  const failures: ContractSummary['failures'] = []
  for (const item of cases) {
    const outcome = outcomes.get(item.id) ?? { pass: false, reasons: ['没有执行结果'] }
    if (outcome.pass) {
      passed += 1
      continue
    }
    if (item.severity === 'must') mustFailed += 1
    else shouldFailed += 1
    failures.push({ id: item.id, severity: item.severity, reasons: outcome.reasons })
  }
  return { total: cases.length, passed, mustFailed, shouldFailed, failures }
}
