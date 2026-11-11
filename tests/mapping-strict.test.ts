/**
 * `dynamic:strict` 回归（2026-11-11 审查 #31）。
 *
 * 两件事：
 *  ① 闸本身必须会响 —— 写一个映射外字段，fake-es 要回真 ES 同形的 400；
 *  ② **验收**：`buildMemoryDoc` 的输出字段必须 ⊆ 个人库映射。
 *     谁给它加一个模板里没有的字段，这条测试立刻红 —— 历史 19 个字段缺口
 *     就是「代码加了字段、模板没跟上」这么漏的。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildMemoryDoc } from '../src/memory/save.ts'
import { createEsClient } from '../src/es/http.ts'
import { sendJson, startFakeEs } from './helpers/fake-es.ts'
import { propertiesFor, strictViolations } from './helpers/mapping-gate.ts'

const INDEX = 'personal_memory_xqh'

describe('dynamic:strict 写入闸', () => {
  test('模板能被解析出来（闸的前提；ruleCount=0 说明解析坏了）', () => {
    const personal = propertiesFor(INDEX)
    assert.ok(personal !== undefined, '个人库模板必须解析得到')
    assert.ok(personal.size >= 50, `个人库字段数异常：${personal.size}（模板里是 51）`)
    assert.ok(propertiesFor('team_knowledge') !== undefined, '团队库（裸 mapping）也要解析得到')
    assert.equal(propertiesFor('no_such_index_zzz'), undefined, '未知索引不判（宁可漏判不误杀）')
  })

  test('造坏字段 → 闸报出缺失字段；合法字段不误杀', () => {
    assert.deepEqual(strictViolations(INDEX, { content: 'x', content_exact: 'x' }), [])
    assert.deepEqual(strictViolations(INDEX, { content: 'x', not_a_field: 1 }), ['not_a_field'])
  })

  test('fake-es 对映射外字段回真 ES 同形的 400（正向对照：闸会响）', async () => {
    const fake = await startFakeEs((_req, res) => sendJson(res, 200, { result: 'created' }))
    try {
      const client = createEsClient({ url: fake.url, username: 'u', password: 'p' })
      await assert.rejects(
        // 故意写映射外字段 —— 这正是闸要拦的
        client.index(INDEX, { content: 'x', not_a_field: 1 } as never, { id: 'doc-1' }),
        (err: unknown) => {
          const e = err as { status?: number; esType?: string; message?: string }
          assert.equal(e.status, 400, `应为 400，实际 ${String(e.message).slice(0, 160)}`)
          assert.equal(e.esType, 'strict_dynamic_mapping_exception')
          assert.match(String(e.message), /not_a_field/)
          return true
        },
      )
      // 合法字段必须能写进去（闸不能拦对的东西）
      await client.index(INDEX, { content: 'x', content_exact: 'x' } as never, { id: 'doc-2' })
    } finally {
      await fake.close()
    }
  })

  test('验收：buildMemoryDoc 的输出字段 ⊆ 个人库映射', () => {
    const props = propertiesFor(INDEX)
    assert.ok(props !== undefined)
    // 签名是 (input, deps, options) —— 别写反；options 还必须带 embedding
    const { doc } = buildMemoryDoc(
      { content: '验收样本：北单中断开奖要同时写 win_price 与 win_price_practical。' },
      { userId: 'xqh', personalPrefix: 'personal_memory_', defaultDomain: 'general' },
      { now: new Date('2026-11-11T00:00:00.000Z'), memoryId: 'm-test', embedding: null },
    )
    const extra = Object.keys(doc).filter((k) => !props.has(k))
    assert.deepEqual(
      extra,
      [],
      `buildMemoryDoc 写了映射里没有的字段：${extra.join(', ')}`
      + ' —— 真 ES 会 strict_dynamic_mapping_exception 400，整条 memory_save 失败。'
      + '要么把字段加进 scripts/init-indices.sh 的个人库模板，要么别写它',
    )
  })
})
