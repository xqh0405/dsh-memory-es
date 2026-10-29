#!/usr/bin/env node
/**
 * 检索评测：跑 `tests/eval/queries.jsonl`，输出 recall@k / MRR / 空结果率，并与基线对比。
 *
 * 为什么单独一个脚本：
 *  - 单测用假 ES，验证的是「编排语义」；这里打真 ES，验证的是「排序质量」；
 *  - 任何权重/召回路调整，都要能回答「比上一版好了还是坏了」，否则只能凭感觉。
 *
 * 用法：
 *   node scripts/eval-search.ts                    # 跑评测，与基线对比，不覆盖基线
 *   node scripts/eval-search.ts --update-baseline   # 覆盖基线（只在确认提升时用）
 *   node scripts/eval-search.ts --limit 5 --queries tests/eval/queries.jsonl
 *
 * 参数说明：
 *  - 配置默认从 dsh profile 的 cordis.patch.yml 里读 `dsh-memory-es` 段，避免凭据出现在命令行；
 *  - 不传 recorder，因此不会写 search_log，跑评测不会污染观测数据。
 *
 * @module scripts/eval-search
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { searchMemories, type SearchDeps } from '../src/memory/search.ts'
import { DEFAULT_RANKING } from '../src/fragment.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

interface QueryRow {
  id: string
  kind: string
  query: string
  expect: string[]
}

interface RowResult {
  id: string
  kind: string
  /** 期望条目在返回列表里的名次（1 起）；未命中为 null */
  rank: number | null
  note: string
  degraded: boolean
  /** 实际返回的前 k 个 memory_id（排查用） */
  ids: string[]
}

interface Baseline {
  createdAt: string
  limit: number
  /** 基线是否带置信判空：两种口径下的名次不可直接比较 */
  gate: boolean
  rows: RowResult[]
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_CFG = DEFAULT_CONFIG_PATH

/** 极简参数解析：只认这几个开关，不引第三方库 */
function parseArgs(argv: string[]) {
  const opts = {
    queries: join(ROOT, 'tests/eval/queries.jsonl'),
    baseline: join(ROOT, 'tests/eval/baseline.json'),
    config: DEFAULT_CFG,
    limit: 5,
    // 默认关闭置信判空：它决定「返回几条」，不是排序质量。
    // 加了 --no-gate 就跑「纯排序」口径；不加则与生产一致。
    noGate: true,
    agreementBonus: undefined as number | undefined,
    updateBaseline: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--update-baseline') opts.updateBaseline = true
    else if (a === '--queries') opts.queries = resolve(argv[++i])
    else if (a === '--baseline') opts.baseline = resolve(argv[++i])
    else if (a === '--config') opts.config = resolve(argv[++i])
    else if (a === '--limit') opts.limit = Number(argv[++i])
    else if (a === '--agreement-bonus') opts.agreementBonus = Number(argv[++i])
    else if (a === '--no-gate') opts.noGate = true
    else if (a === '--gate') opts.noGate = false
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

function loadQueries(path: string): QueryRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as QueryRow
      } catch (err) {
        throw new Error(`第 ${i + 1} 行不是合法 JSON：${(err as Error).message}`)
      }
    })
}

/** 指标汇总：只对 expect 非空的条目算命中率；noise 单独算误报 */
function summarize(rows: RowResult[], all: QueryRow[]) {
  const kindOf = new Map(all.map((q) => [q.id, q.kind]))
  const groups = new Map<string, { n: number; hit1: number; hit5: number; mrr: number; lowConf: number; fp: number }>()
  for (const r of rows) {
    const kind = kindOf.get(r.id) ?? 'unknown'
    const g = groups.get(kind) ?? { n: 0, hit1: 0, hit5: 0, mrr: 0, lowConf: 0, fp: 0 }
    g.n += 1
    if (r.note === 'low_confidence') g.lowConf += 1
    if (r.kind === 'noise') {
      // noise 的期望是「查不到」：返回了结果且判定 ok 才算误报
      if (r.ids.length > 0 && r.note === 'ok') g.fp += 1
    } else if (r.rank !== null) {
      if (r.rank === 1) g.hit1 += 1
      if (r.rank <= 5) g.hit5 += 1
      g.mrr += 1 / r.rank
    }
    groups.set(kind, g)
  }
  return groups
}

function fmtGroup(name: string, g: { n: number; hit1: number; hit5: number; mrr: number; lowConf: number; fp: number }) {
  if (name === 'noise') {
    return `${name.padEnd(11)} n=${String(g.n).padEnd(3)} 误报=${g.fp}  low_conf=${g.lowConf}`
  }
  const pct = (v: number) => `${((v / Math.max(g.n, 1)) * 100).toFixed(0)}%`
  return `${name.padEnd(11)} n=${String(g.n).padEnd(3)} hit@1=${pct(g.hit1).padEnd(5)} hit@5=${pct(g.hit5).padEnd(5)} MRR=${(g.mrr / Math.max(g.n, 1)).toFixed(3)}  low_conf=${g.lowConf}`
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const queries = loadQueries(opts.queries)
  console.log(`配置：${opts.config}`)
  console.log(`ES  ：${cfg.esUrl}  索引：${cfg.personalPrefix}${cfg.userId}`)
  console.log(`查询：${queries.length} 条（limit=${opts.limit}，gate=${opts.noGate ? 'off' : 'on'}）`)
  if (opts.noGate) console.log('口径：关闭置信判空，只测排序质量\n')
  else console.log('口径：含置信判空（与生产一致）\n')

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
    // 与运行时的默认检索参数保持一致；改这里等于改评测口径，需同步 config.ts
    retrieval: { topK: 20, rrfK: 60, limit: 8 },
    // 关闭判空 = autoPassTop1 取 0（任何 top1 都直接放行）
    ...(opts.noGate ? { confidence: { floorTop1: 0, autoPassTop1: 0, minMargin: 0, minBm25: 0 } } : {}),
    ranking: { ...DEFAULT_RANKING, agreementBonus: opts.agreementBonus ?? DEFAULT_RANKING.agreementBonus },
  }

  const rows: RowResult[] = []
  let degradedCount = 0
  for (const q of queries) {
    const res = await searchMemories(deps, { query: q.query, scope: 'both', limit: opts.limit })
    if (res.degraded) degradedCount += 1
    const ids = res.hits.map((h) => h.memory_id)
    const idx = q.expect.length === 0 ? -1 : ids.findIndex((id) => q.expect.includes(id))
    rows.push({ id: q.id, kind: q.kind, rank: idx === -1 ? null : idx + 1, note: res.note, degraded: res.degraded, ids })
  }

  const groups = summarize(rows, queries)
  console.log('== 本轮结果 ==')
  for (const [kind, g] of groups) console.log(fmtGroup(kind, g))
  if (degradedCount > 0) console.log(`⚠️ ${degradedCount} 条走了降级（向量不可用，只走 BM25），本轮数字不可作基线`)

  // 与基线逐条对比：只在名次变化时打印，避免刷屏
  if (existsSync(opts.baseline)) {
    const base = JSON.parse(readFileSync(opts.baseline, 'utf8')) as Baseline
    const baseGate = base.gate ?? false // 旧基线字段是 marginFloor，等价于「不判空」
    if (baseGate !== !opts.noGate) {
      console.log(`\n⚠️ 基线 gate=${baseGate} 与本轮 ${!opts.noGate} 不同，名次不可比`)
    }
    const before = new Map(base.rows.map((r) => [r.id, r]))
    const queryText = new Map(queries.map((q) => [q.id, q.query]))
    const diffs: string[] = []
    for (const r of rows) {
      const b = before.get(r.id)
      if (b === undefined) continue
      if (b.rank !== r.rank) {
        const arrow = b.rank === null ? '✗→✓' : r.rank === null ? '✓→✗' : `${b.rank}→${r.rank}`
        diffs.push(`  ${r.id} ${r.kind.padEnd(10)} ${arrow}  ${queryText.get(r.id) ?? ''}`)
      }
    }
    console.log(`\n== 与基线对比（${base.createdAt.slice(0, 19)}）==`)
    console.log(diffs.length === 0 ? '  逐条名次完全一致' : diffs.join('\n'))
  } else {
    console.log('\n（没有基线文件，本次结果即为首版基线）')
  }

  if (opts.updateBaseline) {
    const payload: Baseline = { createdAt: new Date().toISOString(), limit: opts.limit, gate: !opts.noGate, rows }
    writeFileSync(opts.baseline, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`\n已写入基线：${opts.baseline}`)
  } else if (existsSync(opts.baseline)) {
    console.log('\n（未覆盖基线；确认提升后加 --update-baseline）')
  }
}

main().catch((err) => {
  console.error('评测失败：', (err as Error).message)
  process.exit(1)
})
