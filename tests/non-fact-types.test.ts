/**
 * 「非事实类型」的常量一致性守卫。
 *
 * `NON_FACT_MEMORY_TYPES` 定义在 common.ts（检索与提炼共用），而各模块自己还有
 * IDENTITY/PERSONA/JOURNAL 常量（它们各自是产出物归属的类型）。两处一旦漂移，
 * 检索就会放行某一类本不该出现的记忆——所以在这里把它们钉成同一组。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { JOURNAL_MEMORY_TYPE } from '../src/journal.ts'
import { NON_FACT_MEMORY_TYPES } from '../src/memory/common.ts'
import { PERSONA_MEMORY_TYPE } from '../src/memory/persona.ts'
import { IDENTITY_MEMORY_TYPE } from '../src/memory/save.ts'

describe('非事实类型常量', () => {
  test('common.ts 的集合与三个模块的常量逐一相同（顺序也一致）', () => {
    assert.deepEqual(
      [...NON_FACT_MEMORY_TYPES],
      [IDENTITY_MEMORY_TYPE, PERSONA_MEMORY_TYPE, JOURNAL_MEMORY_TYPE],
    )
  })

  test('三类都不重复、非空', () => {
    assert.equal(new Set(NON_FACT_MEMORY_TYPES).size, NON_FACT_MEMORY_TYPES.length)
    for (const type of NON_FACT_MEMORY_TYPES) assert.ok(type.trim() !== '', '类型名不能为空')
  })
})
