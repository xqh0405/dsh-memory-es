/**
 * 一次性验证脚本：把预设按两个档位渲染出来，对比字数与内容差异。
 * 用法：node --experimental-strip-types scripts/persona-render-check.ts [预设名]
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { applyPersonaTier, buildDisciplineSection, buildPersonaSection } from '../src/prompt.ts'

const name = process.argv[2] ?? 'xilian'
const path = `persona/presets/${name}.md`
const source = readFileSync(path, 'utf8')

const strip = (s: string): number => s.replace(/\s/g, '').length

for (const tier of ['lite', 'full'] as const) {
  const warnings: string[] = []
  const body = buildPersonaSection(source, true, [], tier, (m) => warnings.push(m))
  // 「# 我的人格」标题与段落分隔不算人设正文，这里单独量正文
  const { body: raw } = applyPersonaTier(source, tier)
  writeFileSync(`/tmp/persona-${name}-${tier}.txt`, `${body}\n`)
  console.log(`\n===== ${tier} =====`)
  console.log(`正文 ${strip(raw)} 字｜注入段总计 ${strip(body)} 字（含标题与表层）`)
  console.log(`上限：lite ≤500 / full ≤2500`)
  if (warnings.length > 0) console.log(`⚠️ 警告：${warnings.join('；')}`)
}

const discipline = buildDisciplineSection(true)
writeFileSync('/tmp/persona-discipline.txt', `${discipline}\n`)
console.log(`\n===== 纪律段 =====`)
console.log(`${strip(discipline)} 字（独立注入，不计入人设上限）`)

console.log('\n提示：两个档位的完整文本已写到 /tmp/persona-*.txt')
