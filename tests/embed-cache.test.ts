/**
 * 检索侧 embedding 缓存（阶段 20 预热）的回归。
 *
 * 这里钉的都是「会从优化变成故障」的性质，不是「能存能取」：
 *  · in-flight 去重：预热与 assemble 撞同一条文本时，只能打一次 Ollama ——
 *    不去重的话这条「优化」会把 embedding 调用翻倍；
 *  · TTL 过期必须重新算：否则换模型后进程会一直用旧向量；
 *  · 淘汰只按插入顺序：上限是内存保护，不该有副作用；
 *  · get 返回副本：调用方改数组不能污染缓存（检索侧确实会拿它拼请求体）；
 *  · 失败不写缓存：一次网络抖动不该被记成「这条文本的向量就是空」。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Embedder } from '../src/embedding.ts'
import { createEmbedCache } from '../src/embed-cache.ts'

/** 可计数、可控制延迟的假 embedder */
function fakeEmbedder(dims = 3): Embedder & { calls: string[] } {
  const calls: string[] = []
  return {
    model: 'fake',
    dims,
    calls,
    async embed(text: string): Promise<number[]> {
      calls.push(text)
      return Array.from({ length: dims }, (_, i) => text.length + i)
    },
  }
}

describe('embed-cache', () => {
  test('miss 调 inner 并缓存，命中不再调', async () => {
    const inner = fakeEmbedder()
    const embed = createEmbedCache({ ttlMs: 30_000, now: () => 1_000 }).wrap(inner)

    const first = await embed.embed('团队库 summary')
    const second = await embed.embed('团队库 summary')

    assert.deepEqual(first, second)
    assert.equal(inner.calls.length, 1)
  })

  test('in-flight 去重：并发两次只打一次 Ollama', async () => {
    const started: string[] = []
    const inner: Embedder = {
      model: 'slow',
      dims: 2,
      async embed(text: string): Promise<number[]> {
        started.push(text)
        await new Promise((r) => setTimeout(r, 20))
        return [1, 2]
      },
    }
    const embed = createEmbedCache({ ttlMs: 30_000 }).wrap(inner)

    const [a, b] = await Promise.all([embed.embed('同一条'), embed.embed('同一条')])

    assert.deepEqual(a, b)
    assert.equal(started.length, 1, '并发两次必须共享同一个在途请求')
  })

  test('TTL 过期后重新计算', async () => {
    const inner = fakeEmbedder()
    let clock = 1_000
    const embed = createEmbedCache({ ttlMs: 100, now: () => clock }).wrap(inner)

    await embed.embed('会被过期的')
    clock += 99
    await embed.embed('会被过期的')
    assert.equal(inner.calls.length, 1, '未过期应命中')

    clock += 2
    await embed.embed('会被过期的')
    assert.equal(inner.calls.length, 2, '过期后必须重新算')
  })

  test('超过上限按插入顺序淘汰最旧的一条', async () => {
    const inner = fakeEmbedder()
    const embed = createEmbedCache({ ttlMs: 30_000, maxEntries: 2 }).wrap(inner)

    await embed.embed('a')
    await embed.embed('b')
    await embed.embed('c') // 淘汰 a

    await embed.embed('b')
    await embed.embed('c')
    assert.equal(inner.calls.length, 3, 'b/c 仍在缓存里，不该重算')

    await embed.embed('a')
    assert.equal(inner.calls.length, 4, 'a 已被淘汰，必须重算')
  })

  test('get 返回副本，改返回值不污染缓存', async () => {
    const cache = createEmbedCache({ ttlMs: 30_000 })
    cache.set('x', [1, 2, 3])
    const got = cache.get('x')
    assert.deepEqual(got, [1, 2, 3])
    got![0] = 99
    assert.deepEqual(cache.get('x'), [1, 2, 3])
  })

  test('inner 抛错不写缓存，下次还会重试', async () => {
    let fail = true
    const calls: string[] = []
    const inner: Embedder = {
      model: 'flaky',
      dims: 1,
      async embed(text: string): Promise<number[]> {
        calls.push(text)
        if (fail) throw new Error('ollama 挂了')
        return [7]
      },
    }
    const cache = createEmbedCache({ ttlMs: 30_000 })
    const embed = cache.wrap(inner)

    await assert.rejects(() => embed.embed('会失败的'))
    assert.equal(cache.size(), 0, '失败的调用不能留下条目')

    fail = false
    assert.deepEqual(await embed.embed('会失败的'), [7])
    assert.equal(calls.length, 2)
  })

  test('模型与维度原样透传', () => {
    const inner = fakeEmbedder(1024)
    const embed = createEmbedCache().wrap(inner)
    assert.equal(embed.model, 'fake')
    assert.equal(embed.dims, 1024)
  })

  test('空文本与空向量不写缓存', async () => {
    const cache = createEmbedCache()
    cache.set('', [1])
    cache.set('x', [])
    assert.equal(cache.size(), 0)
  })
})

