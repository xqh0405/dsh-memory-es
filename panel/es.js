/**
 * 面板用的只读 ES 客户端。
 *
 * 为什么在面板包里再写一份而不是 import 主插件：主插件的 `lib/index.js` 只导出 `apply`，
 * 不导出客户端；两边共享的只有"配置"，而配置通过 `configEditor` 按 entry id 读，天然只有一份。
 *
 * 约束（与主插件同源）：
 *  · 永不 `rejectUnauthorized: false`：自签 CA 由 `caCertPath` 读进来校验；
 *  · 只做只读动作（`_search` / `_cluster/health` / `_cat/indices`），面板不写库。
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** 读一次 CA 并缓存：面板每次请求都会用到它，重复读盘没必要 */
const caCache = new Map()

function loadCa(path) {
  if (!path) return undefined
  if (caCache.has(path)) return caCache.get(path)
  const pem = readFileSync(path, 'utf8')
  caCache.set(path, pem)
  return pem
}

function requestOnce(urlString, { method, path, body, auth, ca, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const isHttps = url.protocol === 'https:'
    const send = isHttps ? httpsRequest : httpRequest
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json' }
    if (auth) {
      headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
    }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.byteLength)
    }
    const req = send(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        method,
        path: `${url.pathname.replace(/\/$/, '')}${path}`,
        headers,
        ca,
        signal,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, text })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 建一个"每个请求现读配置"的只读客户端（配置改了不用重启面板） */
export function createReadClient(resolveConfig) {
  const call = async (path, options = {}) => {
    const config = resolveConfig()
    if (!config.ok) throw new Error(config.error)
    const { url, caCertPath, auth, timeoutMs } = config.value
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? 8000)
    try {
      const res = await requestOnce(url, {
        method: options.method ?? 'GET',
        path,
        body: options.body,
        auth,
        ca: loadCa(caCertPath),
        signal: controller.signal,
      })
      if (res.status >= 400) {
        const detail = res.text.slice(0, 300)
        throw new Error(`ES ${res.status}: ${detail}`)
      }
      return res.text === '' ? {} : JSON.parse(res.text)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    search: (index, body) => call(`/${encodeURIComponent(index)}/_search`, { method: 'POST', body }),
    count: (index) => call(`/${encodeURIComponent(index)}/_count`),
    health: () => call('/_cluster/health'),
    catIndices: (names) => call(`/_cat/indices/${names.join(',')}?format=json&h=index,docs.count,store.size,health`),
  }
}
