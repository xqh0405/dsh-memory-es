/**
 * fragment.ts 的纯函数契约测试（S1 的清单里一直欠着，S4 用到了就补上）。
 * 这里不碰网络、不碰 ES：rrf / margin / mergeScopes / projectHit / renderText 的口径都在这里钉死。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  mergeScopes,
  normalizeContent,
  type Projected,
  projectHit,
  renderText,
  rrfFuse,
  scoreMargin,
  sha256Hex,
  type Fused,
  type Hit,
} from '../src/fragment.ts'

function hit(id: string, score = 1, source: Record<string, unknown> = {}): Hit {
  return { id, score, source }
}

function fusedScoreOf(routes: Hit[][], k = 60): Map<string, number> {
  return new Map(rrfFuse(routes, k).map((item) => [item.id, item.fusedScore]))
}

describe('normalizeContent / sha256Hex', () => {
  test('NFKC + 折叠空白 + 去首尾；幂等', () => {
    assert.equal(normalizeContent('　a　 b  '), 'a b')
    const once = normalizeContent('Ａ　Ｂ   Ｃ')
    assert.equal(normalizeContent(once), once)
  })

  test('同文不同空白的哈希相同（幂等键的根据）', () => {
    assert.equal(sha256Hex(normalizeContent('记录 一条')), sha256Hex(normalizeContent('　记录　一条　')))
  })
})

describe('rrfFuse', () => {
  test('名次融合：两路都靠前的排第一，且分数 = Σ 1/(k+rank)', () => {
    const fused = rrfFuse(
      [
        [hit('a', 9), hit('b', 5)],
        [hit('b', 0.9), hit('a', 0.5)],
      ],
      60,
    )
    // a: 1/61 + 1/62；b: 1/62 + 1/61 → 同分，稳定排序下 a 在前
    assert.deepEqual(fused.map((item) => item.id).sort(), ['a', 'b'])
    const a = fused.find((item) => item.id === 'a') as Fused
    assert.ok(Math.abs(a.fusedScore - (1 / 61 + 1 / 62)) < 1e-12)
    assert.deepEqual(a.routeRanks, [1, 2])
  })

  test('只在一路出现也能进结果（分数更低）', () => {
    const fused = rrfFuse([[hit('both', 3)], [hit('both', 3), hit('only-second', 1)]], 60)
    assert.equal(fused[0].id, 'both')
    assert.equal(fused[1].id, 'only-second')
    assert.equal(fused[1].fusedScore, 1 / 62)
  })

  test('空输入返回空数组', () => {
    assert.deepEqual(rrfFuse([], 60), [])
    assert.deepEqual(rrfFuse([[], []], 60), [])
  })
})

describe('scoreMargin', () => {
  test('top1-top2；不足两条返回 0', () => {
    assert.ok(Math.abs(scoreMargin([0.6, 0.45, 0.3]) - 0.15) < 1e-12, '浮点比较不能用相等')
    assert.equal(scoreMargin([0.6]), 0)
    assert.equal(scoreMargin([]), 0)
  })
})

describe('mergeScopes', () => {
  const personalHits = rrfFuse([[hit('p1', 1, { content_sha256: 'h1' }), hit('p2', 1, { content_sha256: 'h2' })]], 60)
  const teamHits = rrfFuse([[hit('t1', 1, { content_sha256: 'h1' }), hit('t2', 1, { content_sha256: 'h3' })]], 60)

  test('个人库乘权重后排在团队库之前', () => {
    const merged = mergeScopes(
      [
        { source: 'personal', hits: personalHits },
        { source: 'team', hits: teamHits },
      ],
      { weights: { personal: 1.2 } },
    )
    assert.equal(merged[0].origin, 'personal')
    assert.equal(merged[0].id, 'p1')
    assert.ok(merged[0].fusedScore > merged.find((item) => item.id === 't2')!.fusedScore)
  })

  test('按 content_sha256 去重：同一条两库都有时只留高分那条（个人加权后即个人）', () => {
    const merged = mergeScopes(
      [
        { source: 'personal', hits: personalHits },
        { source: 'team', hits: teamHits },
      ],
      { weights: { personal: 1.2 } },
    )
    const sameHash = merged.filter((item) => item.contentHash === 'h1')
    assert.equal(sameHash.length, 1)
    assert.equal(sameHash[0].origin, 'personal')
    assert.equal(merged.length, 3, 'h1 去重后剩 3 条（p1/p2/t2）')
  })

  test('没有 content_sha256 时退回 id 去重（不会把不同文档误合并）', () => {
    const a = rrfFuse([[hit('same-id-but-different-doc', 1)]], 60)
    const b = rrfFuse([[hit('another', 1)]], 60)
    const merged = mergeScopes([
      { source: 'personal', hits: a },
      { source: 'team', hits: b },
    ])
    assert.deepEqual(merged.map((item) => item.contentHash).sort(), ['another', 'same-id-but-different-doc'])
  })

  test('同分时 personal 优先、再按 id，结果稳定', () => {
    const first = mergeScopes([
      { source: 'team', hits: rrfFuse([[hit('b')]], 60) },
      { source: 'personal', hits: rrfFuse([[hit('a')]], 60) },
      { source: 'personal', hits: rrfFuse([[hit('c')]], 60) },
    ])
    const second = mergeScopes([
      { source: 'personal', hits: rrfFuse([[hit('c')]], 60) },
      { source: 'team', hits: rrfFuse([[hit('b')]], 60) },
      { source: 'personal', hits: rrfFuse([[hit('a')]], 60) },
    ])
    assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id))
    assert.deepEqual(first.map((item) => item.id), ['a', 'c', 'b'])
  })
})

describe('projectHit / renderText', () => {
  const fused = rrfFuse(
    [[hit('id-1', 1, { memory_id: 'm-1', content: 'x'.repeat(600), memory_type: 'fact', domain: 'lottery-cloud', updated_at: '2026-10-25T12:00:00.000Z' })]],
    60,
  )[0]

  test('显式 source 优先；content 截断到上限并加省略号', () => {
    const projected = projectHit(fused, 500, 'team')
    assert.equal(projected.source, 'team')
    assert.equal(projected.content.length, 501, '500 字符 + 省略号')
    assert.ok(projected.content.endsWith('…'))
    assert.equal(projected.memory_id, 'm-1')
  })

  test('不传 source 时退回启发式（有 source_user = 团队库）', () => {
    const teamFused = rrfFuse([[hit('id-2', 1, { content: 'x', source_user: 'xqh' })]], 60)[0]
    assert.equal(projectHit(teamFused, 100).source, 'team')
    assert.equal(projectHit(fused, 100).source, 'personal')
  })

  test('renderText：空结果说清楚；有条目时带来源/类型/日期', () => {
    assert.equal(renderText([]), '没有找到相关记忆。')
    const projected: Projected = {
      memory_id: 'm-1',
      content: '北单中断开奖要同时写两个字段',
      memory_type: 'fact',
      domain: 'lottery-cloud',
      updated_at: '2026-10-25T12:00:00.000Z',
      source: 'personal',
      score: 0.03,
    }
    const text = renderText([projected])
    assert.match(text, /^1\. \[personal·fact·2026-10-25\] 北单中断开奖/)
  })
})
