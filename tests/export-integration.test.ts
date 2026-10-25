/**
 * Markdown 镜像集成测试（S10，真 ES）：只导出可检索条目、重跑幂等、已撤回的知识下沉。
 *
 * 这条链最容易"看起来对"：文件确实生成了，但里面混进了 pending/superseded 的条目。
 * 所以断言全走内容级——检查具体哪条在、哪条不在。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { exportMirror, listExportable } from '../consolidate/export.ts'
import { createEsClient } from '../src/es/http.ts'
import { deleteByDomain } from './helpers/es-admin.ts'
import { isLoopbackUrl, loadEsTestEnv, type EsTestEnv } from './helpers/es-env.ts'

const D_A = '__export_it_a'
const D_B = '__export_it_b'

const env = loadEsTestEnv()

if (!env) {
  test('镜像导出集成测试', { skip: '未找到 deploy/es/.env（先跑 scripts/es-up.sh 与 scripts/init-security.sh）' }, () => {})
} else if (!isLoopbackUrl(env.url)) {
  test('镜像导出集成测试', { skip: `es.url=${env.url} 不是本机回环，拒绝写入测试数据` }, () => {})
} else {
  defineExportIntegration(env)
}

function defineExportIntegration(e: EsTestEnv): void {
  const consolidator = createEsClient({ url: e.url, caCertPath: e.caCertPath, ...e.consolidator })
  const deps = { client: consolidator, teamIndex: e.teamIndex, endpoint: e.url }
  let dir = ''

  const seed = async (
    id: string,
    domain: string,
    reviewState: string,
    status: string,
    content: string,
    promotedAt = '2026-10-01T00:00:00Z',
  ): Promise<void> => {
    await consolidator.index(
      e.teamIndex,
      {
        doc_id: id,
        content,
        memory_type: 'fact',
        domain,
        topic_key: `${domain}:${id}`,
        content_sha256: `hash-${id}`,
        source_user: e.userId,
        source_memory_id: `mem-${id}`,
        source_created_at: '2026-10-01T00:00:00Z',
        // 别用 id.length 拼日期：'b-rejected' 会拼出 2026-10-010 这种非法值，ES 直接 400（实测踩过）
        promoted_at: promotedAt,
        status,
        review_state: reviewState,
        updated_at: '2026-10-02T00:00:00Z',
      },
      { id, refresh: 'wait_for' },
    )
  }

  describe('真实实例：Markdown 镜像', () => {
    before(async () => {
      await deleteByDomain(e, e.teamIndex, D_A)
      await deleteByDomain(e, e.teamIndex, D_B)
      dir = mkdtempSync(join(tmpdir(), 'mirror-it-'))
      await seed('a-ok', D_A, 'approved', 'active', 'A 域可导出条目 ZZZ-EXPORT-A。')
      await seed('a-auto', D_A, 'auto', 'active', 'A 域自动通过条目 ZZZ-EXPORT-A2。')
      await seed('a-pending', D_A, 'pending', 'active', 'A 域待裁决条目 ZZZ-EXPORT-PENDING。')
      await seed('b-rejected', D_B, 'rejected', 'rejected', 'B 域已驳回条目 ZZZ-EXPORT-REJECT。')
    })

    after(async () => {
      await deleteByDomain(e, e.teamIndex, D_A)
      await deleteByDomain(e, e.teamIndex, D_B)
      rmSync(dir, { recursive: true, force: true })
    })

    test('listExportable 只取 active 且 auto/approved', async () => {
      const docs = await listExportable(deps)
      const ids = docs.map((doc) => doc.doc_id)
      assert.equal(ids.includes('a-ok'), true)
      assert.equal(ids.includes('a-auto'), true)
      assert.equal(ids.includes('a-pending'), false, 'pending 不能进镜像（检索也查不到）')
      assert.equal(ids.includes('b-rejected'), false, 'rejected 不能进镜像')
    })

    test('导出后文件内容正确、带来源，且不含 pending/rejected 的正文', async () => {
      const result = await exportMirror(deps, { outDir: dir })
      assert.equal(result.files.some((file) => file.domain === D_A), true)
      assert.equal(result.files.some((file) => file.domain === D_B), false, 'B 域没有可导出条目')

      const fileA = readFileSync(join(dir, `${D_A}.md`), 'utf8')
      assert.match(fileA, /A 域可导出条目 ZZZ-EXPORT-A/)
      assert.match(fileA, /A 域自动通过条目 ZZZ-EXPORT-A2/)
      assert.match(fileA, new RegExp(`来源：${e.userId} / \`mem-a-ok\``))
      assert.equal(fileA.includes('ZZZ-EXPORT-PENDING'), false)
      assert.equal(fileA.includes('ZZZ-EXPORT-REJECT'), false)

      const index = readFileSync(join(dir, 'INDEX.md'), 'utf8')
      assert.match(index, new RegExp(`\\| ${D_A} \\| 2 \\|`))
    })

    test('重跑幂等：条目数不变、没有重复段落', async () => {
      await exportMirror(deps, { outDir: dir })
      const md = readFileSync(join(dir, `${D_A}.md`), 'utf8')
      const sections = md.split('\n').filter((line) => line.startsWith('## '))
      assert.equal(sections.length, 2, '两条就是两条，不能因为重跑翻倍')
    })

    test('撤回后重跑：内容下沉、空 domain 的旧文件被清掉', async () => {
      // 把 A 域一条撤回（superseded），B 域补一条可导出的
      await consolidator.update(
        e.teamIndex,
        'a-auto',
        { status: 'superseded', updated_at: '2026-10-05T00:00:00Z' },
        { refresh: 'wait_for' },
      )
      await seed('b-ok', D_B, 'approved', 'active', 'B 域可导出条目 ZZZ-EXPORT-B。')
      await exportMirror(deps, { outDir: dir })

      const fileA = readFileSync(join(dir, `${D_A}.md`), 'utf8')
      assert.equal(fileA.includes('ZZZ-EXPORT-A2'), false, '撤回的条目要从镜像里消失')
      assert.equal(fileA.includes('ZZZ-EXPORT-A'), true)

      // 再把 A 域整域撤回 → 下次导出应删掉这个文件
      await consolidator.update(
        e.teamIndex,
        'a-ok',
        { status: 'superseded', updated_at: '2026-10-06T00:00:00Z' },
        { refresh: 'wait_for' },
      )
      const result = await exportMirror(deps, { outDir: dir })
      assert.equal(existsSync(join(dir, `${D_A}.md`)), false, '空 domain 的旧文件必须被清掉')
      assert.deepEqual(result.pruned, [`${D_A}.md`])
      assert.equal(existsSync(join(dir, `${D_B}.md`)), true)
    })
  })
}
