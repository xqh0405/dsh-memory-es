#!/usr/bin/env node
/**
 * 整理任务 + 审核台 CLI（文档 §9 / §10 / §16 S8-S9）。
 * **整理默认 dry-run，什么都不写**；要真写必须显式 `--apply`。
 *
 * 用法：
 *   node consolidate/cli.ts                        # dry-run：只出候选报告
 *   node consolidate/cli.ts --apply                # 真写团队库 + 回写个人库状态
 *   node consolidate/cli.ts --review list          # 看待裁决队列（pending，不进检索）
 *   node consolidate/cli.ts --approve <doc_id>     # 通过 → 进入检索
 *   node consolidate/cli.ts --reject <doc_id> --reason "结论与线上不符"
 *   node consolidate/cli.ts --withdraw <doc_id> --reason "这条知识已作废"
 *   ES_DIR=/path/to/deploy/es node consolidate/cli.ts   # 指向另一套部署（如 .125）
 *
 * 状态文件默认 `<repo>/.state/consolidate.json`（游标 + 已处理 + pending 队列）。
 *
 * @module dsh-memory-es/consolidate/cli
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { daysSinceLastRun, loadState, saveState } from './state.ts'
import { DEFAULT_BATCH_SIZE, shouldRun } from './scan.ts'
import { approve, listPending, reject, withdraw } from './review.ts'
import { runConsolidation, type RunReport } from './run.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const AUDIT_INDEX = 'memory_audit'

type Mode = 'consolidate' | 'review-list' | 'approve' | 'reject' | 'withdraw'

interface CliArgs {
  mode: Mode
  /** 审核动作的目标 doc_id */
  target: string | null
  reviewer: string
  reason: string
  apply: boolean
  batchSize: number
  user: string | null
  esDir: string
  esUrl: string | null
  statePath: string
  manual: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: 'consolidate',
    target: null,
    reviewer: process.env.CONSOLIDATE_REVIEWER ?? 'cli',
    reason: '',
    apply: false,
    batchSize: DEFAULT_BATCH_SIZE,
    user: null,
    esDir: process.env.ES_DIR ?? `${REPO_ROOT}deploy/es`,
    esUrl: process.env.ES_URL ?? null,
    statePath: `${REPO_ROOT}.state/consolidate.json`,
    // 显式跑 CLI 本身就算手动触发；--auto 会改回按阈值判断
    manual: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--apply':
        args.apply = true
        break
      case '--dry-run':
        args.apply = false
        break
      case '--auto':
        args.manual = false
        break
      case '--limit':
        args.batchSize = Number(argv[++i])
        if (!Number.isInteger(args.batchSize) || args.batchSize < 1) throw new Error('--limit 必须是正整数')
        break
      case '--user':
        args.user = argv[++i] ?? null
        break
      case '--es-url':
        args.esUrl = argv[++i] ?? null
        break
      case '--state':
        args.statePath = argv[++i] ?? args.statePath
        break
      case '--reviewer':
        args.reviewer = argv[++i] ?? args.reviewer
        break
      case '--reason':
        args.reason = argv[++i] ?? ''
        break
      case '--review': {
        const what = argv[++i] ?? 'list'
        if (what !== 'list') throw new Error('--review 只支持 list（其它动作用 --approve/--reject/--withdraw）')
        args.mode = 'review-list'
        break
      }
      case '--approve':
        args.mode = 'approve'
        args.target = requireValue(argv, ++i, '--approve 需要 doc_id')
        break
      case '--reject':
        args.mode = 'reject'
        args.target = requireValue(argv, ++i, '--reject 需要 doc_id')
        break
      case '--withdraw':
        args.mode = 'withdraw'
        args.target = requireValue(argv, ++i, '--withdraw 需要 doc_id')
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`未知参数：${arg}（--help 看用法）`)
    }
  }
  return args
}

function requireValue(argv: string[], index: number, message: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(message)
  return value
}

function printHelp(): void {
  console.log(`整理任务（个人记忆 → 团队库），默认 dry-run

用法: node consolidate/cli.ts [选项]

选项:
  --apply              真的写入团队库并回写个人库状态（默认只报告）
  --dry-run            显式 dry-run（默认行为）
  --limit <N>          本批最多处理多少条（默认 ${DEFAULT_BATCH_SIZE}）
  --user <id>          目标用户（默认取 .env 的 MEM_USER_ID）
  --es-url <url>       覆盖 ES 地址（默认 .env 所在部署的 127.0.0.1:9200）
  --state <path>       状态文件（游标/幂等），默认 .state/consolidate.json
  --auto               按 §9.1 阈值判断是否该跑（默认手动模式，直接跑）

审核台（S9）:
  --review list        列出待裁决条目（review_state=pending）
  --approve <doc_id>   通过：review_state=approved，进入检索
  --reject <doc_id>    驳回：status=rejected，不参与检索（必须配 --reason）
  --withdraw <doc_id>  撤回：status=superseded（不物理删，§10；必须配 --reason）
  --reason <文本>      驳回/撤回的原因（写进条目与审计流水）
  --reviewer <名字>    谁在操作（默认环境变量 CONSOLIDATE_REVIEWER，再退到 cli）
  -h, --help           本帮助

环境变量:
  ES_DIR               部署目录（含 .env 与 certs/），默认 ./deploy/es
  ES_URL               覆盖 ES 地址（等价 --es-url）`)
}

/** 极简 .env 解析（与测试里的实现同语义：跳过注释、值里的 = 原样保留） */
function parseDotEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = parseDotEnvFile(`${args.esDir}/.env`)
  const userId = args.user ?? env.MEM_USER_ID ?? ''
  if (userId === '') throw new Error('缺少用户：用 --user 指定，或在 .env 里配 MEM_USER_ID')

  const need = ['MEM_READER_PASSWORD', 'MEM_WRITER_PASSWORD', 'MEM_CONSOLIDATOR_PASSWORD'] as const
  const missing = need.filter((key) => (env[key] ?? '') === '')
  if (missing.length > 0) {
    throw new Error(`.env 缺少 ${missing.join(' / ')}（先跑 scripts/init-security.sh）`)
  }

  const url = args.esUrl ?? 'https://127.0.0.1:9200'
  const caCertPath = `${args.esDir}/certs/ca.crt`
  const client = (username: string, password: string) =>
    createEsClient({ url, caCertPath, username, password, requestTimeoutMs: 10_000 })

  const reader = client(`mem-reader-${userId}`, env.MEM_READER_PASSWORD)
  const writer = client('mem-writer', env.MEM_WRITER_PASSWORD)
  const consolidator = client('mem-consolidator', env.MEM_CONSOLIDATOR_PASSWORD)
  const embed = createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024 })

  const personalIndex = `personal_memory_${userId}`
  const teamIndex = 'team_knowledge'
  const audit = { client: consolidator, index: AUDIT_INDEX }
  const log = (event: Record<string, unknown>): void => {
    if (process.env.CONSOLIDATE_VERBOSE === '1') console.error(`[debug] ${JSON.stringify(event)}`)
  }

  // 审核台：单条显式动作，没有 dry-run 概念（动作本身就是人的决定）
  if (args.mode !== 'consolidate') {
    await runReview(args, { teamIndex, consolidator, audit, log })
    return
  }

  const state = loadState(args.statePath)

  // 触发判断（§9.1）。手动模式直接跑；--auto 按阈值
  if (!args.manual) {
    const pending = await reader.search(personalIndex, {
      size: 0,
      _source: { excludes: ['embedding'] },
      query: { bool: { filter: [{ term: { status: 'active' } }, { term: { promote_state: 'none' } }] } },
    })
    const decision = shouldRun({
      pendingCount: pending.total,
      daysSinceLastRun: daysSinceLastRun(state),
      hasNewSinceLast: pending.total > 0,
      manual: false,
    })
    console.log(`触发判断：${decision.run ? '跑' : '跳过'} — ${decision.reason}`)
    if (!decision.run) return
  }

  console.log(`模式：${args.apply ? 'APPLY（会写库）' : 'DRY-RUN（只报告）'} | 用户 ${userId} | 批次上限 ${args.batchSize}`)
  const report = await runConsolidation(
    {
      userId,
      personalIndex,
      teamIndex,
      reader,
      writer,
      consolidator,
      embed,
      dims: 1024,
      audit,
      log,
    },
    { apply: args.apply, batchSize: args.batchSize, state, manual: args.manual },
  )

  printReport(report, args.apply)

  if (args.apply) {
    saveState(args.statePath, report.state)
    console.log(`状态已保存：${args.statePath}`)
  } else {
    console.log('（dry-run：状态未写盘、团队库与个人库均未改动）')
  }
}

async function runReview(
  args: CliArgs,
  deps: {
    teamIndex: string
    consolidator: ReturnType<typeof createEsClient>
    audit: { client: ReturnType<typeof createEsClient>; index: string }
    log: (event: Record<string, unknown>) => void
  },
): Promise<void> {
  const base = { teamIndex: deps.teamIndex, client: deps.consolidator, audit: deps.audit }

  if (args.mode === 'review-list') {
    const pending = await listPending(base, { limit: args.batchSize })
    if (pending.length === 0) {
      console.log('待裁决队列为空。')
      return
    }
    console.log(`待裁决 ${pending.length} 条（已落库，但 review_state=pending **不进检索结果**）：`)
    for (const doc of pending) {
      console.log(`  - ${doc.doc_id}  [${doc.domain}] ${doc.content.slice(0, 60)}${doc.content.length > 60 ? '…' : ''}`)
      if (doc.conflict_with) console.log(`      冲突对象：${doc.conflict_with}`)
      console.log(`      来源：${doc.source_user ?? '—'} / ${doc.source_memory_id ?? '—'} @ ${doc.promoted_at ?? '—'}`)
    }
    console.log('')
    console.log('处理：--approve <doc_id> / --reject <doc_id> --reason "..." / --withdraw <doc_id>')
    return
  }

  const docId = args.target ?? ''
  if (args.mode === 'reject' && args.reason.trim() === '') {
    throw new Error('--reject 需要 --reason（驳回原因要可追溯）')
  }
  if (args.mode === 'withdraw' && args.reason.trim() === '') {
    throw new Error('--withdraw 需要 --reason（撤回归因要可追溯）')
  }

  if (args.mode === 'approve') {
    const result = await approve(base, docId, args.reviewer)
    console.log(result.changed ? `已通过 ${docId}（现在会出现在检索结果里）` : `${docId} 状态未变（可能已经是 approved）`)
    return
  }
  if (args.mode === 'reject') {
    const result = await reject(base, docId, args.reviewer, args.reason)
    console.log(result.changed ? `已驳回 ${docId}（status=rejected，不参与检索）` : `${docId} 状态未变`)
    return
  }
  const result = await withdraw(base, docId, args.reviewer, args.reason)
  console.log(result.changed ? `已撤回 ${docId}（status=superseded，未物理删除）` : `${docId} 状态未变`)
}

function printReport(report: RunReport, applied: boolean): void {
  console.log('')
  console.log(`候选 ${report.candidates} 条（跳过已处理 ${report.skippedProcessed}）${report.degraded ? ' | 有降级：向量不可用，部分条目只做了 sha 去重' : ''}`)
  for (const item of report.results) {
    const score = item.topScore === null || item.topScore === undefined ? '' : ` top=${item.topScore.toFixed(3)}`
    const neighbor = item.neighborId ? ` ~${item.neighborId.slice(0, 8)}` : ''
    const team = item.teamDocId ? ` → team:${item.teamDocId.slice(0, 8)}` : ''
    console.log(`  - ${item.memory_id.slice(0, 8)} [${item.verdict}] ${item.reason}${score}${neighbor}${team}`)
  }
  const c = report.counts
  console.log('')
  console.log(
    `小结：${applied ? '已写入' : '预计'} promoted=${c.promoted} duplicate=${c.duplicate} merge_candidate=${c.mergeCandidate} pending=${c.pending} blocked=${c.blocked}`,
  )
  if (c.blocked > 0) console.log('注意：blocked 的条目只置状态、不写团队库，且日志不含原文。')
  if (c.pending > 0) {
    console.log('注意：pending 已落库但 review_state=pending，**不进检索结果**；用 --review list 处理。')
  }
}

main().catch((err: unknown) => {
  console.error(`整理任务失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
