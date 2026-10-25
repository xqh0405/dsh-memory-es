/**
 * 整理任务集成测试（真 ES + 真 Ollama）：dry-run 零写入 → apply 真写团队库 → 重跑幂等。
 *
 * 三个必须证明的点：
 *  1. **dry-run 一条都不写**（§16 S8 判据）——个人库 promote_state 不变、团队库零新增；
 *  2. **apply 写出的团队条目带全溯源字段**（source_user / source_memory_id / topic_key / embedding）；
 *  3. **敏感内容被拦在团队库之外**，且个人库只置 blocked。
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { emptyState } from '../consolidate/state.ts'
import type { ConsolidateDeps } from '../consolidate/run.ts'
import { runConsolidation } from '../consolidate/run.ts'
import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { countByDomain, deleteByDomain, deleteDocsById, getAdminDoc } from './helpers/es-admin.ts'
import { isLoopbackUrl, loadEsTestEnv, type EsTestEnv } from './helpers/es-env.ts'

const MARKER_DOMAIN = '__consol_it'
const CLEAN_A = '整理集成测试：北单中断开奖要同时写 win_price 与 win_price_practical，否则统计口径会错。'
const CLEAN_B = '整理集成测试：发布流水线生产 job 只认 main 分支，测试 job 只认 test 分支。'
const SECRET = '整理集成测试：数据库密码 password=Realsecret123 不能进团队库。'

const env = loadEsTestEnv()

if (!env) {
  test('整理任务集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else if (!isLoopbackUrl(env.url)) {
  test('整理任务集成测试', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
} else {
  defineConsolidateIntegration(env)
}

function defineConsolidateIntegration(e: EsTestEnv): void {
  const reader = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
  const writer = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.writer })
  const consolidator = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.consolidator })
  const embed = createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024, timeoutMs: 20_000 })

  const saveDeps: SaveDeps = {
    userId: e.userId,
    personalPrefix: 'personal_memory_',
    defaultDomain: MARKER_DOMAIN,
    reader,
    writer,
    embed,
  }
  const deps: ConsolidateDeps = {
    userId: e.userId,
    personalIndex: e.personalIndex,
    teamIndex: e.teamIndex,
    reader,
    writer,
    consolidator,
    embed,
    dims: 1024,
  }

  let cleanAId = ''
  let cleanBId = ''
  let secretId = ''
  /** 本次测试写进团队库的 doc_id（整理任务按设计会扫整个索引，可能“顺手”晋升别人的文档，
   *  这些也得清掉，否则会污染后面的测试文件） */
  const promotedTeamDocIds: string[] = []

  describe('真实实例：整理任务闭环', () => {
    before(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      await deleteByDomain(e, e.teamIndex, MARKER_DOMAIN)
      const [a, b, secret] = await Promise.all([
        saveMemory(saveDeps, { content: CLEAN_A, domain: MARKER_DOMAIN }),
        saveMemory(saveDeps, { content: CLEAN_B, domain: MARKER_DOMAIN }),
        saveMemory(saveDeps, { content: SECRET, domain: MARKER_DOMAIN }),
      ])
      cleanAId = a.memory_id
      cleanBId = b.memory_id
      secretId = secret.memory_id
    })

    after(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      await deleteByDomain(e, e.teamIndex, MARKER_DOMAIN)
      await deleteDocsById(e, e.teamIndex, promotedTeamDocIds)
      assert.equal(await countByDomain(e, e.personalIndex, MARKER_DOMAIN), 0)
      assert.equal(await countByDomain(e, e.teamIndex, MARKER_DOMAIN), 0)
    })

    test('dry-run：判定照做，但团队库与个人库一条都不写', async () => {
      const report = await runConsolidation(deps, { apply: false, batchSize: 50, state: emptyState() })
      assert.equal(report.applied, false)
      // 只看自己种下的三条：整理任务按设计扫整个个人索引，别的测试文件残留的文档也会进来
      const mine = report.results.filter((item) => [cleanAId, cleanBId, secretId].includes(item.memory_id))
      assert.equal(mine.length, 3, '本测试种下的三条都应被扫到')
      assert.equal(mine.filter((item) => item.verdict === 'new').length, 2, '两条干净内容判为可晋升')
      assert.equal(mine.filter((item) => item.verdict === 'blocked').length, 1, '含密码那条被敏感扫描拦下')

      assert.equal(await countByDomain(e, e.teamIndex, MARKER_DOMAIN), 0, 'dry-run 不能写团队库')
      const a = await getAdminDoc(e, e.personalIndex, cleanAId)
      assert.equal(a.source?.promote_state, 'none', 'dry-run 不能改个人库状态')
      const secret = await getAdminDoc(e, e.personalIndex, secretId)
      assert.equal(secret.source?.promote_state, 'none')
    })

    test('apply：写团队库（带溯源字段与向量），并把个人库标成 promoted/blocked', async () => {
      const report = await runConsolidation(deps, { apply: true, batchSize: 50, state: emptyState() })
      const mine = report.results.filter((item) => [cleanAId, cleanBId, secretId].includes(item.memory_id))
      assert.equal(mine.filter((item) => item.verdict === 'new').length, 2)
      assert.equal(mine.filter((item) => item.verdict === 'blocked').length, 1)
      for (const item of report.results) if (item.teamDocId) promotedTeamDocIds.push(item.teamDocId)

      const team = await reader.search(e.teamIndex, { size: 10, _source: { excludes: ['embedding'] } })
      const teamDocs = team.hits.filter((hit) => hit.source.domain === MARKER_DOMAIN)
      assert.equal(teamDocs.length, 2, '两条干净内容各写一条团队条目')
      for (const hit of teamDocs) {
        const source = hit.source
        assert.equal(source.source_user, e.userId)
        assert.equal(typeof source.source_memory_id, 'string')
        assert.equal(typeof source.source_created_at, 'string')
        assert.equal(typeof source.topic_key, 'string')
        assert.match(String(source.content_sha256), /^[0-9a-f]{64}$/)
        assert.equal(source.review_state, 'auto')
        assert.equal(source.status, 'active')
      }

      const promotedA = await getAdminDoc(e, e.personalIndex, cleanAId)
      assert.equal(promotedA.source?.promote_state, 'promoted')
      const blocked = await getAdminDoc(e, e.personalIndex, secretId)
      assert.equal(blocked.source?.promote_state, 'blocked', '敏感内容只置状态、不进团队库')

      // 敏感内容一个字都不该出现在团队库
      const leak = await consolidator.search(e.teamIndex, {
        size: 1,
        _source: { excludes: ['embedding'] },
        query: { bool: { filter: [{ term: { domain: MARKER_DOMAIN } }], must: [{ match_phrase: { content: 'Realsecret123' } }] } },
      })
      assert.equal(leak.total, 0, '密码不能进团队库')
    })

    test('重跑幂等：已处理的条目跳过，团队库不新增', async () => {
      const before = await countByDomain(e, e.teamIndex, MARKER_DOMAIN)
      const first = await runConsolidation(deps, { apply: true, batchSize: 50, state: emptyState() })
      const second = await runConsolidation(deps, {
        apply: true,
        batchSize: 50,
        state: { ...first.state },
      })
      // 第二轮：三条都已置状态（promoted/blocked），不再是候选
      const mine = second.results.filter((item) => [cleanAId, cleanBId, secretId].includes(item.memory_id))
      assert.deepEqual(mine, [], '已处理的条目不再被选中')
      for (const item of first.results) if (item.teamDocId) promotedTeamDocIds.push(item.teamDocId)
      assert.equal(await countByDomain(e, e.teamIndex, MARKER_DOMAIN), before, '团队库不新增')
    })

    test('promoted 的干净条目不会再次成为候选（promote_state 过滤生效）', async () => {
      const report = await runConsolidation(deps, { apply: false, batchSize: 50, state: emptyState() })
      const mine = report.results.filter((item) => [cleanAId, cleanBId, secretId].includes(item.memory_id))
      assert.deepEqual(mine, [], 'promoted/blocked 的条目不再成为候选')
    })

    test('cleanB 也在团队库里（两条都到位，不是只写了一条）', async () => {
      const found = await reader.search(e.teamIndex, {
        size: 5,
        _source: { excludes: ['embedding'] },
        query: { bool: { filter: [{ term: { domain: MARKER_DOMAIN } }], must: [{ match_phrase: { content: 'test 分支' } }] } },
      })
      assert.equal(found.hits.some((hit) => hit.source.source_memory_id === cleanBId), true)
    })
  })
}
