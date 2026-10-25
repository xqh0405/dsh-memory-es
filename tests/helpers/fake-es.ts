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
  requests: CapturedRequest[]
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
export async function startFakeEs(handler: FakeHandler): Promise<FakeEs> {
  const requests: CapturedRequest[] = []
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
      requests.push(captured)
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
