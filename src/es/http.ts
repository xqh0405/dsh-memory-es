/**
 * ES 请求封装：TLS CA 校验 + Basic Auth + 超时 + 错误映射 + 有限重试。
 *
 * 为什么手写而不用 `@elastic/elasticsearch`：`dsh plugin add file:` 是把产物**复制**进
 * profile，第三方依赖不会跟着进去，线上会直接 `ERR_MODULE_NOT_FOUND`（文档 §15.1）。
 * 这里只覆盖插件真正用到的五个端点：`index` / `get` / `update` / `search` / `info`。
 *
 * 三条不变式（改代码时别破坏）：
 *  1. **永远不设 `rejectUnauthorized: false`**：自签 CA 通过 `caCertPath` 传进来校验。
 *  2. 401 / 403 / 404 / 5xx / 超时**一律不重试**；只有 409 与 429 各重试一次（文档 §15.5）。
 *  3. 错误信息里**不出现密码与 `Authorization` 头**（日志会和错误一起被打印出去）。
 *
 * 实测提醒（2026-10-25）：读者身份 `mem-reader-*` 没有 cluster 权限，连 `GET /` 都是 403。
 * 所以 `info()` / `health()` 是排障用的，**不能**作为插件启动的存活探针（用 search 探）。
 *
 * @module dsh-memory-es/es/http
 */

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Hit } from '../fragment.ts'

/** 错误分类：既决定要不要重试，也决定给模型看哪句提示 */
export type EsErrorKind =
  | 'config'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'bad_request'
  | 'server'
  | 'timeout'
  | 'network'
  | 'tls'
  | 'protocol'

/** 每类错误给模型的提示（文档 §15.5 的“给模型的提示”列） */
const HINTS: Record<EsErrorKind, string> = {
  config: '检查 dsh-memory-es 的配置项（es.url / es.caCertPath / identity.*）',
  auth: '凭证失效：检查 identity.readUsername/readPassword 与 writerUsername/writerPassword，密码建议从环境变量注入',
  permission: '权限不足：个人身份只读，写入必须用 writer 凭证；basic license 下建带 query 的角色也会 403（non-compliant for field and document level security）',
  not_found: '索引或文档不存在；索引缺失时先执行 scripts/init-indices.sh',
  conflict: '并发写冲突：已重试一次仍失败，稍后再试',
  rate_limited: '被 ES 限流：已退避重试一次，稍后再试',
  bad_request: '请求被 ES 拒绝：多半是字段名与 mapping 不符（mapping 是 dynamic:strict，字段写错直接 400）',
  server: 'ES 服务异常：本次记忆操作未生效',
  timeout: 'ES 请求超时：本次记忆操作未生效',
  network: 'ES 不可达：检查部署（scripts/es-up.sh）与 es.url',
  tls: 'TLS 证书校验失败：es.caCertPath 要指向自签 CA 的 PEM，且证书 SAN 必须包含 es.url 里的主机名/IP',
  protocol: 'ES 返回了非预期响应（可能被中间层改写），检查是否误连了别的服务',
}

/** 只有这两类值得再试一次：409 并发冲突、429 限流（退避 200 ms） */
const RETRY_DELAY_MS: Partial<Record<EsErrorKind, number>> = { conflict: 50, rate_limited: 200 }

const DEFAULT_TIMEOUT_MS = 8_000

export interface EsErrorOptions {
  kind: EsErrorKind
  /** HTTP 状态码；连接层失败时没有 */
  status?: number
  /** ES 错误体里的 `error.type`，如 security_exception / index_not_found_exception */
  esType?: string
  /** 覆盖默认提示（少数场景要说得更具体） */
  hint?: string
  /** 已尝试次数（1 表示只发了一次） */
  attempts?: number
  cause?: unknown
}

/** ES 层统一错误：调用方只需要看 `kind`，不解析 message */
export class EsError extends Error {
  readonly kind: EsErrorKind
  readonly status: number | undefined
  readonly esType: string | undefined
  readonly hint: string
  attempts: number

  constructor(message: string, options: EsErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EsError'
    this.kind = options.kind
    this.status = options.status
    this.esType = options.esType
    this.hint = options.hint ?? HINTS[options.kind]
    this.attempts = options.attempts ?? 1
  }
}

/** 把任意异常压成一行给模型看的文字（含提示，不含凭证） */
export function formatEsError(err: unknown): string {
  if (err instanceof EsError) {
    const hint = err.hint ? `（${err.hint}）` : ''
    return `${err.message}${hint}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

export interface EsClientConfig {
  /** 形如 https://127.0.0.1:9200（不带尾部斜杠；不允许内嵌用户名密码） */
  url: string
  /** 自签 CA 的 PEM 路径；留空表示用系统信任库（自签证书会校验失败，这正是我们要暴露的） */
  caCertPath?: string
  /** 单次请求超时（毫秒） */
  requestTimeoutMs?: number
  username: string
  password: string
}

/** 写入类请求的公共选项 */
export interface WriteOptions {
  /** 显式指定文档 id；不给则让 ES 生成 */
  id?: string
  /** wait_for 表示返回前刷新（写完立刻能搜到）；默认不刷新 */
  refresh?: 'true' | 'wait_for'
  /** create 表示只新建（已存在 → 409），index 表示 upsert（默认） */
  opType?: 'index' | 'create'
}

export interface EsWriteResult {
  id: string
  /** created / updated / noop */
  result: string
  status: number
}

export interface EsGetResult {
  id: string
  index: string
  /** 命中时是文档内容；404 会抛 not_found，不会走到这里 */
  source: Record<string, unknown>
}

export interface EsSearchResult {
  took: number
  /** 命中总数（ES 7+ 是对象，这里归一成数字） */
  total: number
  hits: Hit[]
}

export interface EsInfo {
  cluster_name?: string
  version: { number: string }
}

export interface EsHealth {
  status: string
  number_of_nodes?: number
  active_primary_shards?: number
}

export interface EsClient {
  readonly endpoint: string
  info(): Promise<EsInfo>
  health(): Promise<EsHealth>
  /** 写入/覆盖一条文档（writer 凭证） */
  index(indexName: string, doc: Record<string, unknown>, options?: WriteOptions): Promise<EsWriteResult>
  get(indexName: string, id: string): Promise<EsGetResult>
  /** 局部更新（partial doc），writer 凭证 */
  update(
    indexName: string,
    id: string,
    doc: Record<string, unknown>,
    options?: Pick<WriteOptions, 'refresh'>,
  ): Promise<EsWriteResult>
  /** 检索；body 由 `es/dsl.ts` 组装，这里只负责收发 */
  search(indexName: string, body: Record<string, unknown>): Promise<EsSearchResult>
}

interface RawSearchHit {
  _id?: unknown
  _score?: unknown
  _source?: unknown
}

interface RawSearchResponse {
  took?: unknown
  hits?: {
    total?: unknown
    hits?: unknown
  }
}

interface RawErrorResponse {
  error?: { type?: unknown; reason?: unknown; root_cause?: unknown }
}

/** 解析「1200」或「{value:1200,relation:'eq'}」两种 total 形态 */
function normalizeTotal(total: unknown): number {
  if (typeof total === 'number') return total
  if (total && typeof total === 'object' && typeof (total as { value?: unknown }).value === 'number') {
    return (total as { value: number }).value
  }
  return 0
}

/** 从 ES 错误体里取 type / reason（取不到就当没有，不要抛二次错误） */
function parseEsErrorBody(text: string): { esType?: string; reason?: string } {
  try {
    const parsed = JSON.parse(text) as RawErrorResponse
    const error = parsed?.error
    if (!error || typeof error !== 'object') return {}
    const esType = typeof error.type === 'string' ? error.type : undefined
    let reason = typeof error.reason === 'string' ? error.reason : undefined
    if (!reason && Array.isArray(error.root_cause) && error.root_cause.length > 0) {
      const first = error.root_cause[0] as { reason?: unknown }
      reason = typeof first?.reason === 'string' ? first.reason : undefined
    }
    return { esType, reason }
  } catch {
    return {}
  }
}

function kindFromStatus(status: number): EsErrorKind {
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 413 || status === 422) return 'bad_request'
  return 'server'
}

/** 连接层异常的分类：证书问题单列（自签 CA 是本项目最常见的一类失败） */
function classifyTransportError(err: unknown, what: string): EsError {
  const e = err as NodeJS.ErrnoException
  const code = typeof e?.code === 'string' ? e.code : ''
  const text = typeof e?.message === 'string' ? e.message : String(err)
  if (/CERT|TLS|SSL|ALTNAME|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate|TLS|SSL/i.test(text)) {
    return new EsError(`${what} → TLS 校验失败：${code || text}`, { kind: 'tls', cause: err })
  }
  return new EsError(`${what} → 连接失败：${code || text}`, { kind: 'network', cause: err })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 建客户端。配置非法在这里就抛（插件加载期 fail-fast，而不是第一次写记忆才炸）。
 */
export function createEsClient(config: EsClientConfig): EsClient {
  let baseUrl: URL
  try {
    baseUrl = new URL(config.url)
  } catch {
    throw new EsError(`es.url 不是合法 URL：${config.url}`, { kind: 'config' })
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new EsError(`es.url 只支持 http/https：${baseUrl.protocol}`, { kind: 'config' })
  }
  if (baseUrl.username || baseUrl.password) {
    throw new EsError('es.url 里不要内嵌用户名密码（会出现在错误信息里），改用 identity.*', {
      kind: 'config',
    })
  }
  if (!config.username || !config.password) {
    throw new EsError('identity 用户名或密码为空：拒绝建立 ES 客户端', { kind: 'config' })
  }
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EsError(`es.requestTimeoutMs 非法：${String(config.requestTimeoutMs)}`, { kind: 'config' })
  }

  // 一次读入、常驻内存：证书轮换后需要重启插件才知道（写进文档）
  let caPem: Buffer | undefined
  if (config.caCertPath) {
    try {
      caPem = readFileSync(config.caCertPath)
    } catch (err) {
      throw new EsError(`读不到 CA 证书：${config.caCertPath}`, { kind: 'config', cause: err })
    }
  }

  const authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`
  const transport = baseUrl.protocol === 'https:' ? httpsRequest : httpRequest

  /** 发一次请求；不做重试与语义解释 */
  function once(method: string, path: string, payload: unknown): Promise<{ status: number; text: string }> {
    const target = new URL(path, baseUrl)
    const shown = `${method} ${target.pathname}${target.search}`
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8')
    const headers: Record<string, string | number> = {
      authorization: authHeader,
      accept: 'application/json',
    }
    if (body) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = body.byteLength
    }

    return new Promise((resolve, reject) => {
      const req = transport(
        target,
        { method, headers, ca: caPem },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', (err) => reject(classifyTransportError(err, shown)))
        },
      )
      req.setTimeout(timeoutMs, () => {
        req.destroy(new EsError(`${shown} → 超时（${timeoutMs}ms）`, { kind: 'timeout' }))
      })
      req.on('error', (err) => {
        reject(err instanceof EsError ? err : classifyTransportError(err, shown))
      })
      if (body) req.write(body)
      req.end()
    })
  }

  /** 把 2xx/非 2xx 都翻译成「返回值或 EsError」 */
  function interpret<T>(method: string, path: string, status: number, text: string): T {
    if (status >= 200 && status < 300) {
      if (text.trim() === '') return {} as T
      try {
        return JSON.parse(text) as T
      } catch (err) {
        throw new EsError(`${method} ${path} → 响应不是 JSON（HTTP ${status}）`, { kind: 'protocol', cause: err })
      }
    }
    const { esType, reason } = parseEsErrorBody(text)
    const kind = kindFromStatus(status)
    const detail = [esType ? `(${esType})` : '', reason ?? text.slice(0, 200)].filter(Boolean).join(' ')
    throw new EsError(`${method} ${path} → HTTP ${status} ${detail}`.trim(), { kind, status, esType })
  }

  /** 统一入口：只在 409 / 429 上重试一次（各一次，不是“无限”） */
  async function request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        const { status, text } = await once(method, path, payload)
        return interpret<T>(method, path, status, text)
      } catch (err) {
        const failure = err instanceof EsError ? err : new EsError(String(err), { kind: 'protocol', cause: err })
        const delay = RETRY_DELAY_MS[failure.kind]
        if (delay === undefined || attempt > 1) {
          failure.attempts = attempt
          throw failure
        }
        await sleep(delay)
      }
    }
  }

  const enc = encodeURIComponent

  function refreshQuery(refresh: 'true' | 'wait_for' | undefined): string {
    return refresh ? `?refresh=${refresh}` : ''
  }

  return {
    endpoint: `${baseUrl.origin}`,

    async info() {
      return await request<EsInfo>('GET', '/')
    },

    async health() {
      return await request<EsHealth>('GET', '/_cluster/health')
    },

    async index(indexName, doc, options = {}) {
      const query: string[] = []
      if (options.refresh) query.push(`refresh=${options.refresh}`)
      if (options.opType === 'create') query.push('op_type=create')
      const suffix = query.length > 0 ? `?${query.join('&')}` : ''
      const path =
        options.id === undefined
          ? `/${enc(indexName)}/_doc${suffix}`
          : `/${enc(indexName)}/_doc/${enc(options.id)}${suffix}`
      const method = options.id === undefined ? 'POST' : 'PUT'
      const raw = await request<{ _id?: unknown; result?: unknown }>(method, path, doc)
      return {
        id: typeof raw._id === 'string' ? raw._id : (options.id ?? ''),
        result: typeof raw.result === 'string' ? raw.result : 'updated',
        status: 200,
      }
    },

    async get(indexName, id) {
      const raw = await request<{ _id?: unknown; _index?: unknown; _source?: unknown }>(
        'GET',
        `/${enc(indexName)}/_doc/${enc(id)}`,
      )
      return {
        id: typeof raw._id === 'string' ? raw._id : id,
        index: typeof raw._index === 'string' ? raw._index : indexName,
        source: (raw._source ?? {}) as Record<string, unknown>,
      }
    },

    async update(indexName, id, doc, options = {}) {
      const raw = await request<{ _id?: unknown; result?: unknown }>(
        'POST',
        `/${enc(indexName)}/_update/${enc(id)}${refreshQuery(options.refresh)}`,
        { doc },
      )
      return {
        id: typeof raw._id === 'string' ? raw._id : id,
        result: typeof raw.result === 'string' ? raw.result : 'updated',
        status: 200,
      }
    },

    async search(indexName, body) {
      const raw = await request<RawSearchResponse>('POST', `/${enc(indexName)}/_search`, body)
      const rawHits = Array.isArray(raw.hits?.hits) ? (raw.hits.hits as RawSearchHit[]) : []
      const hits: Hit[] = rawHits.map((hit) => ({
        id: typeof hit._id === 'string' ? hit._id : '',
        score: typeof hit._score === 'number' ? hit._score : 0,
        source: (hit._source ?? {}) as Record<string, unknown>,
      }))
      return {
        took: typeof raw.took === 'number' ? raw.took : 0,
        total: normalizeTotal(raw.hits?.total),
        hits,
      }
    },
  }
}
