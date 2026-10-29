/**
 * 面板用的只读 ES 客户端。
 *
 * 为什么在面板包里再写一份而不是 import 主插件：主插件的 `lib/index.js` 只导出 `apply`，
 * 不导出客户端；两边共享的只有"配置"，而配置通过 `configEditor` 按 entry id 读，天然只有一份。
 *
 * 约束（与主插件同源）：
 *  · 永不 `rejectUnauthorized: false`：自签 CA 由 `caCertPath` 读进来校验；
 *  · 读侧只做 `_search` / `_count`；写侧只有 `_update` / `_doc` / `_delete`：
 *    审核动作与自检种子用 `_update`/`_doc`，删除按钮用 `_delete`。
 *    面板自己没有集群级权限，不碰 `_cluster/*`、`_cat/*`。
 *  · `_security/user/_has_privileges` 是唯一例外：它只问「**我自己**对这个索引有没有这个权限」，
 *    不需要 manage_security。删除按钮该不该出现必须靠它——配置里的 teamWrite 只是声明，
 *    可能写 true 而账号实际没被授权（2026-10-29 在 125 上用两种账号实测可查）。
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
        // 状态码必须带出来：删除要区分 404（本来就不存在，按幂等成功算）和 403（没权限）
        const error = new Error(`ES ${res.status}: ${detail}`)
        error.status = res.status
        throw error
      }
      return res.text === '' ? {} : JSON.parse(res.text)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    search: (index, body) => call(`/${encodeURIComponent(index)}/_search`, { method: 'POST', body }),
    count: (index) => call(`/${encodeURIComponent(index)}/_count`),
    /**
     * 问 ES「本人对这个索引有没有这些权限」。返回 `{has_all_requested, index:{...}}`。
     * 失败会抛错，调用方按「没有权限」处理——宁可少给一个按钮，也不给一个点了 403 的按钮。
     */
    hasIndexPrivileges: (index, privileges) =>
      call('/_security/user/_has_privileges', {
        method: 'POST',
        body: { index: [{ names: [index], privileges }] },
      }),
    /** 物理删除一条文档。404 表示本来就不存在，由调用方决定算不算成功 */
    del: (index, id, options = {}) => {
      const query = options.refresh ? `?refresh=${encodeURIComponent(options.refresh)}` : ''
      return call(`/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}${query}`, { method: 'DELETE' })
    },
    /** 部分更新（审核动作用；需要 index 权限，只有整理身份有） */
    update: (index, id, doc, options = {}) => {
      const query = options.refresh ? `?refresh=${encodeURIComponent(options.refresh)}` : ''
      return call(
        `/${encodeURIComponent(index)}/_update/${encodeURIComponent(id)}${query}`,
        { method: 'POST', body: { doc } },
      )
    },
    /**
     * 写文档。`options.id` 有值就用它（PUT 幂等），否则让 ES 生成 id（写审计用）。
     * 注意路径必须是 `/{index}/_doc`，`POST /{index}` 会 405（2026-10-25 写自检抓到的）。
     */
    index: (index, doc, options = {}) => {
      const query = options.refresh ? `?refresh=${encodeURIComponent(options.refresh)}` : ''
      const idPart = options.id ? `/${encodeURIComponent(options.id)}` : ''
      return call(`/${encodeURIComponent(index)}/_doc${idPart}${query}`, {
        method: options.id ? 'PUT' : 'POST',
        body: doc,
      })
    },
  }
}
