/**
 * `memory_distill` —— 把一条个人记忆**改写**成"信息更全、更好检索"的版本。
 *
 * 为什么要有这个工具：入库时存的是原文（`memory_save` 不调模型，不让入库被模型可用性卡住），
 * 蒸馏由**后台子代理**来做。子代理读 `distill_state=pending` 的条目，用本工具写回：
 *   · content  = 蒸馏后的正文：保留事实/条件/路径/数字/结论，去掉口语与重复；
 *   · summary  = 一句话（给列表与二次检索的短摘要）；
 *   · keywords = 检索用关键词（同义词、组件名、命令名），补足原文里没直说的说法；
 *   · topic_key= 这条属于哪个主题（缺省沿用原值）。
 *
 * 三条硬约束：
 *   1. **不改身份与来源**：user_id / created_at / status / promote_state 一律不许动；
 *   2. **不丢原文细节**：这是"提炼 + 补索引信息"，不是"压缩到最短"——原文里的数字、路径、
 *      版本号、错误码要保留，否则下次检索到了也用不上；
 *   3. **写完标 done**：`distill_state=done` 才不会被重复处理；失败的条目保持 pending，
 *      下一轮重试（子代理那边负责不让它无限重试）。
 *
 * @module dsh-memory-es/memory/distill
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MemoryStoreDeps } from './common.ts'
import { loadOwnedDoc, nowIso, personalIndexFor } from './common.ts'

export const DISTILL_STATES = ['pending', 'done', 'skipped', 'failed'] as const
export type DistillState = (typeof DISTILL_STATES)[number]

/** 蒸馏后正文的上限：比入库上限(4000)略宽，避免"提炼"变成"删信息" */
export const MAX_DISTILLED_CHARS = 6_000

export interface DistillInput {
  memory_id: string
  content: string
  summary?: string
  keywords?: string[]
  topic_key?: string
}

export interface DistillResult {
  memory_id: string
  distill_state: string
  content_chars: number
  changed: boolean
  text: string
}

export interface DistillDeps extends MemoryStoreDeps {
  now?: () => Date
  /** 重建向量用；不可用时保留旧向量（降级，不阻塞改写） */
  embed?: { embed(text: string): Promise<number[]> } | null
}

export async function distillMemory(deps: DistillDeps, input: DistillInput): Promise<DistillResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const current = await loadOwnedDoc(deps, input.memory_id)

  const content = (input.content ?? '').trim()
  if (content === '') throw new Error('content 不能为空（蒸馏是改写，不是清空）')
  if (content.length > MAX_DISTILLED_CHARS) {
    throw new Error(`蒸馏后正文 ${content.length} 字符，超过上限 ${MAX_DISTILLED_CHARS}；这是提炼，不该变长`)
  }

  const original = typeof current.source.content === 'string' ? current.source.content : ''
  // 防线：蒸馏不等于丢信息。正文缩到原文的 30% 以下时，要求显式确认（避免"写了一句话就标 done"）
  if (original.length > 200 && content.length < original.length * 0.3) {
    log({
      tool: 'distill',
      user: deps.userId,
      memory_id: current.id,
      warn: 'content_shrank',
      before: original.length,
      after: content.length,
    })
  }

  const patch: Record<string, unknown> = {
    content,
    distill_state: 'done',
    distilled_at: nowIso(deps.now?.() ?? new Date()),
    distill_source_chars: original.length,
    updated_at: nowIso(deps.now?.() ?? new Date()),
  }
  const summary = (input.summary ?? '').trim()
  if (summary !== '') patch.summary = summary
  const keywords = (input.keywords ?? []).map((k) => k.trim()).filter((k) => k !== '')
  if (keywords.length > 0) patch.semantic_keywords = keywords
  const topicKey = (input.topic_key ?? '').trim()
  if (topicKey !== '') patch.topic_key = topicKey

  // 正文变了，向量要跟着变：不改 embedding = 检索永远匹配旧原文（"蒸馏完反而搜不到"）
  let embeddingRebuilt = false
  if (deps.embed) {
    try {
      const vector = await deps.embed.embed(content)
      if (Array.isArray(vector) && vector.length > 0) {
        patch.embedding = vector
        embeddingRebuilt = true
      }
    } catch (err) {
      log({ tool: 'distill', user: deps.userId, memory_id: current.id, degraded: 'embedding', error: String(err).slice(0, 200) })
    }
  }

  const written = await deps.writer.update(index, current.id, patch, { refresh: 'wait_for' })

  log({
    tool: 'distill',
    user: deps.userId,
    memory_id: current.id,
    ms: Date.now() - startedAt,
    changed: written.result !== 'noop',
    before: original.length,
    after: content.length,
    keywords: keywords.length,
    embedding: embeddingRebuilt,
  })

  return {
    memory_id: current.id,
    distill_state: 'done',
    content_chars: content.length,
    changed: written.result !== 'noop',
    text:
      `已改写（${original.length} → ${content.length} 字符，关键词 ${keywords.length} 个，` +
      `${embeddingRebuilt ? '向量已重建' : '向量沿用旧的（embedding 不可用）'}），distill_state=done`,
  }
}

const DESCRIPTION = [
  '把一条个人记忆改写成「信息更全、更好检索」的版本（后台蒸馏用，不要在对话里随手调）。',
  '改写要求：保留事实、条件、路径、数字、版本号、错误码；去掉口语、重复、无信息量的客套；',
  '并补 summary（一句话）、keywords（同义词/组件名/命令名）、可选 topic_key。',
  '只作用于自己的个人库；不会改 user_id/created_at/status/promote_state，也不会写团队库。',
].join(' ')

export function defineDistillTool(deps: DistillDeps) {
  return defineTool({
    name: 'memory_distill',
    description: DESCRIPTION,
    parameters: {
      memory_id: { type: 'string', required: true, description: '要改写的 memory_id（检索结果里就是它）。' },
      content: { type: 'string', required: true, description: '改写后的正文（信息保留，不是越短越好）。' },
      summary: { type: 'string', description: '一句话摘要（列表与二次检索用）。' },
      keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词：同义词、组件名、命令名。' },
      topic_key: { type: 'string', description: '所属主题（缺省沿用原值）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          distill_state: { type: 'string', required: true },
          content_chars: { type: 'number', required: true },
          changed: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 一次读 + 一次写
    timeoutMs: 15_000,
    async execute(input, exec) {
      const result = await distillMemory(deps, {
        memory_id: String(input.memory_id ?? ''),
        content: String(input.content ?? ''),
        summary: input.summary === undefined ? undefined : String(input.summary),
        keywords: Array.isArray(input.keywords) ? input.keywords.map((k) => String(k)) : undefined,
        topic_key: input.topic_key === undefined ? undefined : String(input.topic_key),
      })
      return result
    },
  })
}
