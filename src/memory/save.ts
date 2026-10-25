/**
 * `memory_save` —— 记忆写入的唯一入口。
 *
 * 三层分离，方便测：
 *  1. `buildMemoryDoc()`  纯函数：输入 → 完整文档（含注入、时间、sha）
 *  2. `saveMemory()`      编排：去重 → embedding（可降级）→ F3 断言 → 写 ES
 *  3. `defineSaveTool()`  只做 defineTool 包装与文案
 *
 * 三道防线（文档 §4.4，别当它们是安全边界宣传）：
 *  · F1 工具参数里**没有 user_id**，模型无从指定；
 *  · F2 `user_id` 与索引名都从配置派生（`personalPrefix + userId`），调用点拼不出别的；
 *  · F3 写前断言 `doc.user_id === userId`，抓的是「重构时把注入点改错」。
 *
 * @module dsh-memory-es/memory/save
 */

import { randomUUID } from 'node:crypto'

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Embedder } from '../embedding.ts'
import { EmbeddingError } from '../embedding.ts'
import { dedupeBody } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { normalizeContent, sha256Hex } from '../fragment.ts'
import { assertDocOwner, personalIndexFor } from './common.ts'

// F3 的断言搬到 common.ts（三个写侧工具共用），这里转出保持老调用点与测试不受影响
export { assertDocOwner } from './common.ts'

/** §3.3 的枚举，顺序即给模型看的顺序 */
export const MEMORY_TYPES = ['preference', 'fact', 'task_progress', 'decision', 'context'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const PRIVACY_VALUES = ['normal', 'private'] as const
export type Privacy = (typeof PRIVACY_VALUES)[number]

/** 一条记忆的正文上限：记忆是「一句可独立成立的事实」，不是文档搬运 */
export const MAX_CONTENT_CHARS = 4_000
/** ttl_days 上限（10 年）；再长就不该用过期的语义 */
export const MAX_TTL_DAYS = 3_650

export interface SaveInput {
  content: string
  memory_type?: MemoryType
  domain?: string
  privacy?: Privacy
  ttl_days?: number
}

export interface SaveResult {
  /** 新写入或命中去重时已有的文档 id */
  memory_id: string
  /** true = 已有同内容（归一化后哈希相同），本次没有写入 */
  deduped: boolean
  /** true = embedding 不可用，只写关键词可检索的那部分 */
  degraded: boolean
  /** 给模型看的一句话 */
  text: string
}

export interface SaveDeps {
  /**
   * 写入成功后触发（**不要 await**）：插件层用它排队后台蒸馏。
   * save 必须立刻返回——蒸馏是"事后整理"，不能把入库卡在模型上。
   */
  onSaved?: (info: { memoryId: string; content: string; domain: string }) => void
  /** 取消信号（来自 exec.signal） */
  signal?: AbortSignal
  /** F2 注入源（来自 identity.userId） */
  userId: string
  /** 个人索引前缀；索引名在这里拼（`personalIndex` 由前缀 + userId 派生，不给调用点拼错的机会） */
  personalPrefix: string
  defaultDomain: string
  /** 去重检索用只读身份 */
  reader: Pick<EsClient, 'search'>
  /** 写入用 writer 身份 */
  writer: Pick<EsClient, 'index'>
  /** 可缺省：不给就一律 degraded（测试与「故意关掉向量」的场景） */
  embed?: Pick<Embedder, 'embed'> | null
  /** 注入时钟，便于测试 */
  now?: () => Date
  /** 注入 id 生成器，便于测试 */
  newId?: () => string
  /** 结构化日志：不记录 content / embedding / 凭证 */
  log?: (event: Record<string, unknown>) => void
}

/** 归一化 + 校验后的写入素材 */
export interface BuiltDoc {
  doc: Record<string, unknown>
  /** 实际写入的索引名 */
  index: string
  /** 归一化正文的 sha256（去重键） */
  contentSha256: string
}

function isIsoDate(value: Date): string {
  return value.toISOString()
}

/**
 * 纯函数：输入 → 待写文档。所有字段都显式给，**不读外部状态**（时钟/随机数/配置由参数进）。
 * 返回 index 而不是让调用方再拼一次，是为了让「文档里的 user_id」与「写进哪个索引」同源。
 */
export function buildMemoryDoc(
  input: SaveInput,
  deps: Pick<SaveDeps, 'userId' | 'personalPrefix' | 'defaultDomain'>,
  options: { now: Date; memoryId: string; embedding: number[] | null },
): BuiltDoc {
  const userId = deps.userId
  if (!userId || userId.trim() === '') {
    throw new Error('memory_save: 缺少 identity.userId，拒绝写入（不写匿名）')
  }

  const raw = input.content ?? ''
  if (typeof raw !== 'string') throw new Error('memory_save: content 必须是字符串')
  const normalized = normalizeContent(raw)
  if (normalized === '') throw new Error('memory_save: content 不能为空')
  if (raw.length > MAX_CONTENT_CHARS) {
    throw new Error(`memory_save: content 过长（${raw.length} 字符 > 上限 ${MAX_CONTENT_CHARS}）`)
  }

  const memoryType = input.memory_type ?? 'fact'
  if (!MEMORY_TYPES.includes(memoryType)) {
    throw new Error(`memory_save: 未知 memory_type「${String(memoryType)}」`)
  }
  const privacy = input.privacy ?? 'normal'
  if (!PRIVACY_VALUES.includes(privacy)) {
    throw new Error(`memory_save: 未知 privacy「${String(privacy)}」`)
  }

  let expiresAt: string | undefined
  if (input.ttl_days !== undefined) {
    const days = input.ttl_days
    if (!Number.isInteger(days) || days < 1 || days > MAX_TTL_DAYS) {
      throw new Error(`memory_save: ttl_days 必须是 1~${MAX_TTL_DAYS} 的整数（收到 ${String(days)}）`)
    }
    expiresAt = isIsoDate(new Date(options.now.getTime() + days * 86_400_000))
  }

  const timestamp = isIsoDate(options.now)
  const doc: Record<string, unknown> = {
    memory_id: options.memoryId,
    user_id: userId,
    // 存原文（返回给模型看的是原文），哈希用归一化后的正文
    content: raw,
    memory_type: memoryType,
    domain: input.domain?.trim() || deps.defaultDomain,
    privacy,
    promote_state: 'none',
    // 蒸馏状态：入库立刻可见（pending），后台子代理处理后改成 done。
    // 由插件自己写，不依赖 LLM —— 入库不能被模型可用性卡住。
    distill_state: 'pending',
    status: 'active',
    content_sha256: sha256Hex(normalized),
    created_at: timestamp,
    updated_at: timestamp,
  }
  if (expiresAt !== undefined) doc.expires_at = expiresAt
  // semantic_keywords 是 §7.2 的 LLM 增强字段，S3 还没接（不写空串，省一次 mapping 校验）；
  // 只给字段等于让检索以为“有值但为空”，不如缺失。
  if (options.embedding !== null && options.embedding.length > 0) {
    doc.embedding = options.embedding
  }

  // F2 的同一性：索引名与 user_id 必须同源（前缀 + 同一 userId）
  const index = personalIndexFor(deps.personalPrefix, userId)
  return { doc, index, contentSha256: doc.content_sha256 as string }
}

/**
 * 编排：去重 → embedding（可降级）→ F3 → 写（refresh=wait_for，写完立刻可搜）。
 * 失败一律抛（不吞）：ES 不可用时记忆操作必须**明确失败**，不能装作已保存（§6.5）。
 */
export async function saveMemory(deps: SaveDeps, input: SaveInput): Promise<SaveResult> {
  const startedAt = Date.now()
  const now = deps.now?.() ?? new Date()
  const newId = deps.newId ?? randomUUID
  const log = deps.log ?? (() => {})
  const index = personalIndexFor(deps.personalPrefix, deps.userId)

  // 先算一遍拿到 sha 与校验（也会在这里拦空内容/超长），再决定是否去重
  const probe = buildMemoryDoc(input, deps, { now, memoryId: newId(), embedding: null })

  const dup = await deps.reader.search(index, dedupeBody(probe.contentSha256), { signal: deps.signal })
  const existing = dup.hits[0]
  if (existing) {
    const existingId = typeof existing.source.memory_id === 'string' ? existing.source.memory_id : existing.id
    log({ tool: 'save', user: deps.userId, ms: Date.now() - startedAt, deduped: true, degraded: false })
    return {
      memory_id: existingId,
      deduped: true,
      degraded: false,
      text: `已存在相同内容（memory_id=${existingId}），未重复写入`,
    }
  }

  let embedding: number[] | null = null
  let degraded = false
  let embedFailure: string | undefined
  if (deps.embed) {
    try {
      embedding = await deps.embed.embed(normalizeContent(input.content), { signal: deps.signal })
    } catch (err) {
      degraded = true
      embedFailure = err instanceof EmbeddingError ? err.kind : 'unknown'
      log({ tool: 'save', user: deps.userId, event: 'embedding_degraded', kind: embedFailure })
    }
  } else {
    degraded = true
  }

  const built = buildMemoryDoc(input, deps, { now, memoryId: probe.doc.memory_id as string, embedding })
  assertDocOwner(built.doc, deps.userId)

  try {
    await deps.writer.index(built.index, built.doc, {
      id: String(built.doc.memory_id),
      refresh: 'wait_for',
      signal: deps.signal,
    })
  } catch (err) {
    log({ tool: 'save', user: deps.userId, ms: Date.now() - startedAt, error: formatEsError(err) })
    throw err
  }

  log({
    tool: 'save',
    user: deps.userId,
    ms: Date.now() - startedAt,
    deduped: false,
    degraded,
    ...(embedFailure === undefined ? {} : { embed_failure: embedFailure }),
  })

  // 后台蒸馏的入口：这里绝不能 await，也不能让它的异常冒出来影响"已保存"的结论
  if (deps.onSaved) {
    try {
      deps.onSaved({
        memoryId: String(built.doc.memory_id),
        content: String(built.doc.content),
        domain: String(built.doc.domain),
      })
    } catch (err) {
      log({ tool: 'save', user: deps.userId, hook_error: String(err).slice(0, 200) })
    }
  }

  return {
    memory_id: String(built.doc.memory_id),
    deduped: false,
    degraded,
    text: degraded ? '已保存（向量服务不可用，仅关键词可检索）' : '已保存',
  }
}

const DESCRIPTION = [
  '记住一条事实，存进个人记忆库，跨会话可查。',
  '时机：用户明确要求记住；做了非显然的决定；踩到可复现的坑；约定、口径或路径变了。',
  '不要存：临时进度、会话摘要、能从代码或文档直接读到的内容、凭证与个人隐私。',
  '一次一条——content 写一句能独立成立的事实，不要贴整段对话。',
  '相同内容（忽略空白与全角/半角差异）会命中去重，返回 deduped=true，不会产生第二份。',
].join(' ')

/** 把编排封成模型可见的工具定义 */
export function defineSaveTool(deps: SaveDeps) {
  return defineTool({
    name: 'memory_save',
    description: DESCRIPTION,
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: `要记住的正文：一句可独立成立的事实（上限 ${MAX_CONTENT_CHARS} 字符）。`,
      },
      memory_type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: '记忆类型，缺省 fact。preference=偏好，decision=决定，task_progress=进度，context=背景。',
      },
      domain: {
        type: 'string',
        description: `业务域短标签（如 lottery-cloud、backup-server），缺省取配置 defaults.domain。`,
      },
      privacy: {
        type: 'string',
        enum: [...PRIVACY_VALUES],
        description: 'normal（默认）或 private（不参与整理任务）。',
      },
      ttl_days: {
        type: 'integer',
        description: `可选：多少天后过期（1~${MAX_TTL_DAYS}）。只给确实会过期的临时约定用。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          deduped: { type: 'boolean', required: true },
          degraded: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 声明 timeoutMs 的前提（宿主契约）是「真的把 exec.signal 转发到内部请求」：
    // save 的一路最长链路是 去重检索 8 s + 向量 15 s + 写入 8 s，给 20 s 兜住；
    // 取消时 http/embedding 会立刻中断在途请求并抛 aborted。
    timeoutMs: 20_000,
    async execute(args, exec) {
      return await saveMemory({ ...deps, signal: exec.signal }, args)
    },
  })
}
