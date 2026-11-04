/**
 * `memory_save` 之后的后台蒸馏（插件层，2026-10-26 按用户要求加）。
 *
 * 为什么要蒸馏：
 *   入库存的是**原文**（口语、重复、上下文夹带），直接拿去做向量检索，命中率靠运气。
 *   蒸馏的目标不是"变短"，而是"变成一段自解释、关键词齐全、可独立阅读的条目"——
 *   数字、路径、版本号、错误码必须保留，否则下次检索到了也用不上。
 *
 * 两个硬约束：
 *   1. **不阻塞保存**：`memory_save` 立刻返回，本模块在后台跑，失败也不影响"已保存"；
 *   2. **不丢原文可追溯**：写入蒸馏结果时记 `distill_source_chars`，原始正文只要还在
 *      这条文档的历史里就能查；写入失败就把 `distill_state` 留在 `pending` 等下一轮。
 *
 * 模型走宿主服务 `ctx.llm`（就是驱动 agent 的那个），不额外配 key；
 * 拿不到 llm 服务或调用失败时**降级为不蒸馏**，绝不报错给用户。
 *
 * @module dsh-memory-es/memory/distillRunner
 */

import { distillMemory } from './distill.ts'
import { personalIndexFor } from './common.ts'
import type { MemoryStoreDeps } from './common.ts'
import { EsError } from '../es/http.ts'
import type { EsClient } from '../es/http.ts'

export interface DistillRunnerDeps extends MemoryStoreDeps {
  /** 宿主模型服务（可能不存在：可选注入） */
  llm?: {
    listModels?: (provider?: string) => unknown[]
    prepareCall?: (config: Record<string, unknown>, signal?: AbortSignal, configure?: unknown) => Promise<{
      config: Record<string, unknown>
      stream: (options: Record<string, unknown>) => AsyncIterable<unknown>
    }>
  } | null
  embed?: { embed(text: string): Promise<number[]> } | null
  provider?: string
  model?: string
  timeoutMs: number
  log?: (event: Record<string, unknown>) => void
}

/** 蒸馏的系统提示词：强调"信息优先"，避免模型写成空泛摘要 */
export const DISTILL_SYSTEM = [
  '你是记忆库的整理器。把用户给的一条记忆改写成更利于日后检索的条目。',
  '要求：',
  '1) 保留全部事实细节：数字、版本号、路径、命令、错误码、时间、主机名，一个都不能丢；',
  '2) 去掉口语、重复、称呼与寒暄，把"我/你/刚才"等指代改成明确的实体；',
  '3) 补出原文隐含的关键词（同义词、组件名、缩写），让别的说法也能搜到；',
  '4) 不要推断原文没有的信息，不要编造结论；',
  '5) 输出严格 JSON，不要代码块围栏，字段：content（改写后的正文）、summary（一句话）、',
  '   keywords（字符串数组，3-8 个）、topic_key（短横线小写主题）。',
].join('\n')

/** 构造用户消息（纯函数，便于测试） */
export function buildDistillPrompt(raw: string, domain: string): string {
  return [`领域：${domain}`, '原始记忆：', raw].join('\n')
}

export interface ParsedDistill {
  content: string
  summary?: string
  keywords?: string[]
  topicKey?: string
}

/**
 * 解析模型输出（纯函数）。模型经常加 ```json 围栏或前后废话，这里做宽容解析；
 * 解析不出 content 就返回 null（调用方据此保持 pending）。
 */
export function parseDistillOutput(text: string): ParsedDistill | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence ? fence[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (content === '') return null
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  const keywords = Array.isArray(record.keywords)
    ? record.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter((k) => k !== '')
    : []
  const topicKey = typeof record.topic_key === 'string' ? record.topic_key.trim() : ''
  return {
    content,
    ...(summary === '' ? {} : { summary }),
    ...(keywords.length === 0 ? {} : { keywords }),
    ...(topicKey === '' ? {} : { topicKey }),
  }
}

/**
 * 选模型路由，优先级：
 *   1. 配置里写死的 provider + model（最明确）；
 *   2. **调用方会话的模型**（memory_save 时带进来的 route）——"默认用你正在用的模型"；
 *   3. 宿主模型列表的第一个（兜底，可能和你会话用的不是同一个，所以只作最后手段）。
 */
export async function pickRoute(
  llm: NonNullable<DistillRunnerDeps['llm']>,
  configProvider?: string,
  configModel?: string,
  sessionRoute?: { provider?: string; model?: string },
): Promise<{ provider: string; model: string; source: 'config' | 'session' | 'first' } | null> {
  if (configProvider !== undefined && configProvider !== '' && configModel !== undefined && configModel !== '') {
    return { provider: configProvider, model: configModel, source: 'config' }
  }
  if (
    sessionRoute !== undefined &&
    typeof sessionRoute.provider === 'string' &&
    sessionRoute.provider !== '' &&
    typeof sessionRoute.model === 'string' &&
    sessionRoute.model !== ''
  ) {
    return { provider: sessionRoute.provider, model: sessionRoute.model, source: 'session' }
  }
  if (typeof llm.listModels !== 'function') return null
  // ⚠️ 宿主签名是 `listModels(provider): Promise<LlmModelInfo[]>`，必须 await；
  // 不 await 拿到的是 Promise 对象，`for...of` 会抛 "models is not iterable"。
  let models: unknown[] = []
  try {
    const raw: unknown = await llm.listModels(configProvider)
    if (Array.isArray(raw)) {
      models = raw
    } else if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { models?: unknown }).models)) {
      // 防御：万一宿主改成 { models: [...] } 的包裹形态
      models = (raw as { models: unknown[] }).models
    }
  } catch {
    return null
  }
  for (const entry of models) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const p = record.provider ?? record.providerId
    const m = record.model ?? record.id ?? record.modelId
    if (typeof p === 'string' && typeof m === 'string' && p !== '' && m !== '') {
      return { provider: p, model: m, source: 'first' }
    }
  }
  return null
}

/** 把模型输出的一段流拼成文本（只关心 text-delta） */
export async function collectStream(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    const record = chunk as Record<string, unknown>
    if (record.type === 'text-delta' && typeof record.text === 'string') text += record.text
  }
  return text
}

export interface DistillJobResult {
  ok: boolean
  reason?: string
  changed?: boolean
  /**
   * 失败是否由这条内容本身导致（模型输出不可解析、改写结果命中准入、超长）。
   * true → 重试大概率还是失败，清扫会计数、到上限标 failed；
   * false → 环境问题（LLM 超时/网络/服务缺失），清扫不计数、留 pending 等下轮。
   * 区分的意义：2026-11-04 巡检发现的积压里若混入环境性失败，
   * 不分类就会像「一次 LLM 停机把整批条目判死」这样误伤。
   */
  content_fault?: boolean
}

/**
 * 跑一次蒸馏。**永不抛**：任何失败都返回 {ok:false, reason}，文档留在 pending。
 * 由 `memory_save` 的 onSaved 钩子 fire-and-forget 调用。
 */
export async function runDistillJob(
  deps: DistillRunnerDeps,
  job: {
    memoryId: string
    content: string
    domain: string
    route?: { provider: string; model: string }
  },
): Promise<DistillJobResult> {
  const log = deps.log ?? (() => {})
  const startedAt = Date.now()
  const llm = deps.llm
  if (!llm || typeof llm.prepareCall !== 'function') {
    log({ tool: 'distill', memory_id: job.memoryId, skipped: 'no_llm_service' })
    return { ok: false, reason: 'no_llm_service' }
  }
  const route = await pickRoute(llm, deps.provider, deps.model, job.route)
  if (!route) {
    log({ tool: 'distill', memory_id: job.memoryId, skipped: 'no_model' })
    return { ok: false, reason: 'no_model' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs)
  try {
    const call = await llm.prepareCall({ ...route, maxTokens: 1200 }, controller.signal)
    const stream = call.stream({
      ...call.config,
      system: DISTILL_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildDistillPrompt(job.content, job.domain) }] }],
      purpose: 'memory-distill',
      signal: controller.signal,
    })
    const text = await collectStream(stream)
    const parsed = parseDistillOutput(text)
    if (parsed === null) {
      log({ tool: 'distill', memory_id: job.memoryId, skipped: 'unparsable', chars: text.length })
      // 模型对这条内容连续产不出合法 JSON → 内容问题，重试大概率还是失败
      return { ok: false, reason: 'unparsable', content_fault: true }
    }
    try {
      const result = await distillMemory(
        { ...deps, embed: deps.embed ?? null },
        {
          memory_id: job.memoryId,
          content: parsed.content,
          summary: parsed.summary,
          keywords: parsed.keywords,
          topic_key: parsed.topicKey,
        },
      )
      log({
        tool: 'distill',
        memory_id: job.memoryId,
        ok: true,
        ms: Date.now() - startedAt,
        model: `${route.provider}/${route.model}`,
        route_source: route.source,
        changed: result.changed,
      })
      return { ok: true, changed: result.changed }
    } catch (err) {
      // distillMemory 自己抛的（准入复检、超长、找不到）是内容问题；
      // EsError（写库失败）是环境问题——别让 ES 抖动吃掉重试预算
      log({ tool: 'distill', memory_id: job.memoryId, ok: false, error: String(err).slice(0, 300) })
      return { ok: false, reason: String(err).slice(0, 200), content_fault: !(err instanceof EsError) }
    }
  } catch (err) {
    // LLM 调用失败（超时/网络/服务缺失）→ 环境问题，不计重试
    log({ tool: 'distill', memory_id: job.memoryId, ok: false, error: String(err).slice(0, 300) })
    return { ok: false, reason: String(err).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

export interface DistillSweepDeps extends DistillRunnerDeps {
  /** 清扫要按条件查 pending 队列，所以 reader 必须带 search（单条蒸馏只要 get） */
  reader: Pick<EsClient, 'get' | 'search'>
  /**
   * 进程内的失败计数：跨轮累计、成功即清、重启清零。
   * 用进程内存而不是新 ES 字段——加字段要先迁移全部 personal_memory_*（strict 映射会 400），
   * 而重启清零的代价只是「重试预算重新算」，可接受。
   */
  attempts: Map<string, number>
}

export interface DistillSweepOptions {
  /** 单轮最多处理几条（LLM 串行，15~40s/条，默认 5） */
  batch?: number
  /** 多新的条目不碰：给 onSaved 的即时蒸馏留完成窗口，不双跑（默认 5 分钟） */
  minAgeMinutes?: number
  /** 同一条**内容问题**失败几次后判 failed（默认 3） */
  maxAttempts?: number
}

export interface DistillSweepResult {
  /** 查到的 pending 条数 */
  scanned: number
  /** 真正烧模型蒸馏成功的 */
  distilled: number
  /** 已带 summary（巡检管线写入时蒸馏过）→ 直接标 done，没烧模型 */
  markedDone: number
  /** 非 active（归档/候选）→ 标 skipped，不值得花模型 */
  markedSkipped: number
  /** 内容问题重试用尽 → 标 failed（终态） */
  markedFailed: number
  /** 环境问题（模型不可用/超时）→ 留 pending 下轮再试 */
  envDeferred: number
  /** 整轮提前退出的原因（no_llm_service / no_model）；正常跑完为空 */
  reason?: string
}

const SWEEP_DEFAULTS = { batch: 5, minAgeMinutes: 5, maxAttempts: 3 }

/**
 * 兜底清扫 `distill_state=pending` 的条目（2026-11-04 巡检修复）。
 *
 * 为什么需要：`memory_save` 的 onSaved 只覆盖「工具保存」这一条路——批量入库
 * （.chat-inspect/ingest.ts 直调 saveMemory、不带钩子）与当时蒸馏失败的条目
 * 会永远停在 pending（实测 6 个用户索引积压 158 条，无任何消费者）。
 *
 * 四条边界（都有单测钉住）：
 *   1. 只碰创建 ≥minAge 的条目：给 onSaved 的即时蒸馏留完成窗口，不双跑；
 *   2. 失败分两类——内容问题计次、到上限标 failed 终态；环境问题不计次、
 *      留 pending 等模型恢复（否则一次 LLM 停机会把整批条目误判死）；
 *   3. 已带 summary 的（巡检管线的蒸馏稿）直接标 done，不重复烧模型；
 *   4. **模型闸不是整轮闸**：没模型的实例照样能执行第 3 条与非 active → skipped，
 *      只有真要蒸馏时才解析路由。8/10 个容器 LLM 不可用（实测从未蒸馏成功），
 *      把环境闸放最前会让它们的积压永远清不掉。
 *
 * 与 onSaved 的竞态之外还有一个已知无害重叠：114 本地与 125 的 dsh-xqh 共用
 * 同一个 personal_memory_xqh，两边的清扫可能同轮捞到同一条 → 双份 LLM 调用、
 * 双方都写 done（幂等，后写覆盖先写）。不做分布式锁，量小可接受。
 */
export async function runDistillSweep(
  deps: DistillSweepDeps,
  options: DistillSweepOptions = {},
): Promise<DistillSweepResult> {
  const batch = options.batch ?? SWEEP_DEFAULTS.batch
  const minAgeMs = (options.minAgeMinutes ?? SWEEP_DEFAULTS.minAgeMinutes) * 60_000
  const maxAttempts = options.maxAttempts ?? SWEEP_DEFAULTS.maxAttempts
  const log = deps.log ?? (() => {})
  const result: DistillSweepResult = {
    scanned: 0,
    distilled: 0,
    markedDone: 0,
    markedSkipped: 0,
    markedFailed: 0,
    envDeferred: 0,
  }

  // 模型路由**惰性**解析：只有真要蒸馏时才需要它。
  //
  // 不能把「没有模型」当成整轮退出的理由——2026-11-04 部署后实测：10 个容器里
  // 只有 2 个曾经蒸馏成功过（有 distilled_at），其余 8 个的 LLM 根本不可用；
  // 而它们的 pending 队列里绝大多数条目**已经带 summary**（巡检管线蒸馏过），
  // 标 done 不需要模型，非 active 的标 skipped 也不需要。
  // 把环境闸放最前会让这 100+ 条永远清不掉——那正是这次要修的「积压无人消费」。
  type RouteState = {
    route: { provider: string; model: string; source: 'config' | 'session' | 'first' } | null
    reason?: 'no_llm_service' | 'no_model'
  }
  let routeState: RouteState | undefined
  const ensureRoute = async (): Promise<RouteState> => {
    if (routeState !== undefined) return routeState
    const llm = deps.llm
    if (!llm || typeof llm.prepareCall !== 'function') {
      routeState = { route: null, reason: 'no_llm_service' }
      return routeState
    }
    const picked = await pickRoute(llm, deps.provider, deps.model)
    // pickRoute 的返回带 source（config/session/first），这里原样透传给 runDistillJob
    routeState = picked === null ? { route: null, reason: 'no_model' } : { route: picked }
    return routeState
  }

  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const cutoff = new Date(Date.now() - minAgeMs).toISOString()
  const res = await deps.reader.search(index, {
    size: batch,
    sort: [{ created_at: 'asc' }],
    _source: ['memory_id', 'content', 'domain', 'status', 'summary'],
    query: {
      bool: {
        filter: [
          { term: { distill_state: 'pending' } },
          { range: { created_at: { lte: cutoff } } },
        ],
      },
    },
  })
  result.scanned = res.hits.length

  for (const hit of res.hits) {
    const source = hit.source
    const memoryId = String(source.memory_id ?? hit.id)
    const status = String(source.status ?? 'active')

    // 非正式记忆（归档/过期/候选）：不进检索也就不值得花模型，标 skipped 收口——
    // 否则它们会永远挂在 pending 上，让巡检一直报「积压」
    if (status !== 'active') {
      try {
        await deps.writer.update(index, memoryId, { distill_state: 'skipped' }, { refresh: 'wait_for' })
        deps.attempts.delete(memoryId)
        result.markedSkipped += 1
        log({ tool: 'distill-sweep', memory_id: memoryId, marked: 'skipped', status })
      } catch (err) {
        log({ tool: 'distill-sweep', memory_id: memoryId, mark_failed: 'skipped', error: String(err).slice(0, 200) })
      }
      continue
    }

    // 已带 summary = 巡检管线入库时就蒸馏过（saveMemory 不写 summary，只有蒸馏/迁移写）
    // → 直接标 done，把这批存量从队列里摘掉而不重复烧模型
    if (typeof source.summary === 'string' && source.summary.trim() !== '') {
      try {
        await deps.writer.update(index, memoryId, { distill_state: 'done' }, { refresh: 'wait_for' })
        deps.attempts.delete(memoryId)
        result.markedDone += 1
        log({ tool: 'distill-sweep', memory_id: memoryId, marked: 'done', via: 'existing_summary' })
      } catch (err) {
        log({ tool: 'distill-sweep', memory_id: memoryId, mark_failed: 'done', error: String(err).slice(0, 200) })
      }
      continue
    }

    const used = deps.attempts.get(memoryId) ?? 0
    if (used >= maxAttempts) {
      // 上一轮到顶但标 failed 的写入没成功（ES 抖动）→ 这轮补写；写不动就留着下轮再补
      try {
        await deps.writer.update(index, memoryId, { distill_state: 'failed' }, { refresh: 'wait_for' })
        deps.attempts.delete(memoryId)
        result.markedFailed += 1
        log({ tool: 'distill-sweep', memory_id: memoryId, marked: 'failed', attempts: used })
      } catch (err) {
        log({ tool: 'distill-sweep', memory_id: memoryId, mark_failed: 'failed', error: String(err).slice(0, 200) })
      }
      continue
    }

    // 到这里才真的需要模型：先解一次路由（同轮内复用，失败不重复试）
    const rs = await ensureRoute()
    if (rs.route === null) {
      // 环境问题：不计次、不判死，留 pending 等下轮（模型恢复后自动续上）
      result.envDeferred += 1
      result.reason = rs.reason
      log({ tool: 'distill-sweep', memory_id: memoryId, env_deferred: true, reason: rs.reason })
      continue
    }

    const outcome = await runDistillJob(deps, {
      memoryId,
      content: String(source.content ?? ''),
      domain: String(source.domain ?? 'general'),
      route: rs.route,
    })
    if (outcome.ok) {
      deps.attempts.delete(memoryId)
      result.distilled += 1
      continue
    }

    if (!outcome.content_fault) {
      // 环境问题：不计次、不判死，留 pending 等模型恢复
      result.envDeferred += 1
      result.reason = result.reason ?? outcome.reason
      log({ tool: 'distill-sweep', memory_id: memoryId, env_deferred: true, reason: outcome.reason })
      // 注意：**不整轮退出**——同一批里后面的条目可能带 summary（标 done 不需要模型），
      // 提前 return 会让它们也一起留在 pending（2026-11-04 部署后实测的坑）
      continue
    }

    const next = used + 1
    deps.attempts.set(memoryId, next)
    if (next >= maxAttempts) {
      try {
        await deps.writer.update(index, memoryId, { distill_state: 'failed' }, { refresh: 'wait_for' })
        deps.attempts.delete(memoryId)
        result.markedFailed += 1
        log({ tool: 'distill-sweep', memory_id: memoryId, marked: 'failed', attempts: next, reason: outcome.reason })
      } catch (err) {
        // 标不动就保持 attempts=到顶：下一轮开头会补写
        log({ tool: 'distill-sweep', memory_id: memoryId, mark_failed: 'failed', error: String(err).slice(0, 200) })
      }
    } else {
      log({ tool: 'distill-sweep', memory_id: memoryId, attempt: next, max: maxAttempts, reason: outcome.reason })
    }
  }
  return result
}
