/**
 * 写侧工具（save / update_status / promote）共用的底座：
 * 索引名派生、按 id 取「自己的」文档、归属断言。
 *
 * 这里刻意只依赖 `EsClient` 的两个方法（get / update），方便测试注入假客户端；
 * **读一律用 reader 凭证、写一律用 writer 凭证**——即便 mem_writer 也有 read 权限，
 * 也不拿写凭证去读，免得一处越权配置被无限放大。
 *
 * @module dsh-memory-es/memory/common
 */

import type { EsClient } from '../es/http.ts'
import { EsError } from '../es/http.ts'

export interface MemoryStoreDeps {
  /** F2 注入源 */
  userId: string
  /** 个人索引前缀；索引名一律由 前缀 + userId 派生 */
  personalPrefix: string
  /** 读身份（取文档） */
  reader: Pick<EsClient, 'get'> & Partial<Pick<EsClient, 'search'>>
  /** 写身份（唯一写入口） */
  writer: Pick<EsClient, 'update'>
  /** 结构化日志：不记录 content / 凭证 */
  log?: (event: Record<string, unknown>) => void
}

export interface OwnedDoc {
  id: string
  source: Record<string, unknown>
}

/** 个人索引名：全仓库唯一的拼法 */
export function personalIndexFor(personalPrefix: string, userId: string): string {
  return `${personalPrefix}${userId}`
}

/**
 * F3：写前/改前断言归属。做成独立纯函数，是为了不让它跟着注入点一起被改掉。
 * （save.ts 从本模块转出，保持老调用点不变。）
 */
export function assertDocOwner(source: Record<string, unknown>, userId: string): void {
  if (source.user_id !== userId) {
    throw new Error(
      `身份校验失败：文档 user_id（${String(source.user_id)}）与 identity.userId（${userId}）不一致，已拒绝操作`,
    )
  }
}

/**
 * 按 id 取文档，并把两类失败翻译成模型能懂的错：
 *  · 404 → 明确说「没有这条记忆」，并提示 memory_id 可能来自别的用户/别的库；
 *  · 归属不符 → 拒绝（F3）。
 */
export async function loadOwnedDoc(deps: MemoryStoreDeps, memoryId: string): Promise<OwnedDoc> {
  const id = (memoryId ?? '').trim()
  if (id === '') throw new Error('memory_id 不能为空')

  let doc: { id: string; source: Record<string, unknown> }
  try {
    doc = await deps.reader.get(personalIndexFor(deps.personalPrefix, deps.userId), id)
  } catch (err) {
    if (err instanceof EsError && err.kind === 'not_found') {
      throw new Error(`找不到记忆 ${id}（个人库里没有这条；索引缺失时先跑 scripts/init-indices.sh）`, { cause: err })
    }
    throw err
  }
  assertDocOwner(doc.source, deps.userId)
  return { id: doc.id, source: doc.source }
}

/** 统一的时间戳写法：ES 的 date 字段收 ISO 字符串 */
export function nowIso(now: Date): string {
  return now.toISOString()
}
