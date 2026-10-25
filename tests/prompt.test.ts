/**
 * 系统提示片段单测。提示词本身没法「断言模型会照做」，但能钉住三类会真出事的东西：
 *
 *  1. **不能出现 `{{` / `}}`**——宿主对段文本做变量插值，未知引用会让整个提示词组装失败，
 *     表现是「模型这一步连提示词都收不到」，比少一句话严重得多；
 *  2. **顺序要落在工具引导之后、生成的 SDK 之前**——否则模型先看到函数签名再看到策略；
 *  3. **四个工具名与四个决策点必须点到**——写漏了模型就不知道有这个能力。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  MEMORY_PROMPT,
  MEMORY_PROMPT_SECTION,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
} from '../src/prompt.ts'

describe('MEMORY_PROMPT', () => {
  test('不含 {{ }} —— 未注册的变量引用会让整份提示词组装失败', () => {
    assert.equal(MEMORY_PROMPT.includes('{{'), false)
    assert.equal(MEMORY_PROMPT.includes('}}'), false)
  })

  test('长度克制（100~1500 字符）：提示词是每一步都要付的上下文成本', () => {
    assert.ok(MEMORY_PROMPT.length >= 100, `太短了：${MEMORY_PROMPT.length}`)
    assert.ok(MEMORY_PROMPT.length <= 1500, `太长了：${MEMORY_PROMPT.length}`)
  })

  test('点到四个工具名', () => {
    for (const tool of ['memory_save', 'memory_search', 'memory_update_status', 'memory_promote']) {
      assert.ok(MEMORY_PROMPT.includes(tool), `提示词里没提到 ${tool}`)
    }
  })

  test('四个决策点都在：何时存 / 何时不存 / 何时查 / 怎么修正', () => {
    assert.match(MEMORY_PROMPT, /什么时候存/)
    assert.match(MEMORY_PROMPT, /什么时候不存/)
    assert.match(MEMORY_PROMPT, /什么时候查/)
    assert.match(MEMORY_PROMPT, /修正而不是覆盖/)
  })

  test('明确禁止“反复查”与“靠重复写入覆盖”，这两条是最容易发生的误用', () => {
    assert.match(MEMORY_PROMPT, /最多查一次/)
    assert.match(MEMORY_PROMPT, /不要靠重复写同内容/)
  })
})

describe('段注册参数', () => {
  test('name 稳定、order 落在工具引导（≤3100）之后与生成的 SDK（5000）之前', () => {
    assert.equal(PROMPT_SECTION_NAME, 'dsh-memory-es')
    assert.ok(PROMPT_SECTION_ORDER > 3100, '应在 MCP_SERVERS(3100) 之后')
    assert.ok(PROMPT_SECTION_ORDER < 5000, '应在 TOOLS_SDK(5000) 之前')
  })

  test('段对象与常量一致（避免两处各写一份）', () => {
    assert.deepEqual(MEMORY_PROMPT_SECTION, {
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: MEMORY_PROMPT,
    })
  })
})
