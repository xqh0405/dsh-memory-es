/**
 * 本会话最近检索命中的记忆（阶段 9）。
 *
 * 只服务一个判据：**「检索结果原样再摄取」**——模型刚搜到一段原文，
 * 转头又把它原样写回记忆库。没有这份短期缓存，写入侧就只能拿全库做比对，
 * 而全库高相似是「同义改写」（那是有价值的），不是搬运。
 *
 * 三个刻意的取舍：
 *  · **进程内内存**，不落 ES：它只活在一轮对话的跨度里，重启即失效是正确行为；
 *  · **不存向量**，只存 id 与截断后的正文：比对用字符包含与 3-gram，够用且便宜；
 *  · 有上限与 TTL：长时间运行的宿主不能因为检索次数多而涨内存。
 *
 * @module dsh-memory-es/memory/recallCache
 */

import type { RecallRecord } from './admission.ts'

export interface RecallCacheOptions {
  /** 每个用户最多保留几条最近命中（默认 20） */
  max?: number
  /** 多久以前的命中不再参与比对（默认 30 分钟） */
  ttlMs?: number
  /** 注入时钟，便于测试 */
  now?: () => number
}

export interface RecallCache {
  /** 记下本轮检索命中的条目（同一 id 重复命中会被移到队首） */
  record(userId: string, hits: readonly RecallRecord[]): void
  /** 取某用户的最近命中（新的在前，已按 TTL 过滤） */
  recent(userId: string): RecallRecord[]
  /** 清空（测试用；传 userId 只清一个人） */
  clear(userId?: string): void
}

interface Entry extends RecallRecord {
  at: number
}

const DEFAULT_MAX = 20
const DEFAULT_TTL_MS = 30 * 60_000
/** 正文截断：比对只需要"最近这一段"，存全文对内存与 GC 都不友好 */
const MAX_CONTENT_CHARS = 600

export function createRecallCache(options: RecallCacheOptions = {}): RecallCache {
  const max = Math.max(1, options.max ?? DEFAULT_MAX)
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS)
  const now = options.now ?? Date.now
  const store = new Map<string, Entry[]>()

  const alive = (entries: Entry[], at: number): Entry[] => entries.filter((entry) => at - entry.at <= ttlMs)

  return {
    record(userId, hits) {
      if (!userId || hits.length === 0) return
      const at = now()
      const previous = alive(store.get(userId) ?? [], at)
      const incoming = hits
        .filter((hit) => typeof hit.memoryId === 'string' && hit.memoryId !== '')
        .map((hit) => ({
          memoryId: hit.memoryId,
          content: typeof hit.content === 'string' ? hit.content.slice(0, MAX_CONTENT_CHARS) : '',
          at,
        }))
      if (incoming.length === 0) {
        store.set(userId, previous)
        return
      }
      // 新的在前；同 id 去重（以最新一次为准）
      const seen = new Set<string>()
      const merged: Entry[] = []
      for (const entry of [...incoming, ...previous]) {
        if (seen.has(entry.memoryId)) continue
        seen.add(entry.memoryId)
        merged.push(entry)
        if (merged.length >= max) break
      }
      store.set(userId, merged)
    },

    recent(userId) {
      const entries = alive(store.get(userId) ?? [], now())
      return entries.map((entry) => ({ memoryId: entry.memoryId, content: entry.content }))
    },

    clear(userId) {
      if (userId === undefined) store.clear()
      else store.delete(userId)
    },
  }
}
