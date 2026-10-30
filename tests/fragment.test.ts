/**
 * fragment.ts 的纯函数契约测试（S1 的清单里一直欠着，S4 用到了就补上）。
 * 这里不碰网络、不碰 ES：rrf / margin / mergeScopes / projectHit / renderText 的口径都在这里钉死。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyRanking,
  spreadActivation,
  DEFAULT_RANKING,
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
  type ScopedHit,
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

describe('applyRanking（阶段 2 排序乘子）', () => {
  const NOW = new Date('2026-10-29T12:00:00.000Z')
  function scoped(id: string, fusedScore: number, src: Record<string, unknown> = {}): ScopedHit {
    return {
      id,
      score: fusedScore,
      source: { memory_id: id, ...src },
      routeRanks: [1],
      fusedScore,
      origin: 'personal',
      contentHash: id,
    }
  }

  test('三项系数全为 0 → 完全不动（关掉即等于没有这个特性）', () => {
    const hits = [scoped('a', 0.03), scoped('b', 0.02)]
    const out = applyRanking(
      hits,
      { importanceWeight: 0, hitWeight: 0, recencyWeight: 0, recencyHalfLifeDays: 0, reinforcementPerHit: 0, reinforcementCap: 0, agreementBonus: 0, activationAlpha: 0 },
      NOW,
    )
    assert.deepEqual(out.map((h) => h.fusedScore), [0.03, 0.02])
  })

  test('critical 能把接近的两条顶上来；low 会压下去', () => {
    const hits = [scoped('plain', 0.030), scoped('hot', 0.029, { importance: 'critical' }), scoped('meh', 0.031, { importance: 'low' })]
    const out = applyRanking(hits, DEFAULT_RANKING, NOW)
    assert.equal(out[0].id, 'hot', 'critical ×1.1 足以反超 3% 的差距')
    assert.equal(out[out.length - 1].id, 'meh')
  })

  test('命中次数是次线性加成：10 次与 100 次差距被压缩', () => {
    const hits = [scoped('few', 0.020, { hit_count: 0 }), scoped('some', 0.020, { hit_count: 10 }), scoped('many', 0.020, { hit_count: 100 })]
    const out = applyRanking(hits, DEFAULT_RANKING, NOW)
    assert.equal(out[0].id, 'many')
    assert.equal(out[2].id, 'few')
    const [many, , few] = out
    const gap1 = many.fusedScore - out[1].fusedScore
    const gap2 = out[1].fusedScore - few.fusedScore
    assert.ok(gap1 < gap2, 'log1p 让 100 次相对 10 次的增量小于 10 次相对 0 次')
  })

  test('新鲜度：同样分数下最近命中/写入的排前面', () => {
    const fresh = scoped('fresh', 0.02, { last_hit_at: '2026-10-29T00:00:00.000Z' })
    const stale = scoped('stale', 0.02, { updated_at: '2026-01-01T00:00:00.000Z' })
    const out = applyRanking([stale, fresh], DEFAULT_RANKING, NOW)
    assert.equal(out[0].id, 'fresh')
  })

  test('缺字段按中性处理（老文档不回填也能排序）', () => {
    const hits = [scoped('bare', 0.02)]
    const out = applyRanking(hits, DEFAULT_RANKING, NOW)
    assert.equal(out[0].fusedScore, 0.02, '没有任何信号 → 因子恰好为 1')
  })

  test('半衰期按 memory_type 分：同一天数下 fact 几乎不衰减，task_progress 衰减明显', () => {
    const old = '2026-09-29T12:00:00.000Z' // 距 NOW 30 天
    const fact = scoped('fact', 0.02, { memory_type: 'fact', updated_at: old })
    const progress = scoped('progress', 0.02, { memory_type: 'task_progress', updated_at: old })
    const out = applyRanking([progress, fact], DEFAULT_RANKING, NOW)
    assert.equal(out[0].id, 'fact', 'fact 半衰期 365 天，30 天后仍接近满分')
    assert.ok(out[0].fusedScore > out[1].fusedScore * 1.03, '两者应拉开差距')
  })

  test('访问强化延长寿命：同样 30 天前，命中过的比没命中的衰减慢', () => {
    const old = '2026-09-29T12:00:00.000Z'
    const warm = scoped('warm', 0.02, { memory_type: 'task_progress', updated_at: old, hit_count: 5 })
    const cold = scoped('cold', 0.02, { memory_type: 'task_progress', updated_at: old })
    const out = applyRanking([cold, warm], DEFAULT_RANKING, NOW)
    assert.equal(out[0].id, 'warm', '命中 5 次 → 寿命 ×1.5，衰减更慢')
  })

  test('强化封顶：命中 100 次与 5 次对「寿命」的延长相同（不会越用越不朽）', () => {
    const old = '2026-09-29T12:00:00.000Z'
    // 只留 recency 一项，才能单独看「寿命」的差异（hitWeight 的加分仍然随次数增加，那是另一回事）
    const onlyRecency = { ...DEFAULT_RANKING, importanceWeight: 0, hitWeight: 0 }
    const recencyOf = (hitCount: number) => {
      const hit = scoped('x', 0.02, { memory_type: 'task_progress', updated_at: old, hit_count: hitCount })
      return applyRanking([hit], onlyRecency, NOW)[0].fusedScore / 0.02 - 1
    }
    assert.ok(Math.abs(recencyOf(100) - recencyOf(5)) < 1e-12, '封顶 0.5：100 次与 5 次寿命相同')
    assert.ok(recencyOf(5) > recencyOf(0), '未封顶区间内仍应随命中增长')
  })

})

describe('rrfFuse agreementBonus（两路一致加成）', () => {
  function h(id: string, score = 1): Hit {
    return { id, score, source: { memory_id: id } }
  }

  test('关闭时保持原有 RRF 行为', () => {
    // A 两路都第 1；B 一路第 1、一路第 3
    const out = rrfFuse([[h('a'), h('b')], [h('b'), h('a')]], 60)
    const a = out.find((x) => x.id === 'a')!
    const b = out.find((x) => x.id === 'b')!
    assert.ok(Math.abs(a.fusedScore - b.fusedScore) < 1e-12, '两路名次互换时 RRF 分相同')
  })

  test('开启后「两路都是第 1」高于「一路第 1 一路第 3」', () => {
    // x：两路第 1；y：一路第 1、一路第 3
    const out = rrfFuse([[h('x'), h('y')], [h('x'), h('z'), h('y')]], 60, { agreementBonus: 0.2, span: 10 })
    const x = out.find((r) => r.id === 'x')!
    const y = out.find((r) => r.id === 'y')!
    assert.ok(x.fusedScore > y.fusedScore, '一致的那条应更高')
  })

  test('只在一路出现不加成（没有「一致」可言）', () => {
    const only = rrfFuse([[h('solo')], []], 60, { agreementBonus: 0.2, span: 10 })[0]
    assert.ok(Math.abs(only.fusedScore - 1 / 61) < 1e-12)
  })

  test('名次差超过 span 时加成归零', () => {
    const far = rrfFuse([[h('a')], [h('b'), h('c'), h('d'), h('a')]], 60, { agreementBonus: 0.2, span: 2 })
    const a = far.find((r) => r.id === 'a')!
    assert.ok(Math.abs(a.fusedScore - (1 / 61 + 1 / 64)) < 1e-12, 'gap=3 > span=2 → 无加成')
  })
})

describe('spreadActivation（阶段 5.3 扩散激活）', () => {
  function scoped(id: string, fusedScore: number, related?: Array<{ id: string; weight: number }>): ScopedHit {
    return {
      id,
      score: fusedScore,
      source: { memory_id: id, ...(related === undefined ? {} : { related }) },
      routeRanks: [1],
      fusedScore,
      origin: 'personal',
      contentHash: id,
    }
  }

  test('alpha=0 完全不动（与关闭等价）', () => {
    const hits = [scoped('a', 0.02, [{ id: 'b', weight: 0.8 }]), scoped('b', 0.03)]
    const out = spreadActivation(hits, 0)
    assert.deepEqual(out.map((h) => h.fusedScore), [0.02, 0.03])
    assert.deepEqual(out, hits, 'alpha=0 逐条原样返回')
  })

  test('邻居在结果集里才加分：a 借 b 的分反超', () => {
    // a 0.02、b 0.03；a 指向 b(0.8) → a 得 0.02 + 0.5*0.03*0.8 = 0.032，反超 b
    const hits = [scoped('a', 0.02, [{ id: 'b', weight: 0.8 }]), scoped('b', 0.03)]
    const out = spreadActivation(hits, 0.5)
    const a = out.find((h) => h.id === 'a')!
    assert.ok(Math.abs(a.fusedScore - 0.032) < 1e-12)
    assert.equal(out[0]?.id, 'a', '0.032 > 0.03：借分后 a 排到前面')
  })

  test('邻居不在结果集里 → 不变（不做二次召回）', () => {
    const hits = [scoped('a', 0.02, [{ id: 'ghost', weight: 0.9 }]), scoped('b', 0.03)]
    const out = spreadActivation(hits, 0.5)
    assert.deepEqual(out.map((h) => h.fusedScore), [0.03, 0.02], 'a 不该涨，排序仍按原分')
  })

  test('没有 related 字段 → 不变', () => {
    const hits = [scoped('a', 0.02), scoped('b', 0.03)]
    const out = spreadActivation(hits, 0.5)
    assert.deepEqual(out.map((h) => h.fusedScore), [0.03, 0.02])
  })

  test('多条邻居累加', () => {
    const hits = [
      scoped('a', 0.01, [
        { id: 'b', weight: 0.9 },
        { id: 'c', weight: 0.8 },
      ]),
      scoped('b', 0.02),
      scoped('c', 0.02),
    ]
    const out = spreadActivation(hits, 1)
    const a = out.find((h) => h.id === 'a')!
    assert.ok(Math.abs(a.fusedScore - (0.01 + (0.02 * 0.9 + 0.02 * 0.8))) < 1e-12)
  })
})
