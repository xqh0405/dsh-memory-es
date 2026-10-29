/**
 * 审核台集成测试（S9，真 ES）：pending 不进检索 → approve 后可见 → reject/withdraw 后不可见 → 审计留痕。
 *
 * 这条链最怕「看起来实现了、其实检索没挡」：所以每个动作之后都用**真的 searchMemories**
 * （不是直接查 ES）来断言可见性，否则测的只是字段有没有写进去。
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { approve, listPending, reject, withdraw } from '../consolidate/review.ts'
import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { searchMemories } from '../src/memory/search.ts'
import { adminRequest, deleteByDomain, deleteDocsById } from './helpers/es-admin.ts'
import { isLoopbackUrl, loadEsTestEnv, type EsTestEnv } from './helpers/es-env.ts'

const MARKER_DOMAIN = '__review_it'
const AUDIT_INDEX = 'memory_audit'

const env = loadEsTestEnv()

if (!env) {
  test('审核台集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else if (!isLoopbackUrl(env.url)) {
  test('审核台集成测试', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
} else {
  defineReviewIntegration(env)
}

function defineReviewIntegration(e: EsTestEnv): void {
  const reader = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
  const consolidator = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.consolidator })
  const embed = createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024, timeoutMs: 20_000 })

  const reviewDeps = {
    teamIndex: e.teamIndex,
    client: consolidator,
    audit: { client: consolidator, index: AUDIT_INDEX },
  }
  const searchDeps = {
    userId: e.userId,
    personalPrefix: 'personal_memory_',
    teamIndex: e.teamIndex,
    reader,
    embed,
    dims: 1024,
    retrieval: { topK: 20, rrfK: 60, limit: 8 },
  }

  const created: string[] = []
  const FIXTURE_IDS = ['pending-1', 'approved-1', 'reject-1', 'withdraw-1']

  /** 审计是只增流水，测试要按 subject_id 清自己的那几条，否则断言「恰好 1 条」会越跑越多 */
  async function cleanAudit(): Promise<void> {
    await adminRequest(e, 'POST', `/${AUDIT_INDEX}/_delete_by_query?refresh=true&conflicts=proceed`, {
      query: { terms: { subject_id: FIXTURE_IDS } },
    })
  }

  /** 直接种一条团队条目（绕过整理任务，专注审核动作本身） */
  async function seedTeamDoc(id: string, content: string, reviewState: string): Promise<void> {
    await consolidator.index(
      e.teamIndex,
      {
        doc_id: id,
        content,
        memory_type: 'fact',
        domain: MARKER_DOMAIN,
        topic_key: `${MARKER_DOMAIN}:${id}`,
        content_sha256: `hash-${id}`,
        source_user: e.userId,
        source_memory_id: `mem-${id}`,
        source_created_at: '2026-10-01T00:00:00Z',
        promoted_at: '2026-10-01T00:00:00Z',
        status: 'active',
        review_state: reviewState,
        updated_at: '2026-10-01T00:00:00Z',
      },
      { id, refresh: 'wait_for' },
    )
    created.push(id)
  }

  const visible = async (query: string): Promise<string[]> => {
    const result = await searchMemories(searchDeps, { query, scope: 'team', domain: [MARKER_DOMAIN], limit: 8 })
    // Projected 用 memory_id；团队条目没有 memory_id 字段时 projectHit 会回落成 ES 的 _id（= doc_id）
    return result.hits.map((hit) => hit.memory_id)
  }

  describe('真实实例：审核队列', () => {
    before(async () => {
      await deleteByDomain(e, e.teamIndex, MARKER_DOMAIN)
      await cleanAudit()
      await seedTeamDoc('pending-1', '审核台测试：发布流水线生产 job 只认 main 分支 ZZZ-REVIEW-PENDING。', 'pending')
      await seedTeamDoc('approved-1', '审核台测试：测试环境用 bge-m3 做向量 ZZZ-REVIEW-APPROVED。', 'approved')
    })

    after(async () => {
      await deleteByDomain(e, e.teamIndex, MARKER_DOMAIN)
      await deleteDocsById(e, e.teamIndex, created)
      await cleanAudit()
    })

    test('pending 已落库但检索看不到；approved 能搜到', async () => {
      // 落库了（不然队列里不会有它）
      const listed = await listPending(reviewDeps, { limit: 20 })
      assert.equal(
        listed.some((doc) => doc.doc_id === 'pending-1'),
        true,
        'pending 条目应出现在审核队列里',
      )

      const hits = await visible('ZZZ-REVIEW-PENDING 生产 job 分支')
      assert.equal(hits.includes('pending-1'), false, 'pending 不能出现在检索结果里')

      const approved = await visible('ZZZ-REVIEW-APPROVED bge-m3 向量')
      assert.equal(approved.includes('approved-1'), true, 'approved 必须能被搜到')
    })

    test('approve → 立刻可见，且写审计', async () => {
      const result = await approve(reviewDeps, 'pending-1', 'tester')
      assert.equal(result.changed, true)

      const hits = await visible('ZZZ-REVIEW-PENDING 生产 job 分支')
      assert.equal(hits.includes('pending-1'), true, 'approved 之后必须能搜到')

      const audit = await consolidator.search(AUDIT_INDEX, {
        size: 5,
        _source: { excludes: ['embedding'] },
        query: { bool: { filter: [{ term: { event: 'approved' } }, { term: { subject_id: 'pending-1' } }] } },
      })
      assert.equal(audit.total, 1, '通过动作要留审计流水')
      assert.equal(audit.hits[0].source.actor, 'tester')
    })

    test('reject → status=rejected，不再可见，且 reason 落库', async () => {
      await seedTeamDoc('reject-1', '审核台测试：这条结论与线上不符 ZZZ-REVIEW-REJECT。', 'pending')
      const result = await reject(reviewDeps, 'reject-1', 'tester', '结论与线上不符')
      assert.equal(result.changed, true)

      const doc = await reader.get(e.teamIndex, 'reject-1')
      assert.equal(doc.source.status, 'rejected')
      assert.equal(doc.source.reject_reason, '结论与线上不符')
      assert.equal(
        (await visible('ZZZ-REVIEW-REJECT 结论与线上不符')).includes('reject-1'),
        false,
        'rejected 不能出现在检索结果里',
      )
    })

    test('withdraw → status=superseded（不物理删），不再可见', async () => {
      await seedTeamDoc('withdraw-1', '审核台测试：这条知识已作废 ZZZ-REVIEW-WITHDRAW。', 'approved')
      assert.equal((await visible('ZZZ-REVIEW-WITHDRAW 知识作废')).includes('withdraw-1'), true, '撤回前可见')

      const result = await withdraw(reviewDeps, 'withdraw-1', 'tester', '知识已作废')
      assert.equal(result.changed, true)

      const doc = await reader.get(e.teamIndex, 'withdraw-1')
      assert.equal(doc.source.status, 'superseded', '撤回只改状态、不删文档')
      assert.equal((await visible('ZZZ-REVIEW-WITHDRAW 知识作废')).includes('withdraw-1'), false, '撤回后不可见')

      const audit = await consolidator.search(AUDIT_INDEX, {
        size: 5,
        _source: { excludes: ['embedding'] },
        query: { bool: { filter: [{ term: { event: 'withdrawn' } }, { term: { subject_id: 'withdraw-1' } }] } },
      })
      assert.equal(audit.total, 1)
    })
  })
}
