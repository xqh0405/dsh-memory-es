/**
 * 提示词段的**真实组装**测试：挂宿主真实的 `SystemPrompt` 服务，跑一次 assemble + renderPrompt。
 *
 * 为什么值得单独一个文件：字符串检查只能证明「文本里没有花括号」，证明不了「组装不会炸」。
 * 宿主的失败方式是**整份提示词组装失败**（模型这一步连提示词都收不到），所以要在真服务上走一遍。
 * 顺带用一条反例把这类失败钉住：带未注册变量引用的段会让 assemble 直接抛。
 *
 * 依赖 `scripts/link-deps.sh` 把 `@deepseek-ai/dsh-system-prompt` 链进 node_modules；
 * 没链上时整个文件 skip 并打印原因（不静默变绿）。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type * as SpModule from '@deepseek-ai/dsh-system-prompt'

import { MEMORY_PROMPT, MEMORY_PROMPT_SECTION } from '../src/prompt.ts'

let sp: (typeof SpModule & { default: unknown }) | null = null
try {
  sp = (await import('@deepseek-ai/dsh-system-prompt')) as typeof SpModule & { default: unknown }
} catch {
  sp = null
}

const skip = sp === null ? '未链接宿主包 @deepseek-ai/dsh-system-prompt（先跑 scripts/link-deps.sh）' : false

/** cordis 的 plugin() 签名对 config 有泛型约束；测试里只用默认配置，做个薄封装 */
async function mountPromptService(ctx: Context): Promise<void> {
  const mount = ctx.plugin as unknown as (plugin: unknown, config?: unknown) => Promise<void>
  await mount(sp?.default, {})
}

describe('真实 SystemPrompt 组装', () => {
  test('挂载服务 → 注册段 → assemble/renderPrompt 成功，且正文原样出现在提示词里', { skip }, async () => {
    assert.ok(sp)
    const ctx = new Context()
    await mountPromptService(ctx)
    ctx.systemPrompt.section(MEMORY_PROMPT_SECTION)

    const assembly = await ctx.systemPrompt.assemble()
    const rendered = sp.renderPrompt(assembly)

    assert.ok(rendered.length > MEMORY_PROMPT.length, '渲染结果应包含我们的段加上其他段')
    assert.equal(rendered.includes(MEMORY_PROMPT), true, '没有插值时段文本应原样出现')
    assert.equal(rendered.includes('memory_search'), true)
  })

  test('反例：段里写未注册的变量引用会让 assemble 直接抛（这正是我们禁止花括号的原因）', { skip }, async () => {
    assert.ok(sp)
    const ctx = new Context()
    await mountPromptService(ctx)
    ctx.systemPrompt.section({ name: 'probe-bad', order: 1, text: '引用了不存在的变量 {{no_such_variable}}' })

    await assert.rejects(async () => {
      const assembly = await ctx.systemPrompt.assemble()
      sp.renderPrompt(assembly)
    })
  })

  test('同名段重复注册会抛（名字是全局唯一的）', { skip }, async () => {
    assert.ok(sp)
    const ctx = new Context()
    await mountPromptService(ctx)
    ctx.systemPrompt.section(MEMORY_PROMPT_SECTION)
    assert.throws(() => ctx.systemPrompt.section(MEMORY_PROMPT_SECTION))
  })
})
