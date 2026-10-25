#!/usr/bin/env node
/**
 * 整理任务 CLI（文档 §9 / §16 S8）。**默认 dry-run，什么都不写**；要真写必须显式 `--apply`。
 *
 * 用法：
 *   node consolidate/cli.ts                      # dry-run：只出候选报告
 *   node consolidate/cli.ts --apply              # 真写团队库 + 回写个人库状态
 *   node consolidate/cli.ts --limit 50 --user xqh
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
import { runConsolidation } from './run.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

interface CliArgs {
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

  const personalPrefix = 'personal_memory_'
  const personalIndex = `${personalPrefix}${userId}`
  const teamIndex = 'team_knowledge'

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
      log: (event) => {
        if (process.env.CONSOLIDATE_VERBOSE === '1') console.error(`[debug] ${JSON.stringify(event)}`)
      },
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

function printReport(report: Awaited<ReturnType<typeof runConsolidation>>, applied: boolean): void {
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
  if (c.pending > 0) console.log('注意：pending 条目只进本地人工队列（S8 不写团队库，避免半成品进检索）。')
}

main().catch((err: unknown) => {
  console.error(`整理任务失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
