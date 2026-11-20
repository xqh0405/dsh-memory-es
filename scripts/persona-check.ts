/**
 * 人设一致性检查：给 `persona/presets/*.md` 做体检。
 *
 * 为什么用 Node 而不是另写一份 Python 解析：档位解析必须与**运行时同一套实现**，
 * 否则「检查通过但线上渲染不对」这种问题最难查。所以这里直接 import src/prompt.ts。
 *
 * 检查项（对应方案文档 §4.7）：
 *   1. frontmatter 必需字段（id / name）
 *   2. 两档字数上限：lite ≤500、full ≤2500（**上限不是指标**，超了才报）
 *   3. 标记成对（applyPersonaTier 的 warnings）——不成对会静默保留原文，必须显式报出来
 *   4. 未替换的 `<占位符>`
 *   5. 七个固定段的顺序（顺序错会让提示词结构变乱）
 *
 * 用法：node --experimental-strip-types scripts/persona-check.ts
 * 退出码：0 全绿 / 1 有问题
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyPersonaTier, PERSONA_TIERS } from '../src/prompt.ts'

const PRESET_DIR = 'persona/presets'
const LITE_LIMIT = 500
const FULL_LIMIT = 2500

/** 七个固定段的期望顺序；缺段不报错（手写人设可以只写几段），但顺序乱要报 */
const EXPECTED_SECTIONS = ['【身份】', '【内核】', '【声音】', '【三档语气】', '【作为助手】', '【场景】', '【反向清单】']

interface Problem {
  file: string
  message: string
}

const problems: Problem[] = []
const report = (file: string, message: string): void => {
  problems.push({ file, message })
}

/** frontmatter 里取一个键的值（只用于校验，不做完整 YAML 解析） */
function frontmatterValue(source: string, key: string): string | null {
  const match = source.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/)
  if (match === null) return null
  const found = match[1].match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'))
  return found === null ? null : found[1]
}

function countChars(text: string): number {
  return text.replace(/\s/g, '').length
}

function main(): void {
  const files = readdirSync(PRESET_DIR).filter((f) => f.endsWith('.md')).sort()
  if (files.length === 0) {
    console.error(`${PRESET_DIR} 里没有 .md`)
    process.exit(1)
  }

  console.log(`检查 ${files.length} 份预设\n`)
  console.log('文件'.padEnd(12), 'lite'.padStart(6), 'full'.padStart(6), '  frontmatter')
  console.log('-'.repeat(50))

  for (const file of files) {
    const path = join(PRESET_DIR, file)
    const source = readFileSync(path, 'utf8')

    // 1. frontmatter 必需字段
    for (const key of ['id', 'name']) {
      if (frontmatterValue(source, key) === null) {
        report(file, `frontmatter 缺少必需字段 ${key}`)
      }
    }

    // 2/3. 两档渲染 + 标记配对
    const sizes: number[] = []
    for (const tier of PERSONA_TIERS) {
      const { body, warnings } = applyPersonaTier(source, tier)
      sizes.push(countChars(body))
      for (const warning of warnings) report(file, `${tier} 档：${warning}`)
    }
    const [liteChars, fullChars] = sizes as [number, number]
    if (liteChars > LITE_LIMIT) {
      report(file, `lite 档 ${liteChars} 字，超过上限 ${LITE_LIMIT}`)
    }
    if (fullChars > FULL_LIMIT) {
      report(file, `full 档 ${fullChars} 字，超过上限 ${FULL_LIMIT}`)
    }

    // 4. 未替换的占位符
    const placeholder = source.match(/<[^<>\n]{1,30}>/)
    if (placeholder !== null && !placeholder[0].startsWith('<!--')) {
      report(file, `疑似未替换的占位符：${placeholder[0]}`)
    }

    // 5. 段顺序（只查出现过的段，缺段不算错）
    const seen = EXPECTED_SECTIONS.filter((name) => source.includes(name))
    const inorder = seen.every(
      (name, index) => index === 0 || source.indexOf(seen[index - 1]!) < source.indexOf(name),
    )
    if (!inorder) {
      report(file, `段落顺序不对，应当是：${seen.join(' → ')}`)
    }

    const tierDefault = frontmatterValue(source, 'tier_default') ?? '(无)'
    console.log(
      file.padEnd(12),
      String(liteChars).padStart(6),
      String(fullChars).padStart(6),
      `  tier_default=${tierDefault}`,
    )
  }

  console.log()
  if (problems.length === 0) {
    console.log('✅ 全部通过')
    return
  }
  console.error(`❌ ${problems.length} 个问题：`)
  for (const { file, message } of problems) {
    console.error(`  ${file}: ${message}`)
  }
  process.exit(1)
}

main()
