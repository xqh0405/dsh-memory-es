/**
 * 阶段 9.3：人格表层学习。
 *
 * 两个最容易出错的地方，各用一组测试钉住：
 *  1. **素材抽取**：会话日志里混着系统注入（runtime context、技能清单）——
 *     只认 `source.kind === 'user'`，否则会把系统文本当成"用户在纠正我"；
 *  2. **输出校验**：模型很爱引用不存在的片段编号，证据全假的条目必须整条丢弃。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildPersonaPrompt,
  extractFromSessionLog,
  parsePersonaOutput,
  PERSONA_MAX_CHARS,
  PERSONA_MAX_OUTPUT,
} from '../src/memory/persona.ts'
import { buildPersonaSection } from '../src/prompt.ts'

/** 造一行会话事件 */
function line(type: string, data: unknown): string {
  return JSON.stringify({ type, data })
}

const ASSISTANT_TEXT =
  '我先把这次的改动分成两步来做：第一步确认表结构和索引，第二步再动代码。'
  + '这样即使中途出了岔子，也能干净地回退到原状态，不会留下半截的改动。'

describe('extractFromSessionLog：只取真人对话', () => {
  test('配对我的回复 + 你随后的话，且不含 reasoning', () => {
    const log = [
      line('assistant/message', {
        message: { content: [{ type: 'reasoning', text: '这里是思考过程不应被取到' }, { type: 'text', text: ASSISTANT_TEXT }] },
      }),
      line('tool/call', { name: 'bash' }),
      line('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '不对，应该先看表结构' }] }),
    ].join('\n')
    const out = extractFromSessionLog(log, 'sess-1')
    assert.equal(out.length, 1)
    assert.equal(out[0]?.assistant, ASSISTANT_TEXT)
    assert.equal(out[0]?.feedback, '不对，应该先看表结构')
    assert.ok(!out[0]?.assistant.includes('思考过程'), 'reasoning 不能混进素材')
  })

  test('系统注入的用户消息不算反馈（source.kind 不是 user）', () => {
    const log = [
      line('assistant/message', { message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } }),
      line('user/message', { source: { kind: 'runtime' }, content: [{ type: 'text', text: 'Current runtime context...' }] }),
    ].join('\n')
    assert.equal(extractFromSessionLog(log, 'sess-1').length, 0)
  })

  test('我的回复太短时不成对（没信息量）', () => {
    const log = [
      line('assistant/message', { message: { content: [{ type: 'text', text: '好的' }] } }),
      line('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }),
    ].join('\n')
    assert.equal(extractFromSessionLog(log, 'sess-1').length, 0)
  })

  test('坏行跳过而不是整体失败', () => {
    const log = [
      '{ 不是 json',
      line('assistant/message', { message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } }),
      'x',
      line('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '嗯，继续' }] }),
    ].join('\n')
    assert.equal(extractFromSessionLog(log, 'sess-1').length, 1)
  })
})

describe('parsePersonaOutput：候选校验', () => {
  const refs = new Set(['s0', 's1'])

  test('正常 JSON 数组', () => {
    const out = parsePersonaOutput('[{"content":"我习惯先给结论","evidence":["s0"]}]', refs)
    assert.equal(out.length, 1)
    assert.equal(out[0]?.content, '我习惯先给结论')
    assert.deepEqual(out[0]?.evidence, ['s0'])
  })

  test('容忍 ```json 围栏与前后废话', () => {
    const out = parsePersonaOutput('好的：\n```json\n[{"content":"我倾向先验证","evidence":["s1"]}]\n```\n以上。', refs)
    assert.equal(out.length, 1)
  })

  test('引用不存在的片段整条丢弃（不裁证据放行）', () => {
    assert.equal(parsePersonaOutput('[{"content":"我习惯x","evidence":["s99"]}]', refs).length, 0)
  })

  test('没有证据的条目丢弃', () => {
    assert.equal(parsePersonaOutput('[{"content":"我习惯x","evidence":[]}]', refs).length, 0)
  })

  test('超长内容丢弃', () => {
    const long = 'x'.repeat(PERSONA_MAX_CHARS + 1)
    assert.equal(parsePersonaOutput(JSON.stringify([{ content: long, evidence: ['s0'] }]), refs).length, 0)
  })

  test(`一次最多 ${PERSONA_MAX_OUTPUT} 条`, () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ content: `倾向${i}`, evidence: ['s0'] }))
    assert.equal(parsePersonaOutput(JSON.stringify(many), refs).length, PERSONA_MAX_OUTPUT)
  })

  test('空数组与不可解析都返回空', () => {
    assert.equal(parsePersonaOutput('[]', refs).length, 0)
    assert.equal(parsePersonaOutput('{ 坏 json', refs).length, 0)
  })
})

describe('buildPersonaPrompt', () => {
  test('带上片段编号与两边的原话', () => {
    const prompt = buildPersonaPrompt(
      [{ ref: 's0', session: 'sess', assistant: '我说的话', feedback: '对方回的' }],
      7,
    )
    assert.match(prompt, /最近 7 天/)
    assert.ok(prompt.includes('### [s0]'))
    assert.ok(prompt.includes('【我的发言】我说的话'))
    assert.ok(prompt.includes('【用户的回复】对方回的'))
  })
})

describe('buildPersonaSection：内核 + 表层', () => {
  test('只有内核', () => {
    assert.match(buildPersonaSection('我是昔涟。', true), /^# 我的人格\n\n我是昔涟。$/)
  })

  test('只有表层（没写 seed 也能输出）', () => {
    const out = buildPersonaSection('', true, ['我习惯先给结论'])
    assert.ok(out.includes('# 我的人格'))
    assert.ok(out.includes('## 我学到的倾向'))
    assert.ok(out.includes('- 我习惯先给结论'))
  })

  test('两层都有时按顺序拼接', () => {
    const out = buildPersonaSection('我是昔涟。', true, ['我习惯先给结论'])
    const seedAt = out.indexOf('我是昔涟。')
    const listAt = out.indexOf('## 我学到的倾向')
    assert.ok(seedAt > 0 && listAt > seedAt, '内核在前、表层在后')
  })

  test('两层都空时不注入', () => {
    assert.equal(buildPersonaSection('  ', true, []), '')
    assert.equal(buildPersonaSection('', false, ['我习惯x']), '')
  })

  test('表层里的 {{ }} 也会被转义（否则整段提示词组装失败）', () => {
    const out = buildPersonaSection('', true, ['我用 {{x}} 占位'])
    assert.ok(!out.includes('{{'))
  })
})

describe('parsePersonaOutput：证据字段名宽容', () => {
  test('模型写成 evidence_ids 也接受（实测踩过：明明输出正确却整批丢弃）', () => {
    const refs = new Set(['s0', 's4'])
    const out = parsePersonaOutput(
      '[{"content":"我倾向先给结论","evidence_ids":["s0","s4"]}]',
      refs,
    )
    assert.equal(out.length, 1)
    assert.deepEqual(out[0]?.evidence, ['s0', 's4'])
  })
})

describe('parsePersonaOutput：人称归一', () => {
  /**
   * 模型有很强的惯性：不管提示怎么写，它都用「你」指代被描述者（证据却逐条指向我的发言）。
   * 与其反复收紧校验把候选全丢光，不如把代词归一后交给人工审核把关。
   */
  test('「你」替换成「我」', () => {
    const refs = new Set(['s0'])
    const out = parsePersonaOutput(
      JSON.stringify([
        { content: '你习惯先给出结论，再展开依据', evidence: ['s0'] },
        { content: '你会先验证再下结论', evidence: ['s0'] },
      ]),
      refs,
    )
    assert.equal(out.length, 2)
    assert.equal(out[0]?.content, '我习惯先给出结论，再展开依据')
    assert.equal(out[1]?.content, '我会先验证再下结论')
  })

  test('无人称描述补上「我」；已写「我」的不重复加', () => {
    const refs = new Set(['s0'])
    const out = parsePersonaOutput(
      JSON.stringify([
        { content: '习惯先给结论', evidence: ['s0'] },
        { content: '我倾向于先验证再下结论', evidence: ['s0'] },
        { content: '交付时我会给出可复跑的验收证据', evidence: ['s0'] },
      ]),
      refs,
    )
    assert.equal(out.length, 3)
    assert.equal(out[0]?.content, '我习惯先给结论')
    assert.equal(out[1]?.content, '我倾向于先验证再下结论')
    assert.equal(out[2]?.content, '交付时我会给出可复跑的验收证据')
  })

  test('「你我」相邻时不会变成「我我」', () => {
    const refs = new Set(['s0'])
    const out = parsePersonaOutput(
      JSON.stringify([{ content: '你我都不该跳过验证', evidence: ['s0'] }]),
      refs,
    )
    assert.equal(out[0]?.content, '我都不该跳过验证')
  })
})
