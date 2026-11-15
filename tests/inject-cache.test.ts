/**
 * 阶段 38：注入结果缓存的纯函数测试。
 *
 * 守四件事：
 *  1. TTL 内命中、过期即失效（过期项顺手删掉，不留垃圾）；
 *  2. 有上限，且淘汰的是「最久未用」——命中一次就该被保护；
 *  3. `ttlMs <= 0` 是开关：不存也不取；
 *  4. `clear()` 真的清空（save 之后靠它保证「刚记住就能查到」）。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { normalizeContent } from '../src/fragment.ts'
import { createInjectResultCache } from '../src/inject-cache.ts'

interface Rec {
  outcome: string
}

function make(overrides: { ttlMs?: number; max?: number } = {}) {
  let clock = 1_000
  const cache = createInjectResultCache<Rec>({
    ttlMs: overrides.ttlMs ?? 600_000,
    max: overrides.max,
    now: () => clock,
  })
  return { cache, advance: (ms: number) => (clock += ms), now: () => clock }
}

describe('inject-cache', () => {
  test('TTL 内命中，返回 text 与 record', () => {
    const { cache, advance } = make()
    cache.set('q', '注入文本', { outcome: 'injected' })
    advance(1_000)
    const hit = cache.get('q')
    assert.ok(hit)
    assert.equal(hit.text, '注入文本')
    assert.equal(hit.record.outcome, 'injected')
  })

  test('过期即失效，且过期项被清掉（size 归零）', () => {
    const { cache, advance } = make({ ttlMs: 1_000 })
    cache.set('q', 'x', { outcome: 'injected' })
    advance(1_001)
    assert.equal(cache.get('q'), undefined)
    assert.equal(cache.size, 0)
  })

  test('上限按最久未用淘汰；命中一次就能续命', () => {
    const { cache } = make({ max: 2 })
    cache.set('a', 'A', { outcome: 'injected' })
    cache.set('b', 'B', { outcome: 'injected' })
    // 触达 a，让它变成「最近使用」
    assert.ok(cache.get('a'))
    cache.set('c', 'C', { outcome: 'injected' })
    assert.equal(cache.get('a')?.text, 'A', 'a 刚被用过，不该被淘汰')
    assert.equal(cache.get('b'), undefined, 'b 才是最久未用的')
    assert.equal(cache.get('c')?.text, 'C')
  })

  test('ttlMs=0 是关闭开关：不存也不取', () => {
    const { cache } = make({ ttlMs: 0 })
    cache.set('q', 'x', { outcome: 'injected' })
    assert.equal(cache.size, 0)
    assert.equal(cache.get('q'), undefined)
  })

  test('clear 清空全部（save 后必须能查到新内容）', () => {
    const { cache } = make()
    cache.set('q1', 'x', { outcome: 'injected' })
    cache.set('q2', 'y', { outcome: 'injected' })
    cache.clear()
    assert.equal(cache.size, 0)
    assert.equal(cache.get('q1'), undefined)
  })

  test('归一化后的 key：全半角与空白差异命中同一条', () => {
    const { cache } = make()
    cache.set(normalizeContent('北单 同步'), 'x', { outcome: 'injected' })
    // 调用方负责归一化；这里验证「同一句话的不同写法确实归一成同一个 key」
    assert.equal(normalizeContent('北单　同步  '), normalizeContent('北单 同步'))
    assert.ok(cache.get(normalizeContent('北单　同步  ')))
  })
})
