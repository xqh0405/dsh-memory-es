/**
 * embedding 客户端：调本机 Ollama 的 `/api/embed`，把文本变成向量。
 *
 * 为什么用 `/api/embed` 而不是设计稿写的 `/api/embeddings`：后者在 Ollama 里已是
 * 遗留接口（单条、字段叫 `embedding`），前者是现行接口（字段 `embeddings`，可批量）。
 * 2026-10-25 实测 0.40.3：两者对 `bge-m3` 都是 1024 维；`/api/embed` 返回的是
 * **已归一化的单位向量**，与索引里 `similarity: cosine` 正好合拍。
 *
 * 降级契约：所有失败一律抛 `EmbeddingError`，由调用方（memory_save）转成
 * `degraded=true` 继续落库——**embedding 不可用不等于记忆不能存**（文档 §6.5）。
 *
 * @module dsh-memory-es/embedding
 */

/** 失败分类：既决定提示语，也决定日志里怎么归因 */
export type EmbeddingErrorKind = 'config' | 'unavailable' | 'timeout' | 'aborted' | 'protocol' | 'dims'

const HINTS: Record<EmbeddingErrorKind, string> = {
  aborted: '调用方已取消（工具超时或用户中断）：本条记忆没有拿到向量，写入会按 degraded 处理',
  config: '检查 embedding.url / embedding.model（模型是否已 pull）',
  unavailable: 'embedding 服务不可达：确认本机 Ollama 在跑；本次写入会降级为纯关键词可检索',
  timeout: 'embedding 超时：本次写入降级为纯关键词可检索',
  protocol: 'embedding 服务返回了非预期响应（可能不是 Ollama）',
  dims: '向量维度与索引 dims 不一致：换 embedding 模型必须重建索引，不能原地改 dims',
}

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind
  readonly hint: string
  /** HTTP 状态码（有的话） */
  readonly status: number | undefined

  constructor(message: string, options: { kind: EmbeddingErrorKind; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EmbeddingError'
    this.kind = options.kind
    this.hint = HINTS[options.kind]
    this.status = options.status
  }
}

export interface EmbedderConfig {
  url: string
  model: string
  dims: number
  /** 单次调用超时；冷启动加载模型实测约 2.2 s，给足余量 */
  timeoutMs?: number
}

export interface Embedder {
  readonly model: string
  readonly dims: number
  /** `call.signal` 取消在途请求（不传即只受自身 timeoutMs 约束） */
  embed(text: string, call?: { signal?: AbortSignal }): Promise<number[]>
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 把 fetch 的异常压成 timeout / unavailable 两类 */
function mapFetchError(err: unknown, what: string): EmbeddingError {
  const name = (err as { name?: unknown })?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new EmbeddingError(`${what} → 超时`, { kind: 'timeout', cause: err })
  }
  const cause = (err as { cause?: { code?: string } })?.cause
  const code = typeof cause?.code === 'string' ? cause.code : ''
  return new EmbeddingError(`${what} → 连接失败${code ? `（${code}）` : ''}`, { kind: 'unavailable', cause: err })
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  let endpoint: string
  try {
    const base = new URL(config.url)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error(`不支持的协议 ${base.protocol}`)
    }
    endpoint = `${base.origin}${base.pathname.replace(/\/$/, '')}/api/embed`
  } catch (err) {
    throw new EmbeddingError(`embedding.url 非法：${config.url}`, { kind: 'config', cause: err })
  }
  if (!config.model) throw new EmbeddingError('embedding.model 为空', { kind: 'config' })
  if (!Number.isInteger(config.dims) || config.dims < 1) {
    throw new EmbeddingError(`embedding.dims 必须是正整数（${String(config.dims)}）`, { kind: 'config' })
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    model: config.model,
    dims: config.dims,

    async embed(text, call: { signal?: AbortSignal } = {}) {
      if (text.trim() === '') throw new EmbeddingError('embed(text): text 不能为空', { kind: 'config' })
      const what = `POST ${endpoint} (${config.model})`
      if (call.signal?.aborted) {
        throw new EmbeddingError(`${what} → 调用方已取消（未发请求）`, { kind: 'aborted' })
      }
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      // 外部取消要能立刻打断在途请求（工具超时/用户中断），而不是等自己的 15 s 超时
      const forwardAbort = (): void => controller.abort()
      call.signal?.addEventListener('abort', forwardAbort, { once: true })
      try {
        let response: Response
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: config.model, input: text }),
            signal: controller.signal,
          })
        } catch (err) {
          // 先分清是谁取消的：外部 signal → aborted；自己的定时器 → timeout
          if (call.signal?.aborted && !timedOut) {
            throw new EmbeddingError(`${what} → 调用方取消`, { kind: 'aborted', cause: err })
          }
          throw mapFetchError(err, what)
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          const kind: EmbeddingErrorKind = response.status === 404 ? 'config' : 'unavailable'
          throw new EmbeddingError(`${what} → HTTP ${response.status} ${detail.slice(0, 200)}`.trim(), {
            kind,
            status: response.status,
          })
        }

        let payload: unknown
        try {
          payload = await response.json()
        } catch (err) {
          throw new EmbeddingError(`${what} → 响应不是 JSON`, { kind: 'protocol', cause: err })
        }
        const embeddings = (payload as { embeddings?: unknown })?.embeddings
        const vector = Array.isArray(embeddings) && Array.isArray(embeddings[0]) ? (embeddings[0] as unknown[]) : null
        if (vector === null) {
          throw new EmbeddingError(`${what} → 响应里没有 embeddings[0]`, { kind: 'protocol' })
        }
        if (vector.length !== config.dims) {
          throw new EmbeddingError(
            `${what} → 向量维度 ${vector.length} ≠ 索引 dims ${config.dims}`,
            { kind: 'dims' },
          )
        }
        for (let i = 0; i < vector.length; i += 1) {
          const value = vector[i]
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new EmbeddingError(`${what} → 第 ${i} 维不是有限数`, { kind: 'protocol' })
          }
        }
        return vector as number[]
      } finally {
        clearTimeout(timer)
        call.signal?.removeEventListener('abort', forwardAbort)
      }
    },
  }
}
