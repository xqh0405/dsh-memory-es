/**
 * 整理任务的纯函数单测：敏感扫描、规则蒸馏、topic_key、三道去重判定、触发策略、状态游标。
 *
 * 这些是「一旦判错就会把脏东西写进全员可读索引」的地方，所以每条阈值都要被钉住。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { detectContradiction } from '../consolidate/conflict.ts'
import { decideDedupe } from '../consolidate/dedupe.ts'
import { distillBatch, stripPersonalContext, topicKey } from '../consolidate/distill.ts'
import { buildCandidateQuery, shouldRun } from '../consolidate/scan.ts'
import { scanSensitive, summarizeHits } from '../consolidate/sensitive.ts'
import {
  alreadyProcessed,
  daysSinceLastRun,
  emptyState,
  loadState,
  saveState,
  withPending,
  withProcessed,
} from '../consolidate/state.ts'

describe('scanSensitive', () => {
  test('私钥块命中', () => {
    const hits = scanSensitive('凭证如下\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n请妥善保管')
    assert.equal(hits.some((hit) => hit.kind === 'private_key'), true)
  })

  test('云厂商 AccessKey / API token / 手机号 / 身份证 / 密码赋值 都能命中', () => {
    const cases: Array<[string, string]> = [
      ['key: LTAI5tAbCdEfGhIjKlMn', 'cloud_ak'],
      ['token: sk-abcdefghijklmnopqrst', 'api_token'],
      ['token: ghp_abcdefghijklmnopqrstuvwx', 'api_token'],
      ['联系 13800138000 处理', 'phone'],
      ['身份证 110101199003078515', 'id_card'],
      ['mysql password=S3cretPass', 'password_assignment'],
    ]
    for (const [text, kind] of cases) {
      const hits = scanSensitive(text)
      assert.equal(hits.some((hit) => hit.kind === kind), true, `应当命中 ${kind}：${text}`)
    }
  })

  test('占位符不误报（change-me / xxx / ${VAR} / 全星号）', () => {
    for (const text of ['password=change-me', 'password=xxxxx', 'password=${DB_PASS}', 'password=******']) {
      assert.deepEqual(scanSensitive(text), [], `不该命中：${text}`)
    }
  })

  test('干净文本不命中；摘要函数只给类型不给原文', () => {
    assert.deepEqual(scanSensitive('北单中断开奖要同时写两个字段'), [])
    const hits = scanSensitive('LTAI5tAbCdEfGhIjKlMn 与 13800138000')
    const summary = summarizeHits(hits)
    assert.equal(summary.includes('LTAI'), false)
    assert.equal(summary.includes('13800138000'), false)
    assert.match(summary, /cloud_ak/)
    assert.match(summary, /phone/)
  })

  test('hit 只记录位置，不携带原文', () => {
    const text = 'prefix LTAI5tAbCdEfGhIjKlMn suffix'
    const [hit] = scanSensitive(text)
    assert.deepEqual(Object.keys(hit).sort(), ['end', 'kind', 'note', 'start'])
    assert.equal(text.slice(hit.start, hit.end).startsWith('LTAI'), true)
  })
})

describe('stripPersonalContext', () => {
  test('去掉第一/第二人称，保留事实与可复现信息', () => {
    const out = stripPersonalContext('我的环境里，上次你说要把 v1.2.3 的 bin/dsh 加到 PATH')
    assert.equal(out.includes('我的'), false)
    assert.equal(out.includes('上次你说'), false)
    assert.equal(out.includes('v1.2.3'), true, '版本号必须保留')
    assert.equal(out.includes('bin/dsh'), true, '路径必须保留')
  })

  test('幂等：归一化后再跑一遍不变', () => {
    const once = stripPersonalContext('我们踩过这个坑：ERROR 3105')
    assert.equal(stripPersonalContext(once), once)
  })
})

describe('topicKey', () => {
  test('同 domain 且前 60 字相同 → 同 key；不同 domain → 不同 key', () => {
    const head = '北单中断开奖要同时写 win_price 与 win_price_practical，否则按 practical 统计的中奖会是 0，'
    const a = topicKey('lottery-cloud', `${head}这条在 2026 年踩过`)
    assert.equal(a, topicKey('lottery-cloud', `${head}这条在 2027 年也会踩`), '前 60 字相同 → 同 key')
    assert.notEqual(a, topicKey('backup-server', `${head}这条在 2026 年踩过`), 'domain 不同 → key 不同')
  })

  test('短文本（≤60 字）逐字敏感：差一个字就不同 key——规则版的取舍，别当 bug', () => {
    assert.notEqual(
      topicKey('d', '北单中断开奖要同时写两个字段'),
      topicKey('d', '北单中断开奖要同时写两个字段。'),
    )
  })

  test('开头不同即不同 key —— 规则版的已知局限，写在这里免得被当成 bug', () => {
    assert.notEqual(
      topicKey('d', '北单中断开奖同时写两个字段'),
      topicKey('d', '比赛腰斩时赔率字段要一起写'),
    )
  })
})

describe('distillBatch', () => {
  test('不替人判价值：verdict 恒为 team_worthy、confidence 固定 0.5、distilled_by=rule', () => {
    const [item] = distillBatch([
      { memory_id: 'm1', content: '我的环境里 xxx', memory_type: 'fact', domain: 'd', created_at: '2026-10-01T00:00:00Z' },
    ])
    assert.equal(item.verdict, 'team_worthy')
    assert.equal(item.confidence, 0.5)
    assert.equal(item.distilled_by, 'rule')
    assert.deepEqual(item.source_memory_ids, ['m1'])
    assert.equal(item.rewritten_content.includes('我的'), false)
  })

  test('domain 为空时回落 general', () => {
    const [item] = distillBatch([
      { memory_id: 'm1', content: 'x', memory_type: 'fact', domain: '  ', created_at: '2026-10-01T00:00:00Z' },
    ])
    assert.equal(item.domain, 'general')
  })
})

describe('decideDedupe（§9.4 三道闸）', () => {
  const neighbor = (score: number, topicKey = 'd:t1') => ({ id: 'team-1', score, topicKey })

  test('精确 sha 命中 → duplicate（最优先，不看相似度）', () => {
    const decision = decideDedupe({ shaHit: 'team-0', neighbors: [], topicKey: 'd:t1' })
    assert.equal(decision.verdict, 'duplicate')
    assert.equal(decision.neighborId, 'team-0')
  })

  test('没有邻居 → new', () => {
    assert.equal(decideDedupe({ shaHit: null, neighbors: [], topicKey: 'd:t1' }).verdict, 'new')
  })

  test('相似度 ≥0.90 → merge_candidate（判重复但要走合并）', () => {
    const decision = decideDedupe({ shaHit: null, neighbors: [neighbor(0.93)], topicKey: 'd:t1' })
    assert.equal(decision.verdict, 'merge_candidate')
    assert.equal(decision.topScore, 0.93)
  })

  test('0.88~0.9 且同 topic_key → pending（人工队列，不落库）', () => {
    const decision = decideDedupe({ shaHit: null, neighbors: [neighbor(0.89)], topicKey: 'd:t1' })
    assert.equal(decision.verdict, 'pending')
    assert.match(decision.reason, /同 topic_key/)
  })

  test('0.88~0.9 但 topic_key 不同 → 仍然 pending（2026-10-27 修正）', () => {
    // 旧逻辑要求 topic_key 相同才 pending，而 topic_key 只认「正文前 60 字相同」，
    // 换个说法就失效 → 这道闸实际永不触发。现在按纯相似度判，topic_key 只做文案补充。
    const decision = decideDedupe({ shaHit: null, neighbors: [neighbor(0.89, 'd:other')], topicKey: 'd:t1' })
    assert.equal(decision.verdict, 'pending')
    assert.equal(decision.reason.includes('低于'), false)
    assert.match(decision.reason, /topic_key 不同/)
  })

  test('低于 0.88 才是 new，且文案说「低于」', () => {
    const decision = decideDedupe({ shaHit: null, neighbors: [neighbor(0.3)], topicKey: 'd:t1' })
    assert.equal(decision.verdict, 'new')
    assert.match(decision.reason, /低于 0\.88/)
  })

  test('阈值可覆盖（便于以后调参而不改逻辑）', () => {
    const decision = decideDedupe({
      shaHit: null,
      neighbors: [neighbor(0.85)],
      topicKey: 'd:t1',
      duplicateThreshold: 0.8,
    })
    assert.equal(decision.verdict, 'merge_candidate')
  })
})

describe('detectContradiction（§9.4 冲突判定）', () => {
  test('反义极性词对 → 判冲突', () => {
    const result = detectContradiction('必须同时写 win_price 与 win_price_practical', '禁止同时写 win_price 与 win_price_practical')
    assert.equal(result.contradiction, true)
    assert.deepEqual(result.pair, ['必须', '禁止'])
  })

  test('同极性（都要求 / 都禁止）→ 不判冲突', () => {
    assert.equal(detectContradiction('必须写 A', '必须写 A 并且写 B').contradiction, false)
    assert.equal(detectContradiction('禁止写 A', '不能写 A').contradiction, false)
  })

  test('一边没表态 → 不判冲突（不能凭空造冲突）', () => {
    assert.equal(detectContradiction('必须写 A', 'A 字段是 LONGTEXT').contradiction, false)
  })

  test('否定词优先匹配：「不支持」不会被「支持」吃掉', () => {
    // 若实现先匹配「支持」，这条会变成 pos vs pos 而漏判（极性判定必须否定词优先）
    assert.equal(detectContradiction('支持这个方案', '不支持这个方案').contradiction, true)
  })

  test('中英混写也能命中（enable/disable）', () => {
    assert.equal(detectContradiction('enable xpack security', 'disable xpack security').contradiction, true)
  })
})

describe('shouldRun（§9.1 三种触发）', () => {
  test('手动总是跑', () => {
    assert.equal(shouldRun({ pendingCount: 0, daysSinceLastRun: 0, manual: true }).by, 'manual')
  })

  test('待整理数达阈值就跑', () => {
    assert.equal(shouldRun({ pendingCount: 20, daysSinceLastRun: 0 }).by, 'count')
    assert.equal(shouldRun({ pendingCount: 19, daysSinceLastRun: 1 }).run, false)
  })

  test('从未整理过就跑', () => {
    assert.equal(shouldRun({ pendingCount: 0, daysSinceLastRun: null }).by, 'days')
  })

  test('距上次 ≥7 天且有新增才跑', () => {
    assert.equal(shouldRun({ pendingCount: 1, daysSinceLastRun: 7.2, hasNewSinceLast: true }).by, 'days')
    assert.equal(shouldRun({ pendingCount: 1, daysSinceLastRun: 7.2, hasNewSinceLast: false }).run, false)
  })
})

describe('buildCandidateQuery', () => {
  test('只扫 active、非 private、promote_state∈{none,candidate}，按 created_at 升序', () => {
    const body = buildCandidateQuery({ batchSize: 5, createdAfter: new Date('2026-10-01T00:00:00Z') })
    assert.equal(body.size, 5)
    assert.deepEqual(body._source, { excludes: ['embedding'] })
    const query = body.query as { bool: { filter: unknown[]; must_not: unknown[] } }
    assert.deepEqual(query.bool.filter, [
      { term: { status: 'active' } },
      { terms: { promote_state: ['none', 'candidate'] } },
      { range: { created_at: { gte: '2026-10-01T00:00:00.000Z' } } },
    ])
    assert.deepEqual(query.bool.must_not, [{ term: { privacy: 'private' } }])
    assert.deepEqual(body.sort, [{ created_at: 'asc' }])
  })
})

describe('state（游标与幂等）', () => {
  test('读写往返，且坏文件退化成空状态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'consolidate-state-'))
    try {
      const path = join(dir, 'state.json')
      assert.deepEqual(loadState(path), emptyState(), '文件不存在 → 空状态')
      const next = withProcessed(emptyState(), 'm1', { at: '2026-10-25T00:00:00Z', verdict: 'promoted', reason: 'x' })
      saveState(path, next)
      const loaded = loadState(path)
      assert.equal(alreadyProcessed(loaded, 'm1'), true)
      assert.equal(loaded.lastRunAt, null)

      writeFileSync(path, '{ 这不是 JSON')
      assert.deepEqual(loadState(path), emptyState(), '坏文件不能让整理任务崩掉')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pending 去重（同 memory_id 只留最新）；daysSinceLastRun 计算', () => {
    let state = withPending(emptyState(), { memory_id: 'm1', at: 't1', reason: 'old' })
    state = withPending(state, { memory_id: 'm1', at: 't2', reason: 'new' })
    assert.equal(state.pending.length, 1)
    assert.equal(state.pending[0].reason, 'new')

    assert.equal(daysSinceLastRun(emptyState()), null)
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const value = daysSinceLastRun({ ...emptyState(), lastRunAt: twoDaysAgo })
    assert.ok(value !== null && Math.abs(value - 2) < 0.01)
  })
})
