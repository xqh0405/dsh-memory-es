/**
 * memory_distill 的单测（不需要真 ES）：蒸馏是"改写 + 补索引信息 + 重建向量"，
 * 用假 reader/writer 把契约钉住，防止以后改坏（尤其是"别忘了重算 embedding"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { distillMemory, MAX_DISTILLED_CHARS } = await import('../src/memory/distill.ts')

const USER = 'xqh'
const INDEX = 'personal_memory_xqh'

function fakes(doc, opts = {}) {
  const patches = []
  return {
    patches,
    deps: {
      userId: USER,
      personalPrefix: 'personal_memory_',
      reader: {
        async get(index, id) {
          assert.equal(index, INDEX)
          if (opts.notFound) {
            const err = new Error('not found')
            err.kind = 'not_found'
            err.name = 'EsError'
            throw err
          }
          return { id, source: doc }
        },
      },
      writer: {
        async update(index, id, patch) {
          patches.push({ index, id, patch })
          return { result: 'updated' }
        },
      },
      embed: opts.embed === undefined ? { async embed() { return [0.1, 0.2, 0.3] } } : opts.embed,
      now: () => new Date('2026-10-26T00:00:00Z'),
    },
  }
}

test('正常改写：写 content/summary/keywords、标 done、重建向量', async () => {
  const { deps, patches } = fakes({ content: '原来那段很长的原文', user_id: USER, status: 'active', promote_state: 'none' })
  const result = await distillMemory(deps, {
    memory_id: 'm1',
    content: '改写后：保留全部关键信息（含数字 42、路径 /a/b、版本 1.2.3）',
    summary: '一句话摘要',
    keywords: ['关键词A', '关键词B'],
    topic_key: 'deploy',
  })
  assert.equal(result.distill_state, 'done')
  assert.equal(result.changed, true)
  assert.equal(patches.length, 1)
  const p = patches[0].patch
  assert.equal(p.distill_state, 'done')
  assert.equal(p.summary, '一句话摘要')
  assert.deepEqual(p.semantic_keywords, ['关键词A', '关键词B'])
  assert.equal(p.topic_key, 'deploy')
  assert.equal(p.embedding.length, 3, '正文变了就必须重算向量，否则检索永远匹配旧原文')
  assert.ok(String(p.content).includes('/a/b'), '数字/路径这类信息不能被"提炼"掉')
})

test('content 为空直接拒绝（蒸馏是改写，不是清空）', async () => {
  const { deps } = fakes({ content: 'x', user_id: USER })
  await assert.rejects(() => distillMemory(deps, { memory_id: 'm1', content: '   ' }), /content 不能为空/)
})

test('超过上限拒绝（提炼不该变长）', async () => {
  const { deps } = fakes({ content: 'x', user_id: USER })
  await assert.rejects(
    () => distillMemory(deps, { memory_id: 'm1', content: 'a'.repeat(MAX_DISTILLED_CHARS + 1) }),
    /超过上限/,
  )
})

test('embedding 不可用时降级：仍然写成 done，但不写 embedding', async () => {
  const { deps, patches } = fakes({ content: '原文', user_id: USER }, { embed: { async embed() { throw new Error('ollama down') } } })
  const result = await distillMemory(deps, { memory_id: 'm1', content: '改写后的内容' })
  assert.equal(result.distill_state, 'done')
  assert.equal(patches[0].patch.embedding, undefined)
})

test('找不到记忆时报错（不能静默成功）', async () => {
  const { deps } = fakes({}, { notFound: true })
  await assert.rejects(() => distillMemory(deps, { memory_id: 'nope', content: '改写' }))
})
