/**
 * 进程内假 ES（HTTP，非 HTTPS）：用来钉住错误映射与重试策略。
 *
 * 为什么用 http 而不是 https：浏览器端无关，Node 侧要造 409/429/5xx/超时这些
 * **真实 ES 造不出来或造出来很脏**的场景。`es/http.ts` 支持 http 只为这个用途，
 * 生产配置必须是 https（见集成测试里的 TLS 用例）。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extractWrites, strictErrorBody, strictViolations } from './mapping-gate.ts'

export interface CapturedRequest {
  method: string
  /** 含 query string 的原始路径 */
  path: string
  headers: IncomingMessage['headers']
  body: string
  /** 收到该请求的时间戳（ms），用于断言退避 */
  at: number
}

export interface FakeEs {
  url: string
  /** 逻辑查询（`_msearch` 已拆成逐条），每条带自己的 `/<index>/_search` 路径 */
  requests: CapturedRequest[]
  /** `_msearch` 的实际 HTTP 往返次数（阶段 20 用它断言「4 路查询合成 1 次」） */
  readonly msearchCalls: number
  close(): Promise<void>
}

export type FakeHandler = (req: CapturedRequest, res: ServerResponse, seq: number) => void | Promise<void>

/** 回一个 JSON 响应 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

/** 回一个 ES 形态的错误体 */
export function sendEsError(res: ServerResponse, status: number, type: string, reason: string): void {
  sendJson(res, status, { error: { root_cause: [{ type, reason }], type, reason }, status })
}

/**
 * 启一个监听随机端口的假 ES。`seq` 是从 1 开始的请求序号，方便“第一次 409、第二次 200”。
 */
export async function startFakeEs(
  handler: FakeHandler,
  options: {
    /** 不拆 `_msearch`，原样交给 handler（用于测协议层的畸形响应） */
    rawMsearch?: boolean
    /**
     * `dynamic:strict` 写入闸（2026-11-11 审查 #31）默认**开**：
     * 写入请求里出现映射外的字段就回 400 `strict_dynamic_mapping_exception`，
     * 与真 ES 同形 —— 这样「代码加了映射没有的字段」在所有写路径测试里天然变红
     * （历史上 19 个字段缺口就是这么漏的）。
     * 只有**故意**造脏字段的用例才该传 false 关掉它。
     */
    strictMapping?: boolean
  } = {},
): Promise<FakeEs> {
  const requests: CapturedRequest[] = []
  let msearchCalls = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        at: Date.now(),
      }
      // 阶段 20：检索改成一次 `_msearch`（NDJSON）。假 ES 在**这里**把它拆回逐条，
      // 每条子查询仍走调用方原来的 handler——测试不用为「合并成几次往返」改一行。
      // requests 只记**逻辑查询**（拆开的子查询），msearch 的实际往返次数看 msearchCalls。
      if (captured.path.includes('/_msearch') && options.rawMsearch !== true) {
        msearchCalls += 1
        void replyMsearch(captured, res, handler, requests).catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end(String(err))
        })
        return
      }
      requests.push(captured)
      // dynamic:strict 写入闸（#31）：映射外字段一律 400，与真 ES 同形。
      // 放在 handler **之前**——真 ES 根本不会把这种请求交给写路径，测试也该如此。
      if (options.strictMapping !== false) {
        for (const write of extractWrites(captured.method, captured.path, captured.body)) {
          const missing = strictViolations(write.index, write.doc)
          if (missing.length > 0) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify(strictErrorBody(missing, write.index)))
            return
          }
        }
      }
      void Promise.resolve(handler(captured, res, requests.length)).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(err))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get msearchCalls() {
      return msearchCalls
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

/** 只收集、不真写的 Response：把 handler 对单条子查询的输出截下来 */
function createCollector(): { res: ServerResponse; status: () => number; text: () => string } {
  let status = 200
  const chunks: string[] = []
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (payload?: string | Buffer) => {
      chunks.push(typeof payload === 'string' ? payload : (payload ?? '').toString('utf8'))
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    text: () => chunks.join(''),
  }
}

/**
 * `_msearch` = NDJSON：每两条一组（header + 查询体）。
 * 拆开后逐条喂给原 handler，再按顺序拼回 ES 的 `{responses: [...]}` 形状。
 *
 * 为什么不在各测试里各写一份：六个测试文件都有假 ES，逐个适配等于把
 * 「合并请求」这件事散进测试——一处漏改就是假绿。
 */
async function replyMsearch(
  captured: CapturedRequest,
  res: ServerResponse,
  handler: FakeHandler,
  requests: CapturedRequest[],
): Promise<void> {
  const lines = captured.body.split('\n').filter((line) => line.trim() !== '')
  const responses: unknown[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    let index = ''
    try {
      const header = JSON.parse(lines[i]!) as { index?: unknown }
      index = typeof header.index === 'string' ? header.index : ''
    } catch {
      index = ''
    }
    const sub: CapturedRequest = {
      ...captured,
      method: 'POST',
      path: `/${index}/_search`,
      body: lines[i + 1] ?? '',
    }
    requests.push(sub)
    const collector = createCollector()
    await handler(sub, collector.res, i / 2 + 1)
    const text = collector.text()
    if (text.trim() === '') {
      responses.push({ status: 200, hits: { total: 0, hits: [] } })
      continue
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      // handler 用 sendEsError 时会带 error：透传成 msearch 的单条 error 形态
      responses.push(
        typeof parsed.error === 'object' && parsed.error !== null
          ? { status: collector.status(), error: parsed.error }
          : parsed,
      )
    } catch {
      responses.push({ status: collector.status(), error: { type: 'parse_exception', reason: text.slice(0, 120) } })
    }
  }
  sendJson(res, 200, { responses })
}
