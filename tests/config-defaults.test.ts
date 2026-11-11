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

  // 2026-11-11 审查 #33：原标题写「默认关，预算默认 600」，与断言（true / 800）**相反**。
  // 断言是对的（2026-11-09 用户决定打开 + 上调 800），是标题忘了跟着改 —— 改标题，不改断言。
  test('阶段 32：pinned 段默认**开**、预算默认 **800** 字符（2026-11-09 调整过）', () => {
    const cfg = Config({} as never).recallInject
    assert.equal(cfg.pinnedEnabled, true, '2026-11-09 用户决定默认打开（32 已对照过，33 已下沉规则）')
    assert.equal(cfg.pinnedMaxChars, 800, '2026-11-09 上调到 800：成员下沉的规则条数比预估多')
  })

  test('prewarm 的护栏仍在（关掉不等于删掉）', () => {
    const prewarm = Config({} as never).recallInject.prewarm
    assert.equal(prewarm.timeoutMs, 2_000)
    assert.equal(prewarm.cacheTtlMs, 30_000)
    assert.equal(prewarm.maxEntries, 64)
  })
})
describe('阶段 28 文档库配置', () => {
  test('doc.limitBytes 默认 10 MiB（与 mnemon Documents 同口径）', () => {
    const cfg = Config({} as never)
    assert.equal(cfg.doc.limitBytes, 10 * 1024 * 1024)
  })

  test('doc.limitBytes=0 合法，表示不限', () => {
    const cfg = Config({ doc: { limitBytes: 0 } } as never)
    assert.equal(cfg.doc.limitBytes, 0)
  })
})
