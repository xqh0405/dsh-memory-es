#!/usr/bin/env node
/**
 * 回填团队库的 `summary` 与 `semantic_keywords`（阶段 25.4 / 25.5，2026-11-09 决定走 LLM 抽取）。
 *
 * 为什么需要：`search_dsl` 给 `summary^1.5` 加权，而这个字段在团队库几乎全空（326/327）——
 * 等于这条权重一直空转；`semantic_keywords` 同理影响召回（269/327 缺）。
 *
 * 为什么用 LLM 而不是规则摘要：规则摘要只能截前 N 字，抓不到「这条讲的是什么事」；
 * 而 summary 的用途正是「列表与二次检索的短摘要」，截断版对检索没有增益。
 *
 * 口径与 `memory_distill` 一致：summary = 一句话（保留数字/路径/版本/错误码），
 * keywords = 同义词、组件名、命令名（补足原文没直说的说法）。
 *
 * 用法：
 *   node scripts/backfill-team-summary.ts                 # 只看有多少条要补（默认 dry-run）
 *   node scripts/backfill-team-summary.ts --limit 10 --dry-run --show   # 抽 10 条看产出
 *   node scripts/backfill-team-summary.ts --apply         # 真的写（可续跑）
 *
 * 幂等与续跑：只填**缺失**字段（已有值不动），已完成的 id 记在
 * `$DSH_HOME/memory-es/team-summary-done.txt`，中断后重跑自动跳过。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createEsClient } from '../src/es/http.ts'
import { DEFAULT_CONFIG_PATH, parsePluginConfig } from './lib/plugin-config.ts'

const TEAM_INDEX = 'team_knowledge'
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'
const SUMMARY_MAX = 120
const KEYWORDS_MAX = 8
const CONCURRENCY = 4

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const show = argv.includes('--show')
const limitArg = argv.find((a) => a.startsWith('--limit='))
const limit = limitArg === undefined ? 0 : Number(limitArg.slice('--limit='.length)) || 0

const cfg = parsePluginConfig(DEFAULT_CONFIG_PATH)
const es = createEsClient({
  url: cfg.esUrl,
  caCertPath: cfg.caCertPath,
  requestTimeoutMs: cfg.requestTimeoutMs,
  username: cfg.username,
  password: cfg.password,
})

const stateDir = join(homedir(), '.dsh', 'memory-es')
const donePath = join(stateDir, 'team-summary-done.txt')
const done = new Set<string>(
  existsSync(donePath) ? readFileSync(donePath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '') : [],
)

/** 从凭据库取 deepseek key。只读 refs 里的那一行，不解析整份 YAML、不打印。 */
function readApiKey(): string {
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(path, 'utf8')
  const m = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text)
  if (m === null) throw new Error('凭据库里没有 DEEPSEEK_API_KEY（refs 段）')
  return m[1].replace(/^["']|["']$/g, '')
}

interface Target {
  id: string
  content: string
  domain: string
}

async function fetchTargets(): Promise<Target[]> {
  // 两个字段任一缺失都算「要补」；已完成的按 id 跳过，保证续跑不重复花钱
  const body = {
    size: 500,
    _source: ['content', 'memory_id', 'summary', 'semantic_keywords', 'domain'],
    query: {
      bool: {
        should: [
          { bool: { must_not: { exists: { field: 'summary' } } } },
          { bool: { must_not: { exists: { field: 'semantic_keywords' } } } },
          { term: { summary: '' } },
        ],
        minimum_should_match: 1,
      },
    },
  }
  const res = await es.search(TEAM_INDEX, body)
  const out: Target[] = []
  for (const hit of res.hits) {
    const id = String(hit.id ?? hit.source.memory_id ?? '')
    if (id === '' || done.has(id)) continue
    const content = String(hit.source.content ?? '').trim()
    if (content === '') continue
    out.push({ id, content, domain: String(hit.source.domain ?? 'general') })
  }
  return limit > 0 ? out.slice(0, limit) : out
}

const SYSTEM_PROMPT = [
  '你是记忆库的索引员。给你一条团队记忆的原文，产出一个可检索的短摘要和检索关键词。',
  '',
  '硬性要求：',
  '1. 只输出 JSON，不要解释、不要代码块。格式：{"summary":"…","keywords":["…","…"]}',
  `2. summary 是一句话，不超过 ${SUMMARY_MAX} 个字符；**必须保留原文里的数字、路径、版本号、错误码、命令名**。`,
  '3. keywords 给 3~8 个，是检索时会用到的词：同义词、组件名、命令名、术语的中英对照（例如「幂等 idempotent」）。',
  '4. 不要复述「这是一条关于…的记忆」这种废话，直接说内容。',
  '5. 不确定的地方不要编造。',
].join('\n')

async function callLlm(apiKey: string, target: Target): Promise<{ summary: string; keywords: string[] } | null> {
  const userContent = `业务域：${target.domain}\n\n原文：\n${target.content.slice(0, 6000)}`
  const body = JSON.stringify({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    max_tokens: 400,
    response_format: { type: 'json_object' },
  })
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = json.choices?.[0]?.message?.content ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 模型偶尔会包一层代码块，剥一次再试
    const m = /\{[\s\S]*\}/.exec(raw)
    if (m === null) return null
    try {
      parsed = JSON.parse(m[0])
    } catch {
      return null
    }
  }
  const obj = parsed as { summary?: unknown; keywords?: unknown }
  const summary = typeof obj.summary === 'string' ? obj.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX) : ''
  const keywords = Array.isArray(obj.keywords)
    ? [...new Set(obj.keywords.map((k) => String(k).trim()).filter((k) => k !== '' && k.length <= 24))].slice(0, KEYWORDS_MAX)
    : []
  if (summary === '' || keywords.length < 3) return null
  return { summary, keywords }
}

async function main(): Promise<void> {
  const targets = await fetchTargets()
  console.log(`要补的条目：${targets.length} 条${limit > 0 ? `（本次限量 ${limit}）` : ''}${apply ? '' : '（dry-run，不写）'}`)
  if (targets.length === 0) return

  const apiKey = readApiKey()
  let ok = 0
  let failed = 0
  const queue = [...targets]

  async function worker(): Promise<void> {
    for (;;) {
      const target = queue.shift()
      if (target === undefined) return
      try {
        const out = await callLlm(apiKey, target)
        if (out === null) {
          failed += 1
          console.log(`  [跳过] ${target.id} 模型输出不合规`)
          continue
        }
        if (show) {
          console.log(`  [样例] ${target.id}\n    summary: ${out.summary}\n    keywords: ${out.keywords.join(' / ')}`)
        }
        if (apply) {
          await es.update(
            TEAM_INDEX,
            target.id,
            { summary: out.summary, semantic_keywords: out.keywords },
          )
          mkdirSync(dirname(donePath), { recursive: true })
          appendFileSync(donePath, `${target.id}\n`)
          done.add(target.id)
        }
        ok += 1
      } catch (err) {
        failed += 1
        console.log(`  [失败] ${target.id} ${String(err).slice(0, 120)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  console.log(`完成：成功 ${ok} / 失败或跳过 ${failed}${apply ? '，已写入' : '，dry-run 未写'}`)
}

await main()
