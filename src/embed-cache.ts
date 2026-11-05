/**
 * 检索侧 embedding 缓存（阶段 20 · 预热）。
 *
 * 为什么需要：一次检索里唯一的大头是 embed（本机 CPU 124ms，125 GPU 40ms），
 * 而它只依赖**同一条文本**——同一个模型、同一份权重，同文本的向量是确定性的。
 * 所以「把结果存起来」不会改变任何检索语义，只是把等待提前。
 *
 * 三个必须处理好的点（都不做就会从「优化」变成「故障」）：
 *
 *  1. **in-flight 去重**：预热在 `agent/inbox/inserted` 就发起，assemble 随后又查同一条
 *     文本。如果只做「查缓存 → 没有 → 打 Ollama」，两个请求会同时打出去，等于把开销
 *     翻倍。这里用 in-flight Promise 共享同一个在途请求。
 *  2. **TTL 而不是永久**：向量只与「文本 + 模型」有关，但模型可能被换（换模型要重建索引），
 *     而且库里没有版本号可说。给短 TTL（默认 30s，与注入结果缓存同量级）足够覆盖
 *     「一条消息 → 一次 assemble」，又不会让进程长期持有旧模型的向量。
 *  3. **上限与淘汰**：1024 维 float 约 4KB/条；64 条 ≈ 256KB，可以忽略。用 Map 的插入
 *     顺序做 LRU，满了删最早插入的那条（不做访问顺序重排——收益不值那点代码）。
 *
 * 失败语义：`inner.embed` 抛错就**不写缓存**，异常照常抛给调用方（检索侧本来就把
 * embedding 失败降级成纯 BM25）。预热侧另有一层 catch，见 index.ts。
 *
 * @module dsh-memory-es/embed-cache
 */

import type { Embedder } from './embedding.ts'

export interface EmbedCacheOptions {
  /** 条目 TTL（毫秒）；默认 30_000。<= 0 表示不过期（测试用） */
  ttlMs?: number
  /** 最多保留多少条；默认 64 */
  maxEntries?: number
  /** 注入时钟（测试用） */
  now?: () => number
}

export interface EmbedCache {
  /** 命中返回副本；副本是必要的——调用方可能改数组，污染缓存 */
  get(text: string): number[] | undefined
  /** 写入一条（预热侧直接用；一般不必，走 wrap 的 embed 更稳） */
  set(text: string, vector: readonly number[]): void
  clear(): void
  /** 当前条目数（验收与测试用） */
  size(): number
  /**
   * 包一层 Embedder：先查缓存，命中直接返回；miss 时与在途请求共享同一次调用。
   * 返回的 Embedder 的 model/dims 原样透传。
   */
  wrap(inner: Embedder): Embedder
}

export function createEmbedCache(options: EmbedCacheOptions = {}): EmbedCache {
  const ttlMs = options.ttlMs ?? 30_000
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 64))
  const now = options.now ?? ((): number => Date.now())

  const store = new Map<string, { at: number; vector: number[] }>()
  const inflight = new Map<string, Promise<number[]>>()

  const fresh = (at: number): boolean => ttlMs <= 0 || now() - at < ttlMs

  function get(text: string): number[] | undefined {
    const hit = store.get(text)
    if (hit === undefined) return undefined
    if (!fresh(hit.at)) {
      // 过期即删：不删的话「每查一次都算一次 now」会一直留着惰性条目
      store.delete(text)
      return undefined
    }
    return [...hit.vector]
  }

  function set(text: string, vector: readonly number[]): void {
    if (text === '' || vector.length === 0) return
    // 先删再插：保证 Map 的插入顺序就是 LRU 顺序
    store.delete(text)
    store.set(text, { at: now(), vector: [...vector] })
    while (store.size > maxEntries) {
      const oldest = store.keys().next()
      if (oldest.done === true) break
      store.delete(oldest.value)
    }
  }

  function wrap(inner: Embedder): Embedder {
    return {
      model: inner.model,
      dims: inner.dims,
      async embed(text, call) {
        const hit = get(text)
        if (hit !== undefined) return hit

        // 在途共享：预热与 assemble 撞同一文本时只打一次 Ollama
        const pending = inflight.get(text)
        if (pending !== undefined) return await pending

        const request = inner
          .embed(text, call)
          .then((vector) => {
            set(text, vector)
            return vector
          })
          .finally(() => {
            inflight.delete(text)
          })
        inflight.set(text, request)
        return await request
      },
    }
  }

  return {
    get,
    set,
    clear: () => {
      store.clear()
      inflight.clear()
    },
    size: () => store.size,
    wrap,
  }
}