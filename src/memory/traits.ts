/**
 * 阶段 7.2：夜间提炼——从近期记忆里归纳「稳定的自述」（traits）。
 *
 * 与 `distill.ts` 的区别：distill 改写**单条**记忆的摘要与关键词；这里是从**一批**
 * 记忆里归纳出**不属于任何单条**的结论（"他偏好先给结论"不是哪条记忆的内容）。
 *
 * 三条硬规则：
 *  1. **只写候选，不写生效条目**。产出落 `memory_type=identity` + `status='pending'`，
 *     检索只认 `active`，所以提炼结果不会自己溜进上下文；采纳由 7.3 的审核台做。
 *  2. **必须带证据**。每条 trait 记下它依据的 memory_id，审核时能点开核对。
 *     没有证据的归纳等于让模型编。
 *  3. **模型不可用就什么都不做**。提炼是增强能力，不能因为没配模型就报错或写垃圾。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { personalIndexFor } from './common.ts'
import { IDENTITY_MEMORY_TYPE } from './save.ts'

/** 候选 trait 的状态：检索只认 active，所以 pending 天然不进结果 */
export const TRAIT_STATUS = 'pending' as const

/** 归纳时喂给模型的最大条数（context 与成本的上界） */
export const TRAITS_MAX_SOURCE = 80
/** 单次最多接受多少条 trait（防止模型一次吐 50 条） */
export const TRAITS_MAX_OUTPUT = 8
/** 一条 trait 的字符上限 */
export const TRAIT_MAX_CHARS = 300
/** 证据条数下限：少于两条支撑的不叫"稳定" */
export const TRAIT_MIN_EVIDENCE = 2

export const TRAITS_SYSTEM = [
  '你是一个记忆整理器。你的任务是：从一个人最近的记忆条目里，归纳出关于这个人自己的、稳定的模式。',
  '',
  '什么算「稳定的模式」：',
  '- 反复出现的工作方式（例如：总是先给结论再解释）',
  '- 一贯的偏好与取舍（例如：宁可慢一点也不要静默失败）',
  '- 明确的判断准则（例如：不确定时承认不确定，不猜）',
  '',
  '什么不算：',
  '- 具体事件与一次性决定（那属于普通记忆，不需要提升）',
  '- 项目里的事实（技术栈、端口、路径）',
  '- 只出现一次的行为',
  '',
  '硬性要求：',
  '1. 每条必须能独立成立，读者不知道上下文也能看懂；不要写「上面提到的」「这些记忆里」。',
  '2. 每条必须由至少 2 条记忆支撑，并给出支撑条目的 id。',
  '3. 用第二人称写（"你倾向于……"）或中性陈述，不要写"用户"。',
  `4. 每条不超过 ${TRAIT_MAX_CHARS} 字，一次最多 ${TRAITS_MAX_OUTPUT} 条。`,
  '5. 如果看不出任何稳定的模式，输出空数组 []。**宁可空，不要凑**。',
  '',
  '输出格式（只输出 JSON，不要解释）：',
  '[',
  '  {"content": "你倾向于先给结论再解释理由", "evidence_ids": ["id1", "id2"]}',
  ']',
].join('\n')

export interface TraitCandidate {
  content: string
  evidence_ids: string[]
}

/** 喂给模型的源条目（id + 正文 + 类型） */
export interface TraitSource {
  memory_id: string
  content: string
  memory_type: string
}

export interface TraitsDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'search'>
  writer: Pick<EsClient, 'index'>
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}

/** 把源条目拼成 prompt 正文。id 必须带上去，否则模型给不出证据。 */
export function buildTraitsPrompt(sources: readonly TraitSource[], days: number): string {
  const lines = sources.map((s) => `- [${s.memory_id}] (${s.memory_type}) ${s.content}`)
  return [
    `下面是最近 ${days} 天里的 ${sources.length} 条记忆。请归纳出关于这个人自己的稳定模式。`,
    '',
    ...lines,
  ].join('\n')
}

/**
 * 解析模型输出。容忍 ```json 围栏与前后废话——模型很少严格只吐 JSON。
 *
 * 校验比 distill 严：`content` 必须非空且不超长、`evidence_ids` 至少两条且必须
 * **真的出现在源集合里**（防止模型编造 id）。
 */
export function parseTraitsOutput(text: string, sourceIds?: ReadonlySet<string>): TraitCandidate[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: TraitCandidate[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { content?: unknown; evidence_ids?: unknown }
    if (typeof record.content !== 'string') continue
    const content = record.content.trim()
    if (content === '' || content.length > TRAIT_MAX_CHARS) continue
    if (!Array.isArray(record.evidence_ids)) continue
    const ids = record.evidence_ids
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim())
    // 去重：同一条证据重复三次不算三条支撑
    const unique = [...new Set(ids)]
    if (unique.length < TRAIT_MIN_EVIDENCE) continue
    if (sourceIds !== undefined && unique.some((id) => !sourceIds.has(id))) continue
    out.push({ content, evidence_ids: unique })
    if (out.length >= TRAITS_MAX_OUTPUT) break
  }
  return out
}

/** 取最近 N 天的记忆作为素材：只要 active、排除 identity 自己与情绪状态文档 */
export async function collectTraitSources(
  deps: TraitsDeps,
  days: number,
): Promise<TraitSource[]> {
  const now = deps.now?.() ?? new Date()
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const res = await deps.reader.search(index, {
    size: TRAITS_MAX_SOURCE,
    _source: ['memory_id', 'content', 'memory_type'],
    sort: [{ updated_at: 'desc' }],
    query: {
      bool: {
        filter: [
          { term: { status: 'active' } },
          { range: { updated_at: { gte: since } } },
        ],
        must_not: [
          { term: { memory_type: IDENTITY_MEMORY_TYPE } },
          // 情绪状态文档不是记忆素材
          { term: { status: 'mood' } },
        ],
      },
    },
  })
  const sources: TraitSource[] = []
  for (const hit of res.hits) {
    const src = hit.source as Record<string, unknown>
    if (typeof src.memory_id !== 'string' || typeof src.content !== 'string') continue
    sources.push({
      memory_id: src.memory_id,
      content: src.content,
      memory_type: typeof src.memory_type === 'string' ? src.memory_type : 'fact',
    })
  }
  return sources
}

/** 写一条候选 trait。用内容哈希做幂等（同一条被提炼两次不会产生两份）。 */
export async function writeTraitCandidate(
  deps: TraitsDeps,
  trait: TraitCandidate,
  days: number,
): Promise<{ written: boolean; memory_id: string }> {
  const now = deps.now?.() ?? new Date()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const memoryId = `trait-${hashContent(trait.content)}`

  const doc: Record<string, unknown> = {
    memory_id: memoryId,
    user_id: deps.userId,
    content: trait.content,
    memory_type: IDENTITY_MEMORY_TYPE,
    domain: 'general',
    privacy: 'private',
    importance: 'normal',
    // 关键：pending 而不是 active——检索只认 active，所以候选不会自己生效
    status: TRAIT_STATUS,
    promote_state: 'none',
    distill_state: 'traits',
    evidence_ids: trait.evidence_ids,
    traits_window_days: days,
    content_sha256: hashContent(trait.content),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }

  try {
    // create 而不是 index：同 id 已存在时返回 409，靠它做幂等（不会把已拒绝/已采纳的条目覆盖回 pending）
    await deps.writer.index(index, doc, { id: memoryId, refresh: 'wait_for', opType: 'create' })
    return { written: true, memory_id: memoryId }
  } catch (err) {
    if (isConflict(err)) return { written: false, memory_id: memoryId }
    deps.log?.({ tool: 'traits', event: 'write_failed', error: formatEsError(err) })
    throw err
  }
}

export interface TraitsResult {
  sources: number
  candidates: number
  written: number
  skipped: string | null
}

/**
 * 编排：取素材 → （调用方给模型）→ 校验 → 写候选。
 *
 * 模型调用留在外面（`summarize` 由调用方注入）：这里不 import 宿主 llm 类型，
 * 便于单测，也让"没有模型服务"这件事在调用方一次判断完。
 */
export async function runTraitsJob(
  deps: TraitsDeps,
  input: { days: number; summarize: (prompt: string) => Promise<string>; dryRun?: boolean },
): Promise<TraitsResult> {
  const log = deps.log ?? (() => {})
  const sources = await collectTraitSources(deps, input.days)
  if (sources.length < TRAIT_MIN_EVIDENCE) {
    log({ tool: 'traits', skipped: 'too_few_sources', sources: sources.length })
    return { sources: sources.length, candidates: 0, written: 0, skipped: 'too_few_sources' }
  }

  const raw = await input.summarize(buildTraitsPrompt(sources, input.days))
  const sourceIds = new Set(sources.map((s) => s.memory_id))
  const candidates = parseTraitsOutput(raw, sourceIds)
  log({ tool: 'traits', event: 'parsed', sources: sources.length, candidates: candidates.length, chars: raw.length })

  if (input.dryRun === true) {
    return { sources: sources.length, candidates: candidates.length, written: 0, skipped: 'dry_run' }
  }

  let written = 0
  for (const trait of candidates) {
    const result = await writeTraitCandidate(deps, trait, input.days)
    if (result.written) written += 1
  }
  log({ tool: 'traits', event: 'done', sources: sources.length, candidates: candidates.length, written })
  return { sources: sources.length, candidates: candidates.length, written, skipped: null }
}

/** 与 save.ts 一致的内容归一化哈希口径（便于两边判重口径相同） */
export function hashContent(content: string): string {
  const normalized = content
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase()
  // 简单 FNV-1a：不需要密码学强度，只要稳定且短
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function isConflict(err: unknown): boolean {
  const record = err as { status?: unknown } | null | undefined
  return record?.status === 409
}

const TRAITS_DESCRIPTION = [
  '从近期记忆里归纳「关于你自己的稳定模式」候选（identity 类型），**只写候选不生效**。',
  '默认 dry_run=true，先看产出再决定是否落库；落库的条目 status=pending，不会进检索。',
  '需要模型服务：没有可用模型时直接返回 skipped，不报错。',
].join('')

export interface TraitsToolDeps extends TraitsDeps {
  /** 由插件层注入：调宿主模型服务；返回模型原文 */
  summarize?: (prompt: string) => Promise<string>
}

/** `memory_traits` 工具：手动触发提炼。默认干跑。 */
export function defineTraitsTool(deps: TraitsToolDeps) {
  return defineTool({
    name: 'memory_traits',
    description: TRAITS_DESCRIPTION,
    parameters: {
      days: {
        type: 'number',
        description: `回看多少天的记忆（默认 14，上限 90）。素材最多取 ${TRAITS_MAX_SOURCE} 条。`,
      },
      dry_run: {
        type: 'boolean',
        description: 'true（默认）= 只返回候选内容不落库；false = 写成 status=pending 的候选。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: { type: 'number', required: true },
          candidates: { type: 'number', required: true },
          written: { type: 'number', required: true },
          skipped: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 一次检索 + 一次模型调用（模型慢，给足）+ 最多 8 次写
    timeoutMs: 120_000,
    async execute(input) {
      const days = clampDays(input.days)
      const dryRun = input.dry_run !== false
      const summarize = deps.summarize
      if (summarize === undefined) {
        return { sources: 0, candidates: 0, written: 0, skipped: 'no_llm_service', text: '没有可用的模型服务，本次没有提炼（记忆库本身不受影响）。' }
      }
      const result = await runTraitsJob(deps, { days, summarize, dryRun })
      return { ...result, skipped: result.skipped ?? '', text: renderTraitsText(result, days, dryRun) }
    },
  })
}

function clampDays(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 14
  return Math.max(1, Math.min(90, n))
}

function renderTraitsText(result: TraitsResult, days: number, dryRun: boolean): string {
  if (result.skipped === 'too_few_sources') {
    return `最近 ${days} 天只有 ${result.sources} 条记忆，不足两条，无法归纳。`
  }
  if (result.skipped === 'dry_run') {
    return `最近 ${days} 天共 ${result.sources} 条记忆，模型给出 ${result.candidates} 条候选（干跑，未落库）。要落库请用 dry_run=false。`
  }
  return `最近 ${days} 天共 ${result.sources} 条记忆，模型给出 ${result.candidates} 条候选，新写入 ${result.written} 条（status=pending，未生效）。`
}
