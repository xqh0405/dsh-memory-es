/**
 * 契约闸门 · 离线层（阶段 17 P0-4）。
 *
 * 这是能在**没有 ES、没有 Ollama、没有网络**的环境（GitHub Actions）跑的那一半：
 * 只检查契约文件与基线本身有没有腐化，不跑任何检索。
 *
 * 完整的质量闸仍是 `npm run eval:contracts:gate`（`scripts/eval-contracts.ts`），
 * 它按 memory_id 命中真实记忆，必须在能连 ES 的环境（内网 / Jenkins）跑。
 * 两者分工写在 `docs/开发文档.md` 的「评测与闸门」一节。
 *
 * 用法：
 *   node scripts/check-contracts.ts
 *   node scripts/check-contracts.ts --contracts tests/eval/contracts.jsonl --baseline tests/eval/contracts.baseline.json
 *   node scripts/check-contracts.ts --verbose      # 额外打印统计
 *
 * 退出码：0 = 通过；1 = 有问题（CI 直接红）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lintContracts } from './lib/contract-lint.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')

function parseArgs(argv: string[]) {
  const opts = {
    contracts: join(ROOT, 'tests/eval/contracts.jsonl'),
    baseline: join(ROOT, 'tests/eval/contracts.baseline.json'),
    verbose: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--verbose') opts.verbose = true
    else if (arg === '--contracts') opts.contracts = resolve(argv[++i])
    else if (arg === '--baseline') opts.baseline = resolve(argv[++i])
    else throw new Error(`未知参数：${arg}`)
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv)

  if (!existsSync(opts.contracts)) {
    console.error(`✗ 契约文件不存在：${opts.contracts}`)
    process.exitCode = 1
    return
  }

  const contracts = readFileSync(opts.contracts, 'utf8')
  const baseline = existsSync(opts.baseline) ? readFileSync(opts.baseline, 'utf8') : null
  const report = lintContracts({ contracts, baseline })
  const { stats } = report

  if (opts.verbose) {
    console.log(`契约：${stats.total} 条（must ${stats.must} / should ${stats.should}）`)
    console.log(`基线：通过 ${stats.baselinePassed} 条，失败 ${stats.baselineFailed} 条`)
    console.log('')
  }

  if (report.problems.length > 0) {
    console.error(`✗ 契约静态闸未过（${report.problems.length} 项）：`)
    for (const problem of report.problems) {
      console.error(`  [${problem.code}] ${problem.message}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`✓ 契约静态闸通过：${stats.total} 条（must ${stats.must} / should ${stats.should}），基线覆盖 ${stats.baselinePassed + stats.baselineFailed} 条`)
  console.log('  召回质量请在有 ES 的环境跑：npm run eval:contracts:gate')
}

main()