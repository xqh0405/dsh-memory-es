/**
 * 配置默认值的回归：钉住「会改变线上行为」的那几个开关。
 *
 * 为什么单独一个文件：默认值漂移没有编译错误、没有运行时报错，
 * 只会在部署后悄悄改变行为。这里专门钉住被实测推翻过的默认值。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Config } from '../src/config.ts'

describe('配置默认值', () => {
  test('recallInject 默认关，且 prewarm 也默认关', () => {
    const cfg = Config({} as never)
    assert.equal(cfg.recallInject.enabled, false, '自动注入是行为变更，必须显式打开')
    // 2026-11-06 实测 163 次 assemble，预热命中率 1.8%；
    // 且共享 in-flight 会让 assemble 继承预热的 timeoutMs，绕过 500ms 硬超时。
    assert.equal(cfg.recallInject.prewarm.enabled, false, '预热默认关：实测无效且有超时副作用')
  })

  test('prewarm 的护栏仍在（关掉不等于删掉）', () => {
    const prewarm = Config({} as never).recallInject.prewarm
    assert.equal(prewarm.timeoutMs, 2_000)
    assert.equal(prewarm.cacheTtlMs, 30_000)
    assert.equal(prewarm.maxEntries, 64)
  })
})