/**
 * 阶段 14：人设双档（lite / full）与工程纪律段。
 *
 * 重点在三条：
 *  - **向后兼容**：没写任何标记的老预设必须原样输出，不能因为加了档位就变样；
 *  - **不静默丢内容**：标记不成对时保留原文并报 warning，宁可多给几个字；
 *  - **元数据不进提示词**：frontmatter 与所有 HTML 注释必须剥干净，一条都不能漏。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyPersonaTier,
  buildDisciplineSection,
  buildPersonaSection,
  PERSONA_DISCIPLINE_PROMPT,
} from '../src/prompt.ts'

const SOURCE = [
  '---',
  'id: demo',
  'tier_default: lite',
  '---',
  '',
  '【身份】',
  '我是演示角色。',
  '',
  '【声音】',
  '1. 两档共享的规则。',
  '<!-- lite:skip -->',
  '2. 只有细腻版才写的长解释。',
  '<!-- /lite:skip -->',
  '<!-- lite:only -->',
  '【精简】一句。',
  '<!-- /lite:only -->',
].join('\n')

describe('applyPersonaTier：档位渲染', () => {
  test('lite 档删掉 lite:skip，保留 lite:only', () => {
    const { body, warnings } = applyPersonaTier(SOURCE, 'lite')
    assert.match(body, /两档共享的规则/)
    assert.doesNotMatch(body, /只有细腻版才写的长解释/)
    assert.match(body, /【精简】/)
    assert.deepEqual(warnings, [])
  })

  test('full 档相反：保留 lite:skip，删掉 lite:only', () => {
    const { body } = applyPersonaTier(SOURCE, 'full')
    assert.match(body, /只有细腻版才写的长解释/)
    assert.doesNotMatch(body, /【精简】/)
    assert.match(body, /两档共享的规则/)
  })

  test('frontmatter 与注释都不进正文', () => {
    for (const tier of ['lite', 'full'] as const) {
      const { body } = applyPersonaTier(SOURCE, tier)
      assert.doesNotMatch(body, /tier_default/, `${tier} 档漏了 frontmatter`)
      assert.doesNotMatch(body, /<!--/, `${tier} 档漏了注释`)
      assert.doesNotMatch(body, /-->/, `${tier} 档漏了注释尾巴`)
    }
  })

  test('没有任何标记的老预设：两档都原样输出（向后兼容）', () => {
    const legacy = '我是老格式的人设，\n没有任何标记。'
    for (const tier of ['lite', 'full'] as const) {
      const { body, warnings } = applyPersonaTier(legacy, tier)
      assert.equal(body, legacy)
      assert.deepEqual(warnings, [])
    }
  })

  test('标记不成对时保留原文并报 warning，不静默吞内容', () => {
    const broken = '开头\n<!-- lite:skip -->\n没闭合的长内容\n'
    const { body, warnings } = applyPersonaTier(broken, 'lite')
    assert.match(body, /没闭合的长内容/, '不成对时内容必须留下')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /不成对/)
  })

  test('只有空白的人设渲染后为空串', () => {
    const { body } = applyPersonaTier('  \n\n  ', 'lite')
    assert.equal(body, '')
  })
})

describe('buildPersonaSection：接入档位', () => {
  test('默认参数（不传 tier）按 full 处理，行为与改造前一致', () => {
    const out = buildPersonaSection('我是昔涟。', true)
    assert.equal(out, '# 我的人格\n\n我是昔涟。')
  })

  test('lite 档产出更短，且不含 skip 块', () => {
    const lite = buildPersonaSection(SOURCE, true, [], 'lite')
    const full = buildPersonaSection(SOURCE, true, [], 'full')
    assert.ok(lite.length < full.length, 'lite 应当更短')
    assert.doesNotMatch(lite, /只有细腻版/)
    assert.match(full, /只有细腻版/)
  })

  test('两档都保留「我学到的倾向」', () => {
    const lite = buildPersonaSection(SOURCE, true, ['学到的偏好'], 'lite')
    assert.match(lite, /## 我学到的倾向/)
    assert.match(lite, /学到的偏好/)
  })

  test('warning 通过回调上报，调用方自己决定要不要 log', () => {
    const seen: string[] = []
    buildPersonaSection('<!-- lite:skip -->\n没闭合\n', true, [], 'lite', (m) => seen.push(m))
    assert.equal(seen.length, 1)
  })

  test('关闭时整段为空，不看档位', () => {
    assert.equal(buildPersonaSection(SOURCE, false, [], 'lite'), '')
    assert.equal(buildPersonaSection(SOURCE, false, [], 'full'), '')
  })
})

describe('buildDisciplineSection：工程纪律段', () => {
  test('默认开：内置五条都在', () => {
    const out = buildDisciplineSection(true)
    assert.match(out, /工程纪律/)
    assert.match(out, /不编造事实与能力/)
    assert.match(out, /一句话切换/)
    assert.equal(out, PERSONA_DISCIPLINE_PROMPT)
  })

  test('关掉返回空串（不发空壳）', () => {
    assert.equal(buildDisciplineSection(false), '')
    assert.equal(buildDisciplineSection(false, '额外内容'), '')
  })

  test('extra 只能追加：内置条目一条都不能少', () => {
    const out = buildDisciplineSection(true, '团队额外要求：改动前先读文件。')
    for (const line of PERSONA_DISCIPLINE_PROMPT.split('\n')) {
      assert.ok(out.includes(line), `内置条目被删了：${line.slice(0, 20)}`)
    }
    assert.match(out, /部署者补充/)
    assert.match(out, /团队额外要求/)
  })

  test('extra 里的花括号被兜住，不会炸掉提示词组装', () => {
    const out = buildDisciplineSection(true, '模板 {{x}}')
    assert.doesNotMatch(out, /\{\{x\}\}/)
  })
})
