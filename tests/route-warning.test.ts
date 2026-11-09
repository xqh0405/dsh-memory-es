/**
 * `missingRouteWarning` 契约测试：钉住 2026-11-09 那条静默失败链的「可见性」。
 *
 * 背景：traits / journal 默认开启且共用 `distill.provider/model`（不看 `distill.enabled`）。
 * 路由留空时插件照常加载、检索保存全正常，只有产出链路每次静默 0 条——
 * 本函数负责在启动时把这件事喊出来。三条要钉住的行为：
 *  1. 默认配置（路由空 + 功能开着）**必须**给出警告，且文案点名受影响的功能与修法；
 *  2. 路由配齐 → 不警告（别对正常部署刷红字）；
 *  3. 功能全关 → 不警告（没在用就不吵）——但只要有一个开着，哪怕 distill.enabled 是 false 也要警告。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Config, missingRouteWarning, type ConfigType } from '../src/config.ts'

/** 最小可用 Config：identity 必填项给全，其余走 schema 默认值（默认 traits/journal 开、路由空） */
function baseConfig(overrides: Record<string, unknown> = {}): ConfigType {
  return Config({
    identity: { userId: 'xqh', readPassword: 'pw-reader', writerPassword: 'pw-writer' },
    es: { url: 'http://127.0.0.1:9200', caCertPath: '', requestTimeoutMs: 1_000 },
    ...overrides,
  } as never) as ConfigType
}

describe('missingRouteWarning', () => {
  test('默认配置（路由空、自述与日记开着）给出警告，并点名受影响的功能', () => {
    const warning = missingRouteWarning(baseConfig())
    assert.notEqual(warning, null, '默认配置必须报警——这正是新用户装完会踩的形态')
    assert.match(warning!, /自述\(traits\)/)
    assert.match(warning!, /日记\(journal\)/)
    assert.match(warning!, /distill\.provider/)
    assert.match(warning!, /静默返回 0 条/)
    assert.match(warning!, /重启 dsh web/, '要告诉人怎么修，不能只说坏了')
  })

  test('路由配齐 → 不警告', () => {
    const warning = missingRouteWarning(
      baseConfig({ distill: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
    )
    assert.equal(warning, null)
  })

  test('三个产出功能全关 → 不警告（没在用就不吵）', () => {
    const warning = missingRouteWarning(
      baseConfig({ traits: { enabled: false }, journal: { enabled: false }, distill: { enabled: false } }),
    )
    assert.equal(warning, null)
  })

  test('distill.enabled=false 但自述开着 → 仍要警告（两者共用路由，与蒸馏开关无关）', () => {
    const warning = missingRouteWarning(
      baseConfig({
        distill: { enabled: false, provider: '', model: '' },
        traits: { enabled: true },
        journal: { enabled: false },
      }),
    )
    assert.notEqual(warning, null, '蒸馏关着不代表路由可以空——traits 一样要用它')
    assert.match(warning!, /自述\(traits\)/)
    assert.doesNotMatch(warning!, /日记\(journal\)/, '关掉的功能不该被点名')
  })

  test('只配了 provider 没配 model → 仍然警告（半个路由等于没有）', () => {
    const warning = missingRouteWarning(
      baseConfig({ distill: { provider: 'deepseek-official', model: '' } }),
    )
    assert.notEqual(warning, null)
  })
})
