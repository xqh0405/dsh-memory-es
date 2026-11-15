/**
 * 本地网关的 chat 调用（docs/本地模型扩展.md 阶段 D）。
 *
 * 只服务「离线批处理」——蒸馏这类后台任务。**绝不接入 agent 主上下文**：
 * agent 的模型不是本地网关，把本地模型塞进主对话会同时踩上下文与延迟两个坑
 * （文档第五节「明确不做」）。
 *
 * 与 rerank 共用 `localModels` 连接块与凭据读取；同样遵守六条设计原则：
 * `enabled=false` 时不建连、不发请求、不读凭据。
 *
 * @module dsh-memory-es/local-chat
 */

import { endpointsOf, resolveCredential, type LocalModelsConfig } from './local-models.ts'

export interface LocalChatConfig {
  enabled: boolean
  /** 网关上的模型 id/别名（如 qwen3-30b / qwen3-4b） */
  model: string
  /** 读超时（毫秒）；蒸馏是后台任务，可以给得比 rerank 宽松 */
  timeoutMs: number
}

export interface LocalChatInput {
  system: string
  user: string
  maxTokens: number
  signal?: AbortSignal
}

export type LocalChatResult = { text: string; ms: number } | { error: string; ms: number }

export interface LocalChat {
  readonly enabled: boolean
  readonly model: string
  complete: (input: LocalChatInput) => Promise<LocalChatResult>
  stats: () => { calls: number; failures: number }
}

export interface LocalChatDeps {
  /** 覆盖凭据读取（测试用） */
  apiKey?: () => string | null
  log?: (event: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
  now?: () => number
}

/** 从 chat completions 响应里取第一条正文；空串/缺字段都算失败（D2） */
export function parseChatContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 建一个本地 chat 客户端。构造期零副作用（不建连、不读凭据）。
 */
export function createLocalChat(cfg: LocalChatConfig, local: LocalModelsConfig, deps: LocalChatDeps = {}): LocalChat {
  const endpoints = endpointsOf(local.baseUrl)
  const on = cfg.enabled && endpoints !== null
  const log = deps.log ?? (() => {})
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const getKey = (): string | null => (deps.apiKey !== undefined ? deps.apiKey() : resolveCredential(local.apiKeyEnv))
  let calls = 0
  let failures = 0

  return {
    enabled: on,
    model: cfg.model,
    stats: () => ({ calls, failures }),
    async complete(input) {
      if (!on || endpoints === null) return { error: 'disabled', ms: 0 }
      const apiKey = getKey()
      if (local.apiKeyEnv.trim() !== '' && apiKey === null) return { error: 'credential_missing', ms: 0 }

      calls += 1
      const startedAt = now()
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(new Error('caller-aborted'))
      if (input.signal !== undefined) {
        if (input.signal.aborted) return { error: 'timeout', ms: 0 }
        input.signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, cfg.timeoutMs))
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`
        const res = await fetchImpl(endpoints.chat, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cfg.model,
            stream: false,
            temperature: 0,
            max_tokens: input.maxTokens,
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.user },
            ],
            // Qwen3 系默认会先吐思考；网关侧虽已关（--chat-template-kwargs），
            // 这里再显式传一次，免得换模型/换网关时把思考当正文返回。
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: controller.signal,
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
        const parsed = parseChatContent(JSON.parse(text) as unknown)
        if (parsed === null) {
          failures += 1
          log({ event: 'local_chat_empty', model: cfg.model })
          return { error: 'empty_content', ms: now() - startedAt }
        }
        return { text: parsed, ms: now() - startedAt }
      } catch (err) {
        failures += 1
        const outcome = controller.signal.aborted ? 'timeout' : 'http'
        log({ event: 'local_chat_failed', outcome, error: String((err as Error).message ?? err).slice(0, 160) })
        return { error: outcome, ms: now() - startedAt }
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
