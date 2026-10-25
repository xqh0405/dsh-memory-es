/**
 * `memory_update_status` / `memory_promote` 集成测试：真 ES，验证
 * 「supersede 双写生效 → 旧版本不再出现在检索里 → expire 生效 → promote 只标候选」。
 *
 * 纪律同前：只在回环实例写数据、`domain=__status_it` 标记、before/after 清理并断言零残留。
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createEmbedder } from '../src/embedding.ts'
import { bm25Body } from '../src/es/dsl.ts'
import { createEsClient } from '../src/es/http.ts'
import { promoteMemory } from '../src/memory/promote.ts'
import { saveMemory, type SaveDeps } from '../src/memory/save.ts'
import { updateStatus } from '../src/memory/status.ts'
import { countByDomain, deleteByDomain } from './helpers/es-admin.ts'
import { isLoopbackUrl, loadEsTestEnv, type EsTestEnv } from './helpers/es-env.ts'

const MARKER_DOMAIN = '__status_it'
const OLD_CONTENT = '状态集成测试：旧版本记忆 ZZZ-OLD-MARKER 这条要被新版本取代。'
const FRESH_CONTENT = '状态集成测试：新版本记忆 ZZZ-FRESH-MARKER 取代旧版本。'
const PROMOTE_CONTENT = '状态集成测试：这条值得进团队库 ZZZ-PROMOTE-MARKER，因为它是接口契约。'

const env = loadEsTestEnv()

if (!env) {
  test('memory_update_status 集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else if (!isLoopbackUrl(env.url)) {
  test('memory_update_status 集成测试', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
} else {
  defineStatusIntegration(env)
}

function defineStatusIntegration(e: EsTestEnv): void {
  const reader = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.reader })
  const writer = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.writer })
  const embed = createEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024, timeoutMs: 20_000 })

  const saveDeps: SaveDeps = {
    userId: e.userId,
    personalPrefix: 'personal_memory_',
    defaultDomain: MARKER_DOMAIN,
    reader,
    writer,
    embed,
  }
  const deps = { userId: e.userId, personalPrefix: 'personal_memory_', reader, writer }

  let oldId = ''
  let freshId = ''
  let promoteId = ''

  describe('真实实例：状态变更与晋升候选', () => {
    before(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      const [oldDoc, freshDoc, promoteDoc] = await Promise.all([
        saveMemory(saveDeps, { content: OLD_CONTENT, domain: MARKER_DOMAIN, memory_type: 'fact' }),
        saveMemory(saveDeps, { content: FRESH_CONTENT, domain: MARKER_DOMAIN, memory_type: 'fact' }),
        saveMemory(saveDeps, { content: PROMOTE_CONTENT, domain: MARKER_DOMAIN, memory_type: 'decision' }),
      ])
      oldId = oldDoc.memory_id
      freshId = freshDoc.memory_id
      promoteId = promoteDoc.memory_id
      assert.notEqual(oldId, freshId)
    })

    after(async () => {
      await deleteByDomain(e, e.personalIndex, MARKER_DOMAIN)
      const left = await countByDomain(e, e.personalIndex, MARKER_DOMAIN)
      assert.equal(left, 0, `清理后仍有 ${left} 条残留`)
    })

    test('supersede：旧文档下架 + 新文档回填 supersedes（双写都落到库里）', async () => {
      const result = await updateStatus(deps, {
        memory_id: oldId,
        action: 'supersede',
        replacement_memory_id: freshId,
        reason: '口径改名',
      })
      assert.equal(result.status, 'superseded')
      assert.equal(result.changed, true)

      const oldDoc = await reader.get(e.personalIndex, oldId)
      assert.equal(oldDoc.source.status, 'superseded')
      assert.equal(oldDoc.source.superseded_by, freshId)

      const freshDoc = await reader.get(e.personalIndex, freshId)
      assert.equal(freshDoc.source.supersedes, oldId)
      assert.equal(freshDoc.source.status, 'active')
    })

    test('被取代的旧版本不再出现在默认检索里（status=active 过滤生效）', async () => {
      const result = await reader.search(
        e.personalIndex,
        bm25Body('ZZZ-OLD-MARKER', { domain: MARKER_DOMAIN }, 5),
      )
      assert.equal(result.hits.some((hit) => hit.id === oldId), false, 'superseded 不该被检索到')

      // 用审计形态（status=null）能翻出来，证明是过滤生效而不是文档丢了
      const audit = await reader.search(
        e.personalIndex,
        bm25Body('ZZZ-OLD-MARKER', { status: null, domain: MARKER_DOMAIN }, 5),
      )
      assert.equal(audit.hits.some((hit) => hit.id === oldId), true)
    })

    test('expire：状态变过期，检索也不再返回', async () => {
      const result = await updateStatus(deps, { memory_id: freshId, action: 'expire', reason: '已作废' })
      assert.equal(result.status, 'expired')

      const doc = await reader.get(e.personalIndex, freshId)
      assert.equal(doc.source.status, 'expired')

      const search = await reader.search(
        e.personalIndex,
        bm25Body('ZZZ-FRESH-MARKER', { domain: MARKER_DOMAIN }, 5),
      )
      assert.equal(search.hits.some((hit) => hit.id === freshId), false)
    })

    test('promote：只置 candidate，团队库一条都不写', async () => {
      const result = await promoteMemory(deps, { memory_id: promoteId, reason: '接口契约值得共享' })
      assert.equal(result.promote_state, 'candidate')
      assert.equal(result.changed, true)

      const doc = await reader.get(e.personalIndex, promoteId)
      assert.equal(doc.source.promote_state, 'candidate')
      assert.equal(doc.source.status, 'active', 'promote 不改状态')

      // promote 只改个人库：团队库里不该出现任何以这条记忆为来源的条目。
      // 注意别断言「整个团队索引为空」——别的测试文件（整理任务）会往团队库写东西，
      // 那种断言会在串行跑测试时假红（2026-10-25 踩到）。
      const team = await reader.search(e.teamIndex, {
        size: 1,
        _source: { excludes: ['embedding'] },
        query: { term: { source_memory_id: promoteId } },
      })
      assert.equal(team.total, 0, 'promote 不能写团队库')
    })

    test('再 promote 一次：已经是 candidate，ES 返回 noop 或 updated，但结果仍是 candidate', async () => {
      const again = await promoteMemory(deps, { memory_id: promoteId })
      assert.equal(again.promote_state, 'candidate')
    })

    test('不存在的 memory_id → 友好报错，不抛 ES 原文', async () => {
      await assert.rejects(
        updateStatus(deps, { memory_id: 'no-such-memory-id', action: 'expire' }),
        /找不到记忆/,
      )
    })
  })
}
