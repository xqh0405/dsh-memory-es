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

// 2026-11-10 审查 #11：蒸馏改写正文后**必须**同步去重键与标识符字段。
// 旧版 patch 只有 content/summary/keywords/向量 —— 于是 content_exact（标识符精确匹配）
// 永远打在旧正文的 token 上；content_sha256（去重键）与内容脱钩：
// 对蒸馏后正文再 memory_save 不去重（产生副本），对原始正文保存却命中旧 sha 回「已存在」。
test('改写后同步 content_sha256 / content_exact（去重键与正文不能脱钩）', async () => {
  const { normalizeContent, sha256Hex } = await import('../src/fragment.ts')
  const { deps, patches } = fakes({ content: '旧正文', user_id: USER, status: 'active' })
  const rewritten = '改写后：保留 identifier /a/b 与版本 1.2.3'
  await distillMemory(deps, { memory_id: 'm1', content: rewritten })

  const p = patches[0].patch
  assert.equal(p.content_exact, rewritten, '标识符字段必须与新正文同源（否则精确匹配打在旧正文上）')
  assert.equal(
    p.content_sha256,
    sha256Hex(normalizeContent(rewritten)),
    '去重键必须按新正文重算，口径与 buildMemoryDoc 一致（归一化后 sha256）',
  )
  // 不能出现「正文改了、键没改」——那就是把旧 sha 留在了一条内容已变的文档上
  assert.notEqual(p.content_sha256, sha256Hex(normalizeContent('旧正文')), '不能沿用旧正文的 sha')
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

test('改写结果含凭据 → 拒绝写入（准入不能在蒸馏这一步被绕过）', async () => {
  const { deps, patches } = fakes({ content: '原始正文', user_id: USER })
  await assert.rejects(
    () => distillMemory(deps, { memory_id: 'm1', content: '部署口令是 Passw0rd123! 记一下' }),
    /命中写入准入/,
  )
  assert.equal(patches.length, 0, '拒绝了就不该有写入')
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
