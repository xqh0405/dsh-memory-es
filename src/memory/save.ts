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
 * 阶段 9 加了第四道**准入**（不是安全边界，是内容闸）：
 * 凭据形态、以及「刚检索到的原文又被写回来」的候选不丢弃，而是写 `status=quarantine`
 * 隔离待审——不进检索、不建边、不蒸馏，但能在面板上审、能恢复。
 * 判定规则在 `admission.ts`（纯函数），这里只负责编排与落库。
 *
 * @module dsh-memory-es/memory/save
 */

import { randomUUID } from 'node:crypto'

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Embedder } from '../embedding.ts'
import { EmbeddingError } from '../embedding.ts'
import { dedupeBody, knnBody } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { normalizeContent, sha256Hex } from '../fragment.ts'
import { assertDocOwner, personalIndexFor } from './common.ts'
import { mergeEdges, pickNeighbors, readEdges, type Edge } from '../edges.ts'
import {
  checkAdmission,
  DEFAULT_ORIGIN,
  ORIGIN_VALUES,
  type AdmissionVerdict,
  type Origin,
  type RecallRecord,
} from './admission.ts'

// F3 的断言搬到 common.ts（三个写侧工具共用），这里转出保持老调用点与测试不受影响
export { assertDocOwner } from './common.ts'

/** §3.3 的枚举，顺序即给模型看的顺序 */
export const MEMORY_TYPES = ['preference', 'fact', 'task_progress', 'decision', 'context', 'identity'] as const

/**
 * 阶段 7.1：`identity` 承载「稳定的自述」——关于"我是谁/我怎么做事"的长期断言，
 * 由夜间提炼任务从大量日常记忆里归纳出来，经审核台采纳后才写入。
 *
 * 它与普通事实的区别不是内容，而是**来源与寿命**：普通记忆是"发生过什么"，
 * identity 是"从发生过的事里看出的自己"。所以：
 *  · 半衰期极长（它本该比事实更稳定）；
 *  · 默认**不进**普通检索结果（否则自述会挤占事实召回，见 search.ts 的排除逻辑）。
 */
export const IDENTITY_MEMORY_TYPE = 'identity'
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const PRIVACY_VALUES = ['normal', 'private'] as const
export type Privacy = (typeof PRIVACY_VALUES)[number]

/** 一条记忆的正文上限：记忆是「一句可独立成立的事实」，不是文档搬运 */
export const MAX_CONTENT_CHARS = 4_000

/** 重要度：只做 ±10% 的排序微调（见 fragment.ts 的 IMPORTANCE_FACTORS），不主导检索 */
export const IMPORTANCE_VALUES = ['critical', 'normal', 'low'] as const
export type Importance = (typeof IMPORTANCE_VALUES)[number]
/** ttl_days 上限（10 年）；再长就不该用过期的语义 */
export const MAX_TTL_DAYS = 3_650

export interface SaveInput {
  content: string
  memory_type?: MemoryType
  importance?: Importance
  domain?: string
  privacy?: Privacy
  ttl_days?: number
  /** 这条记忆自带的情感色彩（-1..1）；不给就不写字段 */
  valence?: number
  /** 情绪强度（0..1）；不给就不写字段 */
  arousal?: number
  /**
   * 阶段 9：写入来源戳（user / agent / tool / import / ingest）。
   * 缺省 `agent`——模型调这个工具是替代理记账；只有本机直接落库才算 `user`。
   */
  origin?: Origin
}

export interface SaveResult {
  /** 新写入或命中去重时已有的文档 id */
  memory_id: string
  /** true = 已有同内容（归一化后哈希相同），本次没有写入 */
  deduped: boolean
  /** true = embedding 不可用，只写关键词可检索的那部分 */
  degraded: boolean
  /** true = 命中准入屏障，已写 `status=quarantine` 隔离待审（**没有进入检索**） */
  quarantined: boolean
  /** 隔离原因（给人看）；未隔离时缺省 */
  reason?: string
  /** 近似去重提示：库里已有内容相近的条目（cos ≥ 阈值），**没有阻塞写入** */
  similar_to?: string[]
  /** 给模型看的一句话 */
  text: string
}

/** 建边配置（阶段 5.2）。缺省 = 不建边。 */
export interface EdgeWriteConfig {
  enabled: boolean
  /** 每条记忆最多保留几条边（邻接表上界，防止 O(n²) 膨胀） */
  topK: number
  /** 低于该相似度不建边（噪声） */
  minScore: number
  /** 大于等于该相似度视为重复（判重带），不建边 */
  maxScore: number
  /** 索引的向量维度，与 `knnBody` 一致 */
  dims: number
}

/**
 * 近似去重 advisory 配置（阶段 9）。
 *
 * 与建边的 `maxScore` 同源（默认都是 0.85），但**语义不同**：建边时它意味着
 * 「重复，不要连这条边」；这里它意味着「库里有条很像的，提示一句」。
 */
export interface SimilarConfig {
  enabled: boolean
  /** cos ≥ 该值就回 `similar_to`（默认 0.85，与 expectedDuplicateScore 对齐） */
  score: number
  /** 索引的向量维度（edges 缺席时也要能查，所以这里自带一份） */
  dims: number
}

export interface SaveDeps {
  /**
   * 写入成功后触发（**不要 await**）：插件层用它排队后台蒸馏。
   * save 必须立刻返回——蒸馏是"事后整理"，不能把入库卡在模型上。
   */
  onSaved?: (info: {
    memoryId: string
    content: string
    domain: string
    /** 调用方（当前会话）的模型路由；蒸馏留空时用它，做到"用你正在用的模型" */
    route?: { provider: string; model: string }
  }) => void
  /** 取消信号（来自 exec.signal） */
  signal?: AbortSignal
  /** F2 注入源（来自 identity.userId） */
  userId: string
  /** 个人索引前缀；索引名在这里拼（`personalIndex` 由前缀 + userId 派生，不给调用点拼错的机会） */
  personalPrefix: string
  defaultDomain: string
  /** 去重检索用只读身份；`get` 缺失时不建边（老调用点与测试不受影响） */
  reader: Pick<EsClient, 'search'> & Partial<Pick<EsClient, 'get'>>
  /** 写入用 writer 身份；`update` 缺失时不建边（老调用点与测试不受影响） */
  writer: Pick<EsClient, 'index'> & Partial<Pick<EsClient, 'update'>>
  /**
   * 阶段 5.2 建边配置。缺省 = 不建边。
   * 建边是 best-effort：失败只记日志，绝不影响「已保存」的结论。
   */
  edges?: EdgeWriteConfig
  /**
   * 阶段 9：近似去重 advisory。与建边**共用同一次 kNN 查询**，不额外加 RTT。
   * 命中只回 `similar_to` 提示（不阻塞写入）——同义改写是值钱的，不能一刀切判重。
   */
  similar?: SimilarConfig
  /**
   * 阶段 9：本会话最近的检索命中（用于识别「把刚搜到的原文又写回来」）。
   * 传函数而不是数组：每次保存都取最新的；缺省 = 不做该判据。
   */
  recentRecalls?: () => readonly RecallRecord[]
  /** 阶段 9：准入屏障开关；缺省 = 开。关掉只影响 write 侧判定，不影响已有数据 */
  admission?: { enabled: boolean }
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
  const importance = input.importance ?? 'normal'
  if (!IMPORTANCE_VALUES.includes(importance)) {
    throw new Error(`memory_save: 未知 importance「${String(importance)}」`)
  }

  // 阶段 9：来源戳。脏值一律拒绝，而不是静默写成缺省——
  // 静默回退会让「巡检入库没标 ingest」这种问题在审计时无从发现。
  const origin = input.origin ?? DEFAULT_ORIGIN
  if (!ORIGIN_VALUES.includes(origin)) {
    throw new Error(`memory_save: 未知 origin「${String(origin)}」（只支持 ${ORIGIN_VALUES.join(' / ')}）`)
  }

  let expiresAt: string | undefined
  if (input.ttl_days !== undefined) {
    const days = input.ttl_days
    if (!Number.isInteger(days) || days < 1 || days > MAX_TTL_DAYS) {
      throw new Error(`memory_save: ttl_days 必须是 1~${MAX_TTL_DAYS} 的整数（收到 ${String(days)}）`)
    }
    expiresAt = isIsoDate(new Date(options.now.getTime() + days * 86_400_000))
  }

  let valence: number | undefined
  if (input.valence !== undefined) {
    if (typeof input.valence !== 'number' || !Number.isFinite(input.valence) || input.valence < -1 || input.valence > 1) {
      throw new Error(`memory_save: valence 必须是 -1~1 的数字（收到 ${String(input.valence)}）`)
    }
    valence = Math.round(input.valence * 10_000) / 10_000
  }
  let arousal: number | undefined
  if (input.arousal !== undefined) {
    if (typeof input.arousal !== 'number' || !Number.isFinite(input.arousal) || input.arousal < 0 || input.arousal > 1) {
      throw new Error(`memory_save: arousal 必须是 0~1 的数字（收到 ${String(input.arousal)}）`)
    }
    arousal = Math.round(input.arousal * 10_000) / 10_000
  }

  const timestamp = isIsoDate(options.now)
  const doc: Record<string, unknown> = {
    memory_id: options.memoryId,
    user_id: userId,
    // 存原文（返回给模型看的是原文），哈希用归一化后的正文
    content: raw,
    // 同一份正文的 standard 分词副本：只用于标识符精确匹配（见 es/dsl.ts 的 IDENTIFIER_FIELD）
    content_exact: raw,
    memory_type: memoryType,
    importance,
    domain: input.domain?.trim() || deps.defaultDomain,
    privacy,
    // 阶段 9：谁把这条写进来的。审计与「巡检入库」追溯都靠它。
    origin,
    promote_state: 'none',
    // 蒸馏状态：入库立刻可见（pending），后台子代理处理后改成 done。
    // 由插件自己写，不依赖 LLM —— 入库不能被模型可用性卡住。
    distill_state: 'pending',
    status: 'active',
    // 阶段 5：联结与激活。写入时给初值，让字段语义明确（老文档缺失按同值处理）：
    // related 由建边步骤补，activation 由命中回写（5.4）提升。
    related: [],
    activation: 0,
    content_sha256: sha256Hex(normalized),
    created_at: timestamp,
    updated_at: timestamp,
  }
  if (expiresAt !== undefined) doc.expires_at = expiresAt
  // 阶段 6.1：只给不给就缺省——缺失表示「这条没标情绪」，不是中性
  if (valence !== undefined) doc.valence = valence
  if (arousal !== undefined) doc.arousal = arousal
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
 * 写入后的邻域探测：一次 kNN 同时服务两件事（阶段 9 起）。
 *
 *  · `similar`：近似去重 advisory——库里有内容相近的条目时回 `similar_to`，**只提示不阻塞**；
 *  · `linked` ：阶段 5.2 的建边（区间过滤去噪声、避开判重带），写回 `related`。
 *
 * 合并成一次查询的理由：两者要的候选是同一批（新条目的最近邻），
 * 分开查会白多一次 ES RTT，而 save 处在最热的路径上。
 * 任何一步失败都只记日志：邻域是检索的增强，**不能把「已保存」变成失败**。
 */
interface NeighborProbe {
  similar: string[]
  linked: number
}

async function probeNeighbors(
  deps: SaveDeps,
  index: string,
  memoryId: string,
  embedding: readonly number[],
  log: (event: Record<string, unknown>) => void,
): Promise<NeighborProbe> {
  const edgeCfg = deps.edges
  const similarCfg = deps.similar
  const wantEdges = edgeCfg !== undefined && edgeCfg.enabled
  const wantSimilar = similarCfg !== undefined && similarCfg.enabled
  if (!wantEdges && !wantSimilar) return { similar: [], linked: 0 }

  const dims = similarCfg?.dims ?? edgeCfg?.dims
  if (dims === undefined) return { similar: [], linked: 0 }

  const update = deps.writer.update
  const get = deps.reader.get
  // 建边需要读回再合并；两个能力缺一个就只做 advisory
  const canLink = wantEdges && update !== undefined && get !== undefined

  try {
    // 多取 3 倍候选：topK 条边要过区间过滤，噪声占比高时名额会被吃掉
    const topK = edgeCfg?.enabled === true ? Math.max(edgeCfg.topK * 3, edgeCfg.topK) : 10
    const found = await deps.reader.search(
      index,
      knnBody(embedding, dims, { status: 'active' }, topK),
      { signal: deps.signal },
    )
    const scored = found.hits.map((hit) => ({
      id: typeof hit.source.memory_id === 'string' ? hit.source.memory_id : hit.id,
      score: hit.score,
    }))

    const similar =
      wantSimilar && similarCfg !== undefined
        ? scored.filter((item) => item.id !== memoryId && item.score >= similarCfg.score).map((item) => item.id)
        : []

    let linked = 0
    if (canLink && edgeCfg !== undefined && update !== undefined && get !== undefined) {
      const picked = pickNeighbors(scored, {
        excludeId: memoryId,
        minScore: edgeCfg.minScore,
        maxScore: edgeCfg.maxScore,
        topK: edgeCfg.topK,
      })
      if (picked.length > 0) {
        // 读回再合并：幂等，将来重跑建边不会把已有边冲掉
        const current = await get(index, memoryId, { signal: deps.signal })
        const next = mergeEdges(readEdges(current.source.related), picked, edgeCfg.topK)
        await update(index, memoryId, { related: next }, { refresh: 'wait_for', signal: deps.signal })
        linked = next.length
        log({ tool: 'save', user: deps.userId, event: 'edges_linked', count: next.length, added: picked.length })
      }
    }

    if (similar.length > 0) {
      log({ tool: 'save', user: deps.userId, event: 'similar_found', count: similar.length })
    }
    return { similar, linked }
  } catch (err) {
    log({ tool: 'save', user: deps.userId, event: 'edges_failed', error: String(err).slice(0, 200) })
    return { similar: [], linked: 0 }
  }
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
      quarantined: false,
      text: `已存在相同内容（memory_id=${existingId}），未重复写入`,
    }
  }

  let embedding: number[] | null = null
  let degraded = false
  let embedFailure: string | undefined

  // 阶段 9：准入判定放在 embedding **之前**——隔离条目不该白花一次向量调用
  // （它不进检索，向量只会在人工恢复后才有意义；恢复时补写即可）。
  const admissionEnabled = deps.admission?.enabled !== false
  const admission: AdmissionVerdict = admissionEnabled
    ? checkAdmission(normalizeContent(input.content), { recent: deps.recentRecalls?.() ?? [] })
    : { allow: true }
  if (!admission.allow) {
    const quarantined = buildMemoryDoc(input, deps, {
      now,
      memoryId: probe.doc.memory_id as string,
      embedding: null,
    })
    assertDocOwner(quarantined.doc, deps.userId)
    // 隔离不是丢弃：文档照写（面板审得到、可以恢复），只是不进检索、不建边、不蒸馏。
    quarantined.doc.status = 'quarantine'
    quarantined.doc.distill_state = 'skipped'
    if (admission.reason !== undefined) quarantined.doc.quarantine_reason = admission.reason

    try {
      await deps.writer.index(quarantined.index, quarantined.doc, {
        id: String(quarantined.doc.memory_id),
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
      quarantined: true,
      category: admission.category ?? 'unknown',
    })
    return {
      memory_id: String(quarantined.doc.memory_id),
      deduped: false,
      degraded: false,
      quarantined: true,
      reason: admission.reason,
      text: `已隔离待审（${admission.reason ?? '命中准入规则'}），没有进入检索；可在面板「记忆库」里查看或恢复`,
    }
  }

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

  // 阶段 5.2 建边 + 阶段 9 近似去重（共用一次 kNN；异常已在内部吞掉并记日志）
  let similarTo: string[] = []
  if (embedding !== null && embedding.length > 0) {
    const probeResult = await probeNeighbors(deps, index, String(built.doc.memory_id), embedding, log)
    similarTo = probeResult.similar
  }

  log({
    tool: 'save',
    user: deps.userId,
    ms: Date.now() - startedAt,
    deduped: false,
    degraded,
    origin: String(built.doc.origin),
    ...(embedFailure === undefined ? {} : { embed_failure: embedFailure }),
    ...(similarTo.length === 0 ? {} : { similar: similarTo.length }),
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

  const baseText = degraded ? '已保存（向量服务不可用，仅关键词可检索）' : '已保存'
  const similarText =
    similarTo.length === 0
      ? ''
      : `；库里有 ${similarTo.length} 条内容相近（${similarTo.slice(0, 3).join(' / ')}），若是同一条请用 memory_update_status 标记取代`

  return {
    memory_id: String(built.doc.memory_id),
    deduped: false,
    degraded,
    quarantined: false,
    ...(similarTo.length === 0 ? {} : { similar_to: similarTo }),
    text: `${baseText}${similarText}`,
  }
}

const DESCRIPTION = [
  '记住一条事实，存进个人记忆库，跨会话可查。',
  '时机：用户明确要求记住；做了非显然的决定；踩到可复现的坑；约定、口径或路径变了。',
  '不要存：临时进度、会话摘要、能从代码或文档直接读到的内容、凭证与个人隐私。',
  '凭据（口令、令牌、私钥、带密码的连接串）不会入库：命中会被隔离待审（quarantined=true），不要换个说法重试。',
  '刚用 memory_search 查到的原文不要再抄回来（没有新增信息的搬运同样会被隔离）；要记的是从它得出的结论与增量。',
  '一次一条——content 写一句能独立成立的事实，不要贴整段对话。',
  '相同内容（忽略空白与全角/半角差异）会命中去重，返回 deduped=true，不会产生第二份；内容相近时会回 similar_to 提示。',
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
        description:
          '记忆类型，缺省 fact。preference=偏好，decision=决定，task_progress=进度，context=背景，identity=稳定自述（由提炼任务产出、审核后写入，不要随手用）。',
      },
      importance: {
        type: 'string',
        enum: [...IMPORTANCE_VALUES],
        description:
          '重要度，缺省 normal。critical 只给「不看就会做错」的规则，别滥用；它只做约 ±10% 的排序微调，不会主导检索。',
      },
      domain: {
        type: 'string',
        description: `业务域短标签（如 lottery-cloud、backup-server），缺省取配置 defaults.domain。`,
      },
      valence: {
        type: 'number',
        description:
          '-1（负面）~1（正面）的情感色彩，缺省不标。只在「这件事当时的情绪」本身有意义时才给，不要给每条都标。',
      },
      arousal: {
        type: 'number',
        description: '情绪强度 0~1，缺省不标；配合 valence 用。',
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
          quarantined: { type: 'boolean', required: true },
          reason: { type: 'string' },
          similar_to: { type: 'array', items: { type: 'string' } },
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
      // 会话模型路由：蒸馏配置留空时用它（做到"默认用当前会话模型"）。
      // exec.agent.options 是本次调用的 agent 路由；嵌套/子代理调用也各自有值。
      const agentOptions = (exec as { agent?: { options?: { provider?: string; model?: string } } })?.agent?.options
      const route =
        typeof agentOptions?.provider === 'string' &&
        agentOptions.provider !== '' &&
        typeof agentOptions?.model === 'string' &&
        agentOptions.model !== ''
          ? { provider: agentOptions.provider, model: agentOptions.model }
          : undefined
      const onSaved = deps.onSaved
      return await saveMemory(
        {
          ...deps,
          signal: exec.signal,
          // 把路由绑进钩子，而不是让钩子去猜
          onSaved:
            onSaved === undefined
              ? undefined
              : (info) => {
                  onSaved(route === undefined ? info : { ...info, route })
                },
        },
        args,
      )
    },
  })
}
