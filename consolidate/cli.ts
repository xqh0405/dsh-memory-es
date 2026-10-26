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
 *   ES_DIR=/path/to/deploy/es node consolidate/cli.ts   # 指向另一套部署（容器化部署时用）
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
import { exportMirror } from './export.ts'
import { approve, listPending, reject, withdraw } from './review.ts'
import { runConsolidation, type RunReport } from './run.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const AUDIT_INDEX = 'memory_audit'

type Mode = 'consolidate' | 'review-list' | 'approve' | 'reject' | 'withdraw' | 'export' | 'list'

interface CliArgs {
  mode: Mode
  /** 审核动作的目标 doc_id */
  target: string | null
  reviewer: string
  reason: string
  apply: boolean
  /** 显式 dry-run：整理时=不写库，导出时=不写文件 */
  dryRun: boolean
  batchSize: number
  user: string | null
  esDir: string
  esUrl: string | null
  statePath: string
  manual: boolean
  /** 只看这个时间点之后创建的记忆（ISO 或 YYYY-MM-DD） */
  since: Date | null
  /** --export 的输出目录（默认 <repo>/knowledge） */
  exportDir: string
  /** --ls 的范围 */
  scope: 'personal' | 'team' | 'both'
  /** --ls 的 domain 过滤 */
  domain: string[]
  /** --ls 的状态过滤（默认 active；传 all 表示不过滤） */
  status: string
  /** --ls 是否把团队库的 pending 也列出来（默认不列，和检索口径一致） */
  showPending: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: 'consolidate',
    target: null,
    // 默认审计 actor = cli:<userId>（可在 env 里覆盖），与面板的 panel:<userId> 对齐
    reviewer: process.env.CONSOLIDATE_REVIEWER ?? `cli:${process.env.MEM_USER_ID ?? 'unknown'}`,
    reason: '',
    apply: false,
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    user: null,
    esDir: process.env.ES_DIR ?? `${REPO_ROOT}deploy/es`,
    esUrl: process.env.ES_URL ?? null,
    statePath: `${REPO_ROOT}.state/consolidate.json`,
    // 显式跑 CLI 本身就算手动触发；--auto 会改回按阈值判断
    manual: true,
    since: null,
    exportDir: `${REPO_ROOT}knowledge`,
    scope: 'both',
    domain: [],
    status: 'active',
    showPending: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--apply':
        args.apply = true
        break
      case '--dry-run':
        args.apply = false
        args.dryRun = true
        break
      case '--auto':
        args.manual = false
        break
      case '--since': {
        const raw = requireValue(argv, ++i, '--since 需要日期（ISO 或 YYYY-MM-DD）')
        const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw)
        if (Number.isNaN(parsed.getTime())) throw new Error(`--since 不是合法时间：${raw}`)
        args.since = parsed
        break
      }
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
      case '--ls':
      case '--list':
        args.mode = 'list'
        break
      case '--scope': {
        const value = requireValue(argv, ++i, '--scope 需要 personal|team|both')
        if (value !== 'personal' && value !== 'team' && value !== 'both') {
          throw new Error('--scope 只支持 personal|team|both')
        }
        args.scope = value
        break
      }
      case '--domain':
        args.domain.push(requireValue(argv, ++i, '--domain 需要值'))
        break
      case '--status':
        args.status = requireValue(argv, ++i, '--status 需要值（active|all|superseded|expired|rejected…）')
        break
      case '--show-pending':
        args.showPending = true
        break
      case '--export': {
        args.mode = 'export'
        // 目录可选：下一个参数不是 --flag 就当它
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          args.exportDir = next
          i += 1
        }
        break
      }
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
  --since <日期>       只看该时间之后创建的记忆（ISO 或 YYYY-MM-DD）

查看记忆（只读）:
  --ls                 列出记忆条目（个人库 + 团队库），最多 --limit 条
  --scope <p|t|both>   只看 personal / team / 两者（默认 both）
  --domain <名字>      按 domain 过滤，可重复
  --status <状态>      默认 active；all=不过滤；也可传 superseded/expired/rejected
  --show-pending       团队库把 review_state=pending 的也列出来（默认不列，与检索口径一致）

审核台（S9）:
  --review list        列出待裁决条目（review_state=pending）
  --approve <doc_id>   通过：review_state=approved，进入检索
  --reject <doc_id>    驳回：status=rejected，不参与检索（必须配 --reason）
  --withdraw <doc_id>  撤回：status=superseded（不物理删，§10；必须配 --reason）
  --reason <文本>      驳回/撤回的原因（写进条目与审计流水）
  --reviewer <名字>    谁在操作（默认环境变量 CONSOLIDATE_REVIEWER，再退到 cli）

Markdown 镜像（S10，只读导出）:
  --export [目录]      按 domain 导出 knowledge/<domain>.md + INDEX.md（默认 <repo>/knowledge）
                       与 --dry-run 组合时只报告会写哪些文件
  -h, --help           本帮助

环境变量:
  ES_DIR               部署目录（含 .env 与 certs/），默认 ./deploy/es
  ES_URL               覆盖 ES 地址（等价 --es-url）
  MEM_PERSONAL_PREFIX  个人索引前缀（默认 personal_memory_）
  MEM_TEAM_INDEX       团队库索引名（默认 team_knowledge）
  MEM_AUDIT_INDEX      审计索引名（默认 memory_audit）
  MEM_EMBEDDING_URL    向量服务地址（默认 http://127.0.0.1:11434；容器里要写宿主地址）
  MEM_EMBEDDING_MODEL  向量模型（默认 bge-m3）
  MEM_EMBEDDING_DIMS   向量维度（默认 1024，必须与索引 dims 一致）`)
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
  // 允许用进程环境覆盖文件值：cron / 面板调用时可以把单账号凭据直接传进来，
  // 不必为了换凭据去改写 .env（也避免把密码落在仓库目录里）
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('MEM_') && typeof value === 'string' && value !== '') env[key] = value
  }
  const userId = args.user ?? env.MEM_USER_ID ?? ''
  if (userId === '') throw new Error('缺少用户：用 --user 指定，或在 .env 里配 MEM_USER_ID')

  // 两种身份模式：
  //  · 单账号（推荐，一人一个 ES 账号）：MEM_USERNAME/MEM_PASSWORD，个人库读写 + 团队库按角色授权
  //  · 旧的三账号：MEM_READER_PASSWORD / MEM_WRITER_PASSWORD / MEM_CONSOLIDATOR_PASSWORD
  const single = (env.MEM_USERNAME ?? '') !== '' && (env.MEM_PASSWORD ?? '') !== ''
  if (!single) {
    const need = ['MEM_READER_PASSWORD', 'MEM_WRITER_PASSWORD', 'MEM_CONSOLIDATOR_PASSWORD'] as const
    const missing = need.filter((key) => (env[key] ?? '') === '')
    if (missing.length > 0) {
      throw new Error(
        `.env 缺少 ${missing.join(' / ')}；或改用单账号模式（scripts/init-user.sh 生成的 users/<uid>.env 里有 MEM_USERNAME/MEM_PASSWORD）`,
      )
    }
  }

  const url = args.esUrl ?? 'https://127.0.0.1:9200'
  const caCertPath = `${args.esDir}/certs/ca.crt`
  const client = (username: string, password: string) =>
    createEsClient({ url, caCertPath, username, password, requestTimeoutMs: 10_000 })

  const reader = single
    ? client(env.MEM_USERNAME, env.MEM_PASSWORD)
    : client(`mem-reader-${userId}`, env.MEM_READER_PASSWORD)
  const writer = single ? reader : client('mem-writer', env.MEM_WRITER_PASSWORD)
  const consolidator = single ? reader : client('mem-consolidator', env.MEM_CONSOLIDATOR_PASSWORD)
  // 索引名/向量端点都从 .env 读：同一份代码要能在本机（127.0.0.1）和容器里（要访问宿主 Ollama）跑，
  // 硬编码会让「换部署」变成「改代码」。
  const personalPrefix = env.MEM_PERSONAL_PREFIX ?? 'personal_memory_'
  const personalIndex = `${personalPrefix}${userId}`
  const teamIndex = env.MEM_TEAM_INDEX ?? 'team_knowledge'
  const audit = { client: consolidator, index: env.MEM_AUDIT_INDEX ?? AUDIT_INDEX }
  const embeddingUrl = env.MEM_EMBEDDING_URL ?? 'http://127.0.0.1:11434'
  const embeddingModel = env.MEM_EMBEDDING_MODEL ?? 'bge-m3'
  const dims = Number(env.MEM_EMBEDDING_DIMS ?? '1024')
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`MEM_EMBEDDING_DIMS 非法：${String(env.MEM_EMBEDDING_DIMS)}（必须是正整数）`)
  }
  const embed = createEmbedder({ url: embeddingUrl, model: embeddingModel, dims })
  const log = (event: Record<string, unknown>): void => {
    if (process.env.CONSOLIDATE_VERBOSE === '1') console.error(`[debug] ${JSON.stringify(event)}`)
  }

  // 查看记忆（只读）：个人库 + 团队库
  if (args.mode === 'list') {
    await runList(args, { personalIndex, teamIndex, reader, limit: args.batchSize })
    return
  }

  // Markdown 镜像：只读导出，不写 ES
  if (args.mode === 'export') {
    const result = await exportMirror(
      { client: consolidator, teamIndex, endpoint: url },
      { outDir: args.exportDir, dryRun: args.dryRun, now: new Date() },
    )
    console.log(
      `${args.dryRun ? 'DRY-RUN（不写文件）' : '已导出'} → ${result.outDir} | 共 ${result.total} 条 / ${result.files.length} 个 domain`,
    )
    for (const file of result.files) console.log(`  - ${file.domain} → ${file.file} (${file.count} 条)`)
    if (result.files.length === 0) console.log('  （团队库里没有可导出的条目：只导出 active 且 auto/approved 的）')
    if (result.pruned.length > 0) console.log(`  清理旧文件：${result.pruned.join(', ')}`)
    if (!args.dryRun) console.log(`索引：${args.exportDir}/INDEX.md`)
    return
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
  console.log(
    `向量：${embeddingModel}@${embeddingUrl} (${dims} 维) | 个人索引 ${personalIndex} | 团队库 ${teamIndex} | 审计 ${audit.index}`,
  )
  if (args.since !== null) console.log(`时间窗：只看 ${args.since.toISOString()} 之后创建的记忆`)
  const report = await runConsolidation(
    {
      userId,
      personalIndex,
      teamIndex,
      reader,
      writer,
      consolidator,
      embed,
      dims,
      audit,
      log,
    },
    {
      apply: args.apply,
      batchSize: args.batchSize,
      state,
      manual: args.manual,
      ...(args.since === null ? {} : { createdAfter: args.since }),
    },
  )

  printReport(report, args.apply)

  if (args.apply) {
    saveState(args.statePath, report.state)
    console.log(`状态已保存：${args.statePath}`)
  } else {
    console.log('（dry-run：状态未写盘、团队库与个人库均未改动）')
  }
}

/** `--ls`：只读列条目。排序用 updated_at desc（最近动过的在最上面）。 */
async function runList(
  args: CliArgs,
  deps: {
    personalIndex: string
    teamIndex: string
    reader: ReturnType<typeof createEsClient>
    limit: number
  },
): Promise<void> {
  const buildQuery = (includeReviewState: boolean): Record<string, unknown> => {
    const filter: Array<Record<string, unknown>> = []
    if (args.status !== 'all') filter.push({ term: { status: args.status } })
    if (args.domain.length > 0) filter.push({ terms: { domain: args.domain } })
    if (includeReviewState && !args.showPending) {
      // 与 memory_search 同口径：pending 默认不列（它是"还没定论"的东西）
      filter.push({ terms: { review_state: ['auto', 'approved'] } })
    }
    return { bool: { filter } }
  }

  const rows: string[] = []
  const counts: Record<string, number> = {}
  const scan = async (index: string, label: string, includeReviewState: boolean): Promise<void> => {
    const result = await deps.reader.search(index, {
      size: deps.limit,
      _source: { excludes: ['embedding'] },
      query: buildQuery(includeReviewState),
      sort: [{ updated_at: 'desc' }],
    })
    counts[label] = result.total
    for (const hit of result.hits) {
      const src = hit.source
      const str = (k: string): string => (typeof src[k] === 'string' ? (src[k] as string) : '')
      const state = includeReviewState ? `${str('status')}/${str('review_state') || '-'}` : str('status')
      const content = str('content').replace(/\s+/g, ' ').slice(0, 56)
      rows.push(
        [
          hit.id.slice(0, 8).padEnd(8),
          label.padEnd(8),
          (str('domain') || '-').padEnd(16).slice(0, 16),
          (str('memory_type') || '-').padEnd(11).slice(0, 11),
          state.padEnd(16).slice(0, 16),
          (str('updated_at') || '-').slice(0, 19),
          content,
        ].join('  '),
      )
    }
  }

  if (args.scope !== 'team') await scan(deps.personalIndex, 'personal', false)
  if (args.scope !== 'personal') await scan(deps.teamIndex, 'team', true)

  console.log(`范围：${args.scope} | 状态：${args.status}${args.domain.length > 0 ? ` | domain: ${args.domain.join(',')}` : ''}${args.showPending ? ' | 含 pending' : ''}`)
  console.log(
    `${'id'.padEnd(8)}  ${'库'.padEnd(8)}  ${'domain'.padEnd(16)}  ${'type'.padEnd(11)}  ${'状态'.padEnd(16)}  ${'更新时间'.padEnd(19)}  content`,
  )
  if (rows.length === 0) {
    console.log('（没有符合条件的记忆）')
  } else {
    for (const row of rows) console.log(row)
  }
  const summary = Object.entries(counts)
    .map(([label, total]) => `${label}=${total}`)
    .join(' ')
  console.log('')
  console.log(`共 ${summary}（最多显示 ${deps.limit} 条，用 --limit 调整）`)
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
