/**
 * 直写路径的来源戳（origin）。
 *
 * 2026-11-04 巡检发现：`origin` 只在 saveMemory 主路径写，traits/persona/journal/mood
 * 四个直写点全部缺字段 → 审计时「谁写的」这一列在这四类文档上永远是空的
 * （实测 identity=32 条缺 origin，正是 traits 直写的）。
 *
 * 四个写入入口都是导出函数，用假 writer 捕获 doc 直接断言。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { writeTraitCandidate } from '../src/memory/traits.ts'
import { writePersonaCandidate } from '../src/memory/persona.ts'
import { writeJournal } from '../src/journal.ts'
import { writeMood } from '../src/memory/mood.ts'

/** 假 writer：捕获最后一次写入的 doc */
function capturingWriter() {
  const written: Array<{ index: string; doc: Record<string, unknown> }> = []
  return {
    written,
    writer: {
      index: async (index: string, doc: Record<string, unknown>) => {
        written.push({ index, doc })
        return { id: String(doc.memory_id ?? 'x'), result: 'created', status: 201 }
      },
    },
  }
}

const baseDeps = {
  userId: 'xqh',
  personalPrefix: 'personal_memory_',
  reader: { search: async () => ({ hits: [], took: 0, total: 0 }) },
}

describe('origin=tool：四个直写点都要带来源戳', () => {
  test('traits 候选（identity）', async () => {
    const { written, writer } = capturingWriter()
    const result = await writeTraitCandidate(
      { ...baseDeps, writer } as never,
      { content: '你倾向于先给结论再解释理由', evidence_ids: ['a1', 'b2'] },
      14,
    )
    assert.equal(result.written, true)
    assert.equal(written.length, 1)
    assert.equal(written[0].doc.origin, 'tool', 'traits 直写缺 origin → 审计时 identity 类查不到来源')
  })

  test('persona 候选', async () => {
    const { written, writer } = capturingWriter()
    const result = await writePersonaCandidate(
      { ...baseDeps, writer } as never,
      { content: '我每次先确认表结构再动代码', evidence: [] },
      [],
      14,
    )
    assert.equal(result.written, true)
    assert.equal(written[0].doc.origin, 'tool')
  })

  test('journal 日记', async () => {
    const { written, writer } = capturingWriter()
    const result = await writeJournal({ ...baseDeps, writer } as never, '2026-11-04', '今天的回顾正文')
    assert.equal(result.written, true)
    assert.equal(written[0].doc.origin, 'tool')
  })

  test('mood 情绪状态文档', async () => {
    const { written, writer } = capturingWriter()
    await writeMood({ ...baseDeps, writer } as never, {
      valence: 0.2,
      arousal: 0.3,
      events: [],
      updatedAt: '2026-11-04T12:00:00.000Z',
    })
    assert.equal(written.length, 1)
    assert.equal(written[0].doc.origin, 'tool')
  })
})
