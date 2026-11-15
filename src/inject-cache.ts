/**
 * 阶段 38：注入结果的会话级缓存。
 *
 * 为什么需要：一个 turn 有多个 model step，每步都重新组装 prompt；实测单条 query
 * 一轮最多 28 次 assemble。同 query 在短时间内重复检索，结果不会变，只是白花
 * 一次 embed + 一次 ES 检索（共享 Ollama 上尤其明显）。
 *
 * 三条刻意的取舍：
 *  · key 由调用方归一化（`normalizeContent`）——同一句话的全半角/空白差异不该各算一次；
 *  · **有上限的 LRU**：长期运行的宿主不能因为 query 多而涨内存（旧实现是无上限 Map）；
 *  · TTL 同时是开关：`ttlMs <= 0` 时 set 直接不存。
 *
 * 缓存的是「整段注入文本 + 那条注入记录」：命中时连记录一起复用，面板才能看出
 * 这一轮是复用而不是真检索（`cache_hit`）。
 *
 * @module dsh-memory-es/inject-cache
 */

export interface InjectCacheEntry<TRecord> {
  /** 写入时刻（`now()` 的毫秒） */
  at: number
  text: string
  record: TRecord
}

export interface InjectResultCacheOptions {
  /** 复用窗口（毫秒）；`<= 0` = 关闭缓存 */
  ttlMs: number
  /** 最多保留多少条（LRU 淘汰最久未用的） */
  max?: number
  /** 注入时钟，便于测试 */
  now?: () => number
}

export interface InjectResultCache<TRecord> {
  /** 取一条（命中会刷新「最近使用」；过期即删除并返回 undefined） */
  get(key: string): InjectCacheEntry<TRecord> | undefined
  /** 存一条（`ttlMs <= 0` 时不存；超上限淘汰最久未用的） */
  set(key: string, text: string, record: TRecord): void
  /** 清空（save 成功后必须调用，否则「刚记住却查不到」） */
  clear(): void
  readonly size: number
}

export const DEFAULT_INJECT_CACHE_MAX = 200

export function createInjectResultCache<TRecord>(
  options: InjectResultCacheOptions,
): InjectResultCache<TRecord> {
  const ttlMs = options.ttlMs
  const max = Math.max(1, options.max ?? DEFAULT_INJECT_CACHE_MAX)
  const now = options.now ?? Date.now
  // Map 的迭代顺序 = 插入顺序：删除再插入即「移到最近使用」
  const store = new Map<string, InjectCacheEntry<TRecord>>()

  return {
    get(key) {
      if (ttlMs <= 0) return undefined
      const entry = store.get(key)
      if (entry === undefined) return undefined
      if (now() - entry.at > ttlMs) {
        store.delete(key)
        return undefined
      }
      // 触达：移到最后，避免它成为下一个被淘汰的
      store.delete(key)
      store.set(key, entry)
      return entry
    },
    set(key, text, record) {
      if (ttlMs <= 0) return
      store.delete(key)
      store.set(key, { at: now(), text, record })
      while (store.size > max) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        store.delete(oldest)
      }
    },
    clear() {
      store.clear()
    },
    get size() {
      return store.size
    },
  }
}
