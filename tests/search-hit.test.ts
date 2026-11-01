/**
 * 命中回写脚本的契约（阶段 2 + 阶段 9）。
 *
 * 这段 painless 字符串没有任何类型保护：删掉一句编译不报错、运行时只会静默降级，
 * 而现象是「扩散激活的强度加权永远拿不到数据」——阶段 9 之前 activation 就是这么空转了很久。
 * 所以在这里把三件事钉死：命中次数、激活强度、基准时刻。
 *
 * 真正的脚本执行由集成测试覆盖（需要真实 ES；本机 ES 退役后一直 skip），
 * 这一层只防「有人以为它没用就删了」。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { HIT_UPDATE_SCRIPT } from '../src/memory/search.ts'
import { ACTIVATION_HALF_LIFE_DAYS } from '../src/fragment.ts'

describe('HIT_UPDATE_SCRIPT', () => {
  test('累计命中次数（hit_count，永不衰减）', () => {
    assert.match(HIT_UPDATE_SCRIPT, /hit_count/)
    assert.match(HIT_UPDATE_SCRIPT, /hit_count \+= 1/)
  })

  test('累计激活强度（activation）—— 这是阶段 9 接上的那一行', () => {
    assert.match(HIT_UPDATE_SCRIPT, /ctx\._source\.activation == null/)
    assert.match(HIT_UPDATE_SCRIPT, /ctx\._source\.activation \+= 1/)
  })

  test('写基准时刻（last_hit_at），读取侧靠它做时间衰减', () => {
    assert.match(HIT_UPDATE_SCRIPT, /last_hit_at = params\.now/)
  })

  test('写入侧不做衰减：指数/半衰期只出现在读取侧', () => {
    assert.doesNotMatch(HIT_UPDATE_SCRIPT, /Math\.exp/)
    assert.doesNotMatch(HIT_UPDATE_SCRIPT, /halfLife/i)
    assert.ok(ACTIVATION_HALF_LIFE_DAYS > 0)
  })
})
