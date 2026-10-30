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
import type { MemoryStoreDeps } from './common.ts'

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
      return { ok: false, reason: 'unparsable' }
    }
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
    log({ tool: 'distill', memory_id: job.memoryId, ok: false, error: String(err).slice(0, 300) })
    return { ok: false, reason: String(err).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}
