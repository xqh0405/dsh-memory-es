#!/usr/bin/env node
/**
 * 阶段 36b：中文 gold-set 基线评测。
 *
 * 回答一个问题：**现在中文召回到底多好**——并给出「BM25 单路」与「BM25+kNN+RRF」
 * 的同口径对照。本轮只出数、不设门槛（施工图 36.3）。
 *
 * gold-set 口径（`tests/eval/cjk-goldset.jsonl`）：
 *  · `gold_ids` 非空 → 该条 query 的正确答案；`gold_ids` 为空 → **弃答档**（不该命中任何东西）；
 *  · `tags` 四档：专名 / 缩写 / 时间 / 弃答（一条可多标）。
 *
 * 为什么分模式跑：只看混合结果无法判断「向量到底有没有贡献」。BM25-only 的模式是
 * `embed: null`（检索内部按降级处理，只走关键词），与生产降级路径完全同一条代码。
 *
 * 逐字率（灵枢口径的映射）：命中条目的返回正文必须是 `content_exact` 的子串。
 * 截断（尾部 `…`）先去掉再比；`detail=summary` 不计入（summary 是蒸馏产物，不是原文）。
 *
 * 用法：
 *   node scripts/eval-cjk-goldset.ts --config /path/cordis.patch.yml
 *   node scripts/eval-cjk-goldset.ts --gold tests/eval/cjk-goldset.jsonl --json out.json
 *
 * @module scripts/eval-cjk-goldset
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_RANKING } from '../src/fragment.ts'
import { searchMemories, type SearchDeps } from '../src/memory/search.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')

interface GoldRow {
  id: string
  query: string
  gold_ids: string[]
  tags: string[]
  source?: string
}

const TAGS = ['专名', '缩写', '时间', '弃答'] as const
type Tag = (typeof TAGS)[number]

function parseArgs(argv: string[]) {
  const opts = {
    gold: join(ROOT, 'tests/eval/cjk-goldset.jsonl'),
    config: DEFAULT_CONFIG_PATH,
    limit: 5,
    json: '',
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--gold') opts.gold = resolve(argv[++i])
    else if (a === '--config') opts.config = resolve(argv[++i])
    else if (a === '--limit') opts.limit = Number(argv[++i])
    else if (a === '--json') opts.json = resolve(argv[++i])
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

function loadGold(path: string): GoldRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as GoldRow)
}

interface ModeResult {
  mode: string
  total: number
  r5: number
  mrr: number
  falsePositive: number
  answerable: number
  verbatim: number
  verbatimTotal: number
  /** 保地基：gold 条目的关键句是否逐字出现在返回正文里 */
  baseSent: number
  /** 证据链：命中条目能否按 memory_id 回源到 content_exact（可回源 = 能核对原文） */
  resolvable: number
  byTag: Record<string, { total: number; r5: number }>
}

/** 关键句的机器近似：正文第一句（中文标点切）。人工标注更准，但 200 条的成本不划算。 */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const hit = /^[^。！？.!?\n]{6,}[。！？.!?]/.exec(trimmed)
  return hit === null ? trimmed.slice(0, 30) : hit[0]
}

function bestRank(hits: ReadonlyArray<{ memory_id: string }>, goldIds: readonly string[]): number {
  let best = 0
  for (let i = 0; i < hits.length; i += 1) {
    if (goldIds.includes(hits[i]!.memory_id)) {
      best = i + 1
      break
    }
  }
  return best
}

async function runMode(
  deps: SearchDeps,
  rows: readonly GoldRow[],
  limit: number,
  mode: string,
  contentExact: Map<string, string>,
): Promise<ModeResult> {
  const result: ModeResult = {
    mode,
    total: rows.length,
    r5: 0,
    mrr: 0,
    falsePositive: 0,
    answerable: 0,
    verbatim: 0,
    verbatimTotal: 0,
    baseSent: 0,
    resolvable: 0,
    byTag: Object.fromEntries(TAGS.map((t) => [t, { total: 0, r5: 0 }])),
  }

  for (const row of rows) {
    const res = await searchMemories(deps, { query: row.query, scope: 'both', limit })
    const unanswerable = row.gold_ids.length === 0
    if (unanswerable) {
      // 弃答档：返回任何命中都算「误命中」
      if (res.hits.length > 0) result.falsePositive += 1
      continue
    }
    result.answerable += 1
    const rank = bestRank(res.hits, row.gold_ids)
    const hit = rank > 0 && rank <= limit
    if (hit) result.r5 += 1
    if (rank > 0) result.mrr += 1 / rank

    for (const tag of row.tags) {
      const bucket = result.byTag[tag]
      if (bucket === undefined) continue
      bucket.total += 1
      if (hit) bucket.r5 += 1
    }

    // 逐字率：命中的 gold 条目，其返回正文必须逐字来自 content_exact
    if (hit) {
      result.verbatimTotal += 1
      const returned = res.hits.find((h) => row.gold_ids.includes(h.memory_id))
      const exact = returned === undefined ? undefined : contentExact.get(returned.memory_id)
      if (returned !== undefined && exact !== undefined) {
        const body = returned.content.endsWith('…') ? returned.content.slice(0, -1) : returned.content
        if (exact.includes(body)) result.verbatim += 1
        // 保地基：关键句（第一句）必须逐字在返回正文里
        if (body.includes(firstSentence(exact))) result.baseSent += 1
        // 证据链：这条 gold 能被回源（ES 里 content_exact 存在，前面已拿到）
        result.resolvable += 1
      }
    }
  }
  return result
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return `${((n / d) * 100).toFixed(1)}%`
}

async function fetchContentExact(deps: SearchDeps, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const index = `${deps.personalPrefix}${deps.userId}`
  const res = await deps.reader.search(index, {
    size: ids.length,
    _source: ['memory_id', 'content_exact'],
    query: { terms: { memory_id: [...ids] } },
  })
  for (const hit of res.hits) {
    const id = typeof hit.source.memory_id === 'string' ? hit.source.memory_id : hit.id
    const exact = typeof hit.source.content_exact === 'string' ? hit.source.content_exact : ''
    if (id !== '' && exact !== '') out.set(id, exact)
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv)
  const cfg = parsePluginConfig(opts.config)
  const rows = loadGold(opts.gold)
  const reader = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    requestTimeoutMs: cfg.requestTimeoutMs,
    username: cfg.username,
    password: cfg.password,
  })
  const embed = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })
  const now = new Date('2026-11-16T00:00:00Z')
  const baseDeps: SearchDeps = {
    userId: cfg.userId,
    personalPrefix: cfg.personalPrefix,
    teamIndex: cfg.teamIndex,
    reader,
    embed,
    dims: cfg.dims,
    now: () => now,
    retrieval: { topK: 20, rrfK: 60, limit: 8 },
    ranking: { ...DEFAULT_RANKING },
  }
  const allGoldIds = [...new Set(rows.flatMap((r) => r.gold_ids))]
  const contentExact = await fetchContentExact(baseDeps, allGoldIds)

  const modes = [
    { name: 'bm25-only', deps: { ...baseDeps, embed: null } },
    { name: 'hybrid', deps: baseDeps },
  ]
  const results: ModeResult[] = []
  for (const mode of modes) {
    results.push(await runMode(mode.deps, rows, opts.limit, mode.name, contentExact))
  }

  console.log(`gold-set：${opts.gold}（${rows.length} 条；可答 ${rows.filter((r) => r.gold_ids.length > 0).length}、弃答 ${rows.filter((r) => r.gold_ids.length === 0).length}）`)
  console.log(`配置：${opts.config}  索引：${cfg.personalPrefix}${cfg.userId} + ${cfg.teamIndex}\n`)
  const header = ['模式', 'R@5', 'MRR', '专名R@5', '缩写R@5', '时间R@5', '弃答误命中', '逐字率', '保地基', '证据链']
  const lines = results.map((r) => [
    r.mode,
    pct(r.r5, r.answerable),
    (r.mrr / Math.max(1, r.answerable)).toFixed(3),
    pct(r.byTag['专名']?.r5 ?? 0, r.byTag['专名']?.total ?? 0),
    pct(r.byTag['缩写']?.r5 ?? 0, r.byTag['缩写']?.total ?? 0),
    pct(r.byTag['时间']?.r5 ?? 0, r.byTag['时间']?.total ?? 0),
    `${r.falsePositive}/${rows.length - r.answerable}`,
    pct(r.verbatim, r.verbatimTotal),
    pct(r.baseSent, r.verbatimTotal),
    pct(r.resolvable, r.verbatimTotal),
  ])
  const widths = header.map((h, i) => Math.max(h.length * 2, ...lines.map((l) => (l[i] ?? '').length)))
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length))
  console.log(header.map((h, i) => pad(h, widths[i]!)).join('  '))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const line of lines) console.log(line.map((c, i) => pad(c ?? '', widths[i]!)).join('  '))

  if (opts.json !== '') {
    writeFileSync(opts.json, `${JSON.stringify({ gold: opts.gold, results }, null, 2)}\n`, 'utf8')
    console.log(`\n已写入：${opts.json}`)
  }
}

await main()
