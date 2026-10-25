/**
 * 集成测试的「管理员通道」：用 elastic 超级用户直连 ES，做两件被测客户端不该做的事——
 * 清理测试数据、读取受限身份看不到的东西（`embedding` 原文、`_count`）。
 *
 * 为什么不走 `src/es/http.ts`：① 客户端里故意没有 delete；② 清理与取证要独立于
 * 被测代码，否则被测层错了，清理也跟着错。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { EsTestEnv } from './es-env.ts'

export interface AdminResponse {
  status: number
  text: string
}

export function adminRequest(
  env: EsTestEnv,
  method: string,
  path: string,
  payload?: unknown,
): Promise<AdminResponse> {
  const target = new URL(path, env.url)
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  const ca = target.protocol === 'https:' ? readFileSync(env.caCertPath) : undefined
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8')
  const auth = `Basic ${Buffer.from(`${env.admin.username}:${env.admin.password}`, 'utf8').toString('base64')}`

  return new Promise((resolve, reject) => {
    const req = transport(
      target,
      {
        method,
        ca,
        headers: {
          authorization: auth,
          'content-type': 'application/json',
          ...(body ? { 'content-length': body.byteLength } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 删掉某个 domain（测试标记）下的所有文档；索引不存在时当成功（首次跑） */
export async function deleteByDomain(env: EsTestEnv, index: string, domain: string): Promise<void> {
  const res = await adminRequest(env, 'POST', `/${index}/_delete_by_query?refresh=true&conflicts=proceed`, {
    query: { term: { domain } },
  })
  if (res.status === 404) return
  assert.equal(res.status, 200, `清理失败：HTTP ${res.status}`)
}

/** 数一下某个 domain 下还剩几条（用来断言「清理干净了」） */
/** 按 _id 逐条删除（整理测试用来清掉“顺手替别的文件晋升”的团队条目） */
export async function deleteDocsById(env: EsTestEnv, index: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await adminRequest(env, 'DELETE', `/${index}/_doc/${encodeURIComponent(id)}?refresh=true`).catch(() => {
      // 已经不在了就当删过：测试清理不能因为 404 而失败
    })
  }
}

export async function countByDomain(env: EsTestEnv, index: string, domain: string): Promise<number> {
  const res = await adminRequest(env, 'POST', `/${index}/_search`, {
    size: 0,
    query: { term: { domain } },
  })
  assert.equal(res.status, 200, `计数失败：HTTP ${res.status}`)
  const parsed = JSON.parse(res.text) as { hits: { total: { value: number } } }
  return parsed.hits.total.value
}

/** 按 id 取文档（可指定要回传的字段，例如只看 embedding 在不在） */
export async function getAdminDoc(
  env: EsTestEnv,
  index: string,
  id: string,
  sourceIncludes?: string,
): Promise<{ status: number; source: Record<string, unknown> | null }> {
  const suffix = sourceIncludes ? `?_source_includes=${encodeURIComponent(sourceIncludes)}` : ''
  const res = await adminRequest(env, 'GET', `/${index}/_doc/${encodeURIComponent(id)}${suffix}`)
  if (res.status !== 200) return { status: res.status, source: null }
  const parsed = JSON.parse(res.text) as { _source?: Record<string, unknown> }
  return { status: res.status, source: parsed._source ?? null }
}
