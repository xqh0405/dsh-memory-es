/**
 * 内置人格（persona/seed.md）的三条契约。
 *
 * 为什么值得钉住：
 *  · 默认值读包内文件 → 安装即有人格，且改 seed.md 就能随版本更新；
 *  · 配置优先 → 用户自己写的人格不会被升级覆盖（这是「更新不要覆盖已有」的实现方式）；
 *  · 显式空串仍然等于「不注入」——老口径不能被默认值悄悄改掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Config } from '../src/config.ts'

const seedFile = readFileSync(new URL('../persona/seed.md', import.meta.url), 'utf8').trim()

test('persona.seed 默认取包内 persona/seed.md', () => {
  // `as never` 与 apply.test.ts 同款：Config 的入参类型要求把带默认值的字段也写全，
// 而运行时由 schema 补默认值。这里只关心 persona.seed 的取值来源。
  const parsed = Config({ identity: { userId: 'u1' } } as never)
  assert.equal(parsed.persona.seed, seedFile)
  assert.ok(parsed.persona.seed.length > 200, '内置人格不该是空壳')
})

test('配置里写了 seed 就覆盖内置人格', () => {
  const parsed = Config({ identity: { userId: 'u1' }, persona: { seed: '我自己的口吻' } } as never)
  assert.equal(parsed.persona.seed, '我自己的口吻')
})

test('显式空串 = 不注入人格', () => {
  const parsed = Config({ identity: { userId: 'u1' }, persona: { seed: '' } } as never)
  assert.equal(parsed.persona.seed, '')
})
