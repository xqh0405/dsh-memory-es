/**
 * `memory_get`（阶段 12 分级读取的展开动作）。
 *
 * 三条硬约束：
 *  1. 按 id 取到就回全文（含 summary / 反馈计数）；
 *  2. 不存在或**不属于本用户**的 id → 进 `missing`，绝不返回别人的内容（F3）；
 *  3. 一条坏 id 不能毁掉整批（这是它和 `loadOwnedDoc` 的区别）。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createEsClient } from '../src/es/http.ts'
import { getMemories, MAX_GET_IDS, type GetDeps } from '../src/memory/get.ts'
import { sendJson, startFakeEs, type FakeEs } from './helpers/fake-es.ts'

const INDEX = 'personal_memory_xqh'

function startGetFake(docs: Record<string, Record<string, unknown>>, options: { failWith?: number } = {}) {
  return startFakeEs((req, res) => {
    if (req.method === 'GET' && req.path.includes('/_doc/')) {
      const id = decodeURIComponent(req.path.split('/_doc/')[1] ?? '')
      if (options.failWith !== undefined) {
        sendJson(res, options.failWith, { error: { type: 'boom', reason: 'boom' } })
        return
      }
      const source = docs[id]
      if (source === undefined) {
        sendJson(res, 404, { _index: INDEX, _id: id, found: false })
        return
      }
      sendJson(res, 200, { _index: INDEX, _id: id, found: true, _source: source })
      return
    }
    sendJson(res, 400, { error: { type: 'bad_request', reason: `unhandled ${req.method} ${req.path}` } })
  })
}

function makeDeps(fake: FakeEs): GetDeps {
  return {
    userId: 'xqh',
    personalPrefix: 'personal_memory_',
    reader: createEsClient({ url: fake.url, username: 'r', password: 'r' }),
  }
}

describe('getMemories', () => {
  test('按 id 取全文，带上 summary / 反馈计数', async () => {
    const fake = await startGetFake({
      m1: {
        memory_id: 'm1',
        user_id: 'xqh',
        content: '北单同步要逐位对拍赔率列',
        summary: '一句话摘要',
        memory_type: 'fact',
        domain: 'lottery-cloud',
        updated_at: '2026-10-01T00:00:00.000Z',
        status: 'active',
        origin: 'agent',
        confirmed_use: 3,
        corrections: 1,
      },
    })
    try {
      const result = await getMemories(makeDeps(fake), { memory_ids: ['m1'] })
      assert.equal(result.hits.length, 1)
      assert.equal(result.hits[0]?.content, '北单同步要逐位对拍赔率列')
      assert.equal(result.hits[0]?.summary, '一句话摘要')
      assert.equal(result.hits[0]?.confirmed_use, 3)
      assert.equal(result.missing.length, 0)
      assert.match(result.text, /北单同步/)
    } finally {
      await fake.close()
    }
  })

  test('不存在的 id 进 missing，整批仍然成功', async () => {
    const fake = await startGetFake({ m1: { memory_id: 'm1', user_id: 'xqh', content: '一条事实' } })
    try {
      const result = await getMemories(makeDeps(fake), { memory_ids: ['m1', 'ghost'] })
      assert.equal(result.hits.length, 1)
      assert.deepEqual(result.missing, ['ghost'])
      assert.match(result.text, /没找到：ghost/)
    } finally {
      await fake.close()
    }
  })

  test('不属于本用户的 id → missing，且绝不返回其正文', async () => {
    const fake = await startGetFake({
      other: { memory_id: 'other', user_id: 'someone-else', content: '别人的秘密' },
    })
    try {
      const result = await getMemories(makeDeps(fake), { memory_ids: ['other'] })
      assert.equal(result.hits.length, 0)
      assert.equal(result.missing.includes('other'), true)
      assert.ok(!result.text.includes('别人的秘密'), `泄露了别人的内容：${result.text}`)
    } finally {
      await fake.close()
    }
  })

  test('重复 id 只取一次', async () => {
    const fake = await startGetFake({ m1: { memory_id: 'm1', user_id: 'xqh', content: '一条事实' } })
    try {
      const result = await getMemories(makeDeps(fake), { memory_ids: ['m1', 'm1'] })
      assert.equal(result.hits.length, 1)
    } finally {
      await fake.close()
    }
  })

  test('空列表 / 超过上限直接报错（不静默截断）', async () => {
    const fake = await startGetFake({})
    try {
      await assert.rejects(() => getMemories(makeDeps(fake), { memory_ids: [] }), /不能为空/)
      await assert.rejects(
        () =>
          getMemories(makeDeps(fake), {
            memory_ids: Array.from({ length: MAX_GET_IDS + 1 }, (_, i) => `m${i}`),
          }),
        /最多/,
      )
    } finally {
      await fake.close()
    }
  })

  test('其余 ES 错误照抛（不能把故障当成「没找到」）', async () => {
    const fake = await startGetFake({}, { failWith: 500 })
    try {
      await assert.rejects(() => getMemories(makeDeps(fake), { memory_ids: ['m1'] }), /boom|500/)
    } finally {
      await fake.close()
    }
  })
})
