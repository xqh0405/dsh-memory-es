/**
 * 本地推理网关（OpenAI 兼容）的最小客户端。
 *
 * 目标与边界见 `docs/本地模型扩展.md`，这里只把**六条设计原则**落成代码：
 *  1. 默认关：`enabled=false` 时 `enabled()` 为 false，调用方直接跳过，**不发任何请求**；
 *  2. 关时零成本：连凭据文件都不读（`createReranker` 期间不碰磁盘）；
 *  3. 失败必回落：所有失败都折成 `scores: null`，绝不抛给检索；
 *  4. 启动不探测：`apply` 期间不建连（本文件没有顶层副作用）；
 *  5. 可观测：JSONL 记账（默认不打印）；
 *  6. 不改默认行为：只做「多一路候选」的重排输入，不碰索引、不换 embedding。
 *
 * 两个刻意的实现选择：
 *  · **单一总超时**（`timeoutMs`，默认 600）。原本设想「连接 ≤200ms / 读 = 配置值」
 *    两段超时，2026-11-13 真机实测推翻了它：llama-server 的 `/rerank` 不是流式，
 *    响应头要等服务端算完才发，「headers 未到」既可能是建连失败也可能是模型在算
 *    （真实记忆 600 字 × 20 条约 250~400ms）——200ms 卡 headers 会把正常请求全误杀。
 *    代价是连不上时最多等 600ms，由熔断兜住。
 *  · **熔断按「连续失败」**：成功一次就清零。网关通常是「关机 / 被大模型挤掉」
 *    这类持续性故障，连续失败 3 次后再重试只是每轮白等。
 *
 * @module dsh-memory-es/local-models
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { dshMemoryDataDir } from './sessions.ts'

/** 共享连接块：rerank / distill / vision 共用一个网关，避免各配一遍 */
export interface LocalModelsConfig {
  /** 例 `http://192.168.50.127:8080/v1`；留空 = 全部能力视为未配置 */
  baseUrl: string
  /**
   * 凭据引用名（DSH credential-ref，如 `LLAMA_SWAP_KEY`）。
   * **不读 OS 环境变量**：DSH 的 `apiKeyEnv` 字段实际语义就是 ref，从
   * `$DSH_HOME/.credentials.yaml` 读。留空 = 网关不鉴权（不发 Authorization 头）。
   */
  apiKeyEnv: string
}

/** 检索重排的配置（默认值在 config.ts，这里只声明形状） */
export interface RerankConfig {
  enabled: boolean
  model: string
  /** 送进重排的候选数；只在 enabled 时用于把候选池扩到这么大 */
  candidates: number
  /** 每条候选送进模型的正文上限（字符）。越长越准但越慢：实测 600 字 × 20 条 ≈ 420ms */
  docChars: number
  /** 读超时（毫秒）；必须远小于 recall 的总预算 */
  timeoutMs: number
  /** 连续失败 N 次 → 本进程内熔断 */
  failureThreshold: number
  /**
   * 名次分的整体权重（默认 1）。
   *
   * 不把 rerank 的 logit 直接混入（尺度不兼容），只用**名次**把参与候选的融合分
   * 重写成 `weight / (rrfK + rank)`——尺度与 RRF 完全相同。
   * 于是相邻档距是相对 1.6% 量级，后验乘子（默认 ±10%）能小幅调整名次但不翻盘。
   * 0 = 只记账、不改排序（评测对照组）。
   */
  scoreWeight: number
  /** JSONL 记账路径；空 = `$DSH_HOME/memory-es/local-models.jsonl` */
  logPath: string
}

/** 一次重排的分类（记账与面板按这个分组） */
export type RerankOutcome = 'ok' | 'disabled' | 'tripped' | 'timeout' | 'http' | 'bad_shape' | 'credential_missing'

export interface RerankAttempt {
  /** 按 documents 下标的分数；`null` = 这次没有可用结果，调用方必须按原序走 */
  scores: number[] | null
  outcome: RerankOutcome
  ms: number
}

export interface RerankerStats {
  calls: number
  failures: number
  tripped: boolean
}

export interface Reranker {
  /** false = 未配置或显式关闭；调用方据此**完全跳过**（连候选扩容都不做） */
  readonly enabled: boolean
  readonly candidates: number
  readonly docChars: number
  readonly scoreWeight: number
  rerank: (query: string, documents: readonly string[], options?: { signal?: AbortSignal }) => Promise<RerankAttempt>
  stats: () => RerankerStats
}

/**
 * 默认总超时（毫秒）。不是「连接超时」——原因见文件头：重排响应头要等服务端算完。
 * 配置里 `retrieval.rerank.timeoutMs` 的默认值与它保持一致。
 */
export const DEFAULT_TIMEOUT_MS = 600

/** 凭据库路径（`$DSH_HOME/.credentials.yaml`）；DSH 默认 `~/.dsh` */
export function credentialsPath(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), '.credentials.yaml')
}

/**
 * 从凭据库读一个 ref 的值。
 *
 * 与 `scripts/backfill-team-summary.ts` 同口径：只读 refs 里那一行，不解析整份 YAML、
 * 不打印值。读不到返回 `null`（调用方按「未配置凭据」处理，不抛）。
 */
export function resolveCredential(ref: string): string | null {
  if (ref.trim() === '') return null
  let text: string
  try {
    text = readFileSync(credentialsPath(), 'utf8')
  } catch {
    return null
  }
  const escaped = ref.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^\\s*${escaped}:\\s*(\\S+)\\s*$`, 'm').exec(text)
  if (m === null) return null
  const value = m[1].replace(/^["']|["']$/g, '')
  return value === '' ? null : value
}

/** 从 baseUrl 派生两个端点：rerank 在根路径，chat 在 /v1 下（llama-swap 的约定） */
export function endpointsOf(baseUrl: string): { rerank: string; chat: string } | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  // baseUrl 既可写 `http://h:8080` 也可写 `http://h:8080/v1`
  const path = url.pathname.replace(/\/v1\/?$/, '')
  const root = `${url.origin}${path === '/' ? '' : path}`
  const v1 = `${root}/v1`
  return { rerank: `${root}/rerank`, chat: `${v1}/chat/completions` }
}

/**
 * 校验 `/rerank` 的返回：必须是「每个文档恰好一条、index 覆盖 0..n-1」。
 *
 * 条数不符按失败处理而不是「能对上几条算几条」——重排的输入错位会静默改变排序，
 * 比降级回原序危险得多（文档 B3：返回条数不符 → fallback）。
 */
export function parseRerankResponse(payload: unknown, expected: number): number[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  // 兼容两种形态：`{results:[…]}` 与 OpenAI 风格的 `{data:{results:[…]}}`
  const root = Array.isArray((payload as { results?: unknown }).results)
    ? payload
    : (payload as { data?: unknown }).data
  if (typeof root !== 'object' || root === null) return null
  const results = (root as { results?: unknown }).results
  if (!Array.isArray(results) || results.length !== expected) return null
  const scores = new Array<number>(expected).fill(Number.NaN)
  for (const item of results) {
    if (typeof item !== 'object' || item === null) return null
    const index = (item as { index?: unknown }).index
    const score = (item as { relevance_score?: unknown }).relevance_score
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) return null
    if (typeof score !== 'number' || !Number.isFinite(score)) return null
    scores[index] = score
  }
  return scores.some((score) => Number.isNaN(score)) ? null : scores
}

/** 记账文件路径：空配置时落到插件私有数据目录 */
export function resolveLocalModelsLogPath(configured: string): string {
  if (configured.trim() !== '') return configured
  return join(dshMemoryDataDir(), 'local-models.jsonl')
}

/**
 * 追加一行 JSONL。
 *
 * 写失败只吞掉、不抛：重排是旁路能力，不能因为磁盘/权限问题影响检索。
 * 但把失败次数传出去，避免「一直没数据还以为是没命中」。
 */
export function createLocalModelWriter<T extends object = Record<string, unknown>>(path: string): {
  write: (record: T) => void
  failures: () => number
} {
  let failed = 0
  let ready = false
  return {
    write(record: T) {
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true })
          ready = true
        }
        appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        failed += 1
      }
    },
    failures: () => failed,
  }
}

export interface RerankerDeps {
  /** 取凭据；默认走 `resolveCredential`。测试可直接注入，避免读真实凭据库 */
  apiKey?: () => string | null
  log?: (event: Record<string, unknown>) => void
  now?: () => number
  /** 注入 fetch（测试用）；默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 覆盖总超时（毫秒）；只在测试里改 */
  timeoutMs?: number
}

/**
 * 建一个重排器。**这里不发请求、不读凭据、不建连**（原则 4）。
 *
 * - `cfg.enabled === false` 或 `baseUrl` 非法 → 返回 `enabled: false` 的桩，
 *   调用方的代码路径直接跳过（原则 1/2）；
 * - 只有真的调 `rerank()` 时才去读凭据（`credential_missing` 只影响单次调用）。
 */
export function createReranker(cfg: RerankConfig, local: LocalModelsConfig, deps: RerankerDeps = {}): Reranker {
  const endpoints = endpointsOf(local.baseUrl)
  const on = cfg.enabled && endpoints !== null
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = Math.max(1, deps.timeoutMs ?? cfg.timeoutMs)
  const threshold = Math.max(1, cfg.failureThreshold)

  let failures = 0
  let tripped = false
  let calls = 0
  let loggedDisabled = false

  const getKey = (): string | null => (deps.apiKey !== undefined ? deps.apiKey() : resolveCredential(local.apiKeyEnv))

  const stub = (outcome: RerankOutcome, ms = 0): RerankAttempt => ({ scores: null, outcome, ms })

  return {
    enabled: on,
    candidates: Math.max(1, cfg.candidates),
    docChars: Math.max(50, cfg.docChars),
    scoreWeight: cfg.scoreWeight,
    stats: () => ({ calls, failures, tripped }),
    async rerank(query, documents, options = {}) {
      if (!on || endpoints === null) {
        // 只记一次：没配的人不该被反复"提醒"
        if (!loggedDisabled) {
          loggedDisabled = true
          log({ event: 'rerank_disabled', reason: cfg.enabled ? 'baseUrl 未配置或非法' : 'enabled=false' })
        }
        return stub('disabled')
      }
      if (tripped) return stub('tripped')
      if (documents.length === 0) return { scores: [], outcome: 'ok', ms: 0 }

      const apiKey = getKey()
      if (local.apiKeyEnv.trim() !== '' && apiKey === null) {
        // 凭据缺失是配置问题（不会自愈），也计入连续失败：否则每轮都白试一次
        failures += 1
        if (failures >= threshold) {
          tripped = true
          log({ event: 'rerank_tripped', reason: 'credential_missing', failures })
        }
        log({ event: 'rerank_credential_missing', ref: local.apiKeyEnv })
        return stub('credential_missing')
      }

      calls += 1
      const startedAt = now()
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(new Error('caller-aborted'))
      if (options.signal !== undefined) {
        if (options.signal.aborted) return stub('timeout', now() - startedAt)
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      // 单一总超时：覆盖「建连 + 服务端计算 + 传输」。非流式重排的响应头
      // 要等服务端算完才发，所以不能拿 headers 到达时间当建连判据（见文件头）。
      const timer: NodeJS.Timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`
        const res = await fetchImpl(endpoints.rerank, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: cfg.model, query, documents: [...documents] }),
          signal: controller.signal,
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // 有些网关把 rerank 放在 OpenAI 风格的 {results:[...]} 里，也有的多包一层 data
        const payload: unknown = JSON.parse(text)
        const scores = parseRerankResponse(payload, documents.length)
        if (scores === null) {
          failures += 1
          if (failures >= threshold) {
            tripped = true
            log({ event: 'rerank_tripped', reason: 'bad_shape', failures })
          }
          return { ...stub('bad_shape', now() - startedAt) }
        }
        failures = 0
        return { scores, outcome: 'ok', ms: now() - startedAt }
      } catch (err) {
        failures += 1
        const name = (err as { name?: string }).name ?? ''
        // abort(reason) 在 Node 里抛的是 reason 本身（name 可能是 Error），
        // 所以判据用 **controller 的状态**而不是抛出的错误类型。
        // 两种 abort 的语义都是「这次不重排」，统一记 timeout（读超时 / 调用方取消）。
        const outcome: RerankOutcome = controller.signal.aborted || name === 'AbortError' ? 'timeout' : 'http'
        if (failures >= threshold) {
          tripped = true
          log({ event: 'rerank_tripped', reason: outcome, failures })
        }
        log({ event: 'rerank_failed', outcome, error: String((err as Error).message ?? err).slice(0, 160) })
        return stub(outcome, now() - startedAt)
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
