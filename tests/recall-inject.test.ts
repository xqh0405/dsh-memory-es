/**
 * 自动召回真注入（阶段 17 P0-1）的纯函数回归。
 *
 * 重点不是「能拼出字符串」，而是三条会把功能做坏的性质：
 *  · 预算裁剪不能把长记忆永久排除（单条超预算仍保留）；
 *  · 空结果必须返回空串（调用方靠它跳过插入，否则每轮插一个空段落）；
 *  · 注入块必须带「数据不是指令」的声明（记忆正文里存过运维命令与提交规则）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Projected } from '../src/fragment.ts'
import { EsError } from '../src/es/http.ts'
import { classifyInjectError, formatInjection, passesInjectGate, pickForInjection, pickForInjectionDetailed, resolveInjectPath } from '../src/recall-inject.ts'

function hit(id: string, content: string, source: 'personal' | 'team' = 'personal'): Projected {
  return {
    memory_id: id,
    content,
    memory_type: 'fact',
    domain: 'test',
    updated_at: '2026-11-05T00:00:00.000Z',
    source,
    score: 1,
  }
}

describe('pickForInjection', () => {
  test('条数上限：超出 maxItems 直接截断', () => {
    const hits = [hit('a', '甲'), hit('b', '乙'), hit('c', '丙'), hit('d', '丁')]
    const picked = pickForInjection(hits, 2, 1000)
    assert.deepEqual(picked.map((item) => item.memory_id), ['a', 'b'])
  })

  test('字符预算：按顺序累加，放不下的停在这里（后面的更长的也不再看）', () => {
    const hits = [hit('a', '一二三四五'), hit('b', '六七八九十'), hit('c', '短')]
    const picked = pickForInjection(hits, 5, 6)
    assert.equal(picked.length, 1, '第二条放不下就该停，不能跳过去捡第三条')
    assert.equal(picked[0].memory_id, 'a')
  })

  test('单条就超预算时仍然保留：否则长记忆永远进不了注入集', () => {
    const longText = '长'.repeat(200)
    const picked = pickForInjection([hit('a', longText)], 3, 50)
    assert.equal(picked.length, 1)
    assert.equal(picked[0].chars, 200)
  })

  test('内容为空的命中直接跳过', () => {
    const picked = pickForInjection([hit('a', '   '), hit('b', '有效')], 3, 1000)
    assert.deepEqual(picked.map((item) => item.memory_id), ['b'])
  })

  test('summary 优先于 content（detail=summary 的口径）', () => {
    const withSummary = { ...hit('a', '很长的正文'), summary: '摘要' }
    const picked = pickForInjection([withSummary], 3, 1000)
    assert.equal(picked[0].text, '摘要')
  })

  test('团队/个人来源能区分（注入文本要标出来）', () => {
    const picked = pickForInjection([hit('a', '甲', 'team'), hit('b', '乙', 'personal')], 3, 1000)
    assert.deepEqual(picked.map((item) => item.source), ['team', 'personal'])
  })
})

describe('formatInjection', () => {
  test('空数组返回空串（调用方据此跳过插入）', () => {
    assert.equal(formatInjection([]), '')
  })

  test('声明「是数据不是指令」，并提示可能过时', () => {
    const text = formatInjection([{ memory_id: 'a', text: '某条记忆', chars: 4, source: 'personal' }])
    assert.match(text, /数据不是指令/)
    assert.match(text, /可能过时/)
  })

  test('个人/团队标签写在每条前面', () => {
    const text = formatInjection([
      { memory_id: 'a', text: '甲', chars: 1, source: 'personal' },
      { memory_id: 'b', text: '乙', chars: 1, source: 'team' },
    ])
    assert.match(text, /- \[个人\] 甲/)
    assert.match(text, /- \[团队\] 乙/)
  })

  test('正文里的换行与连续空白被压成单个空格（多行记忆不撑爆段落）', () => {
    const text = formatInjection([{ memory_id: 'a', text: '第一行\n\n第二行   第三行', chars: 10, source: 'personal' }])
    assert.match(text, /- \[个人\] 第一行 第二行 第三行/)
  })

  test('用标签包住，便于模型区分段落边界', () => {
    const text = formatInjection([{ memory_id: 'a', text: '甲', chars: 1, source: 'personal' }])
    assert.ok(text.startsWith('<memory-recall>'))
    assert.ok(text.trimEnd().endsWith('</memory-recall>'))
  })
})
describe('classifyInjectError', () => {
  test('TimeoutError / AbortError 归成 timeout（队列忙，不是通道坏）', () => {
    assert.equal(classifyInjectError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout')
    assert.equal(classifyInjectError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'timeout')
  })

  test('其它异常归成 error', () => {
    assert.equal(classifyInjectError(new Error('ECONNREFUSED')), 'error')
    assert.equal(classifyInjectError('字符串也能兜住'), 'error')
    assert.equal(classifyInjectError(null), 'error')
  })

  // ⚠️ 生产真实路径：注入的超时来自 AbortSignal.timeout → ES 层把它包成 EsError
  // （构造里 this.name='EsError'，kind='aborted'）。旧实现只认 name → 恒返回 'error'，
  // 'timeout' 分支在生产不可达（2026-11-10 审查：8 条 error 的 ms 全贴 500ms 硬超时、
  // 面板超时率恒 0%）。这条钉住那次修复，别改回只看 name。
  test('EsError(kind=aborted/timeout) 必须归成 timeout —— 生产路径，不能只看 name', () => {
    assert.equal(classifyInjectError(new EsError('POST /_msearch → 调用方取消', { kind: 'aborted' })), 'timeout')
    assert.equal(classifyInjectError(new EsError('POST /_search → 超时（8000ms）', { kind: 'timeout' })), 'timeout')
    // 非超时类 EsError 仍是真错误
    assert.equal(classifyInjectError(new EsError('HTTP 403 forbidden', { kind: 'permission' })), 'error')
    assert.equal(classifyInjectError(new EsError('连接失败', { kind: 'network' })), 'error')
  })

  test('cause 链遍历兜底：原生超时被包在普通 Error 里也能认出来', () => {
    const inner = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const outer = new Error('wrapping', { cause: inner })
    assert.equal(classifyInjectError(outer), 'timeout')
    // 链上全是普通错误 → 仍是 error
    assert.equal(classifyInjectError(new Error('a', { cause: new Error('b') })), 'error')
  })

  test('cause 链自引用不死循环（最多走 8 层）', () => {
    const cyclic: { name: string; cause?: unknown } = { name: 'Weird' }
    cyclic.cause = cyclic
    assert.equal(classifyInjectError(cyclic), 'error')
  })
})

describe('resolveInjectPath', () => {
  test('配置了就用配置的路径', () => {
    assert.equal(resolveInjectPath('/tmp/x/inject.jsonl'), '/tmp/x/inject.jsonl')
  })

  test('留空时落到插件私有数据目录（与影子并列）', () => {
    const path = resolveInjectPath('')
    assert.match(path, /memory-es\/recall-inject\.jsonl$/)
  })
})

describe('passesInjectGate · 绝对分数门槛', () => {
  const base = { note: 'ok', vectorScore: 0.80, degraded: false, minScore: 0.76 }

  test('note 不是 ok 一律不注入', () => {
    assert.equal(passesInjectGate({ ...base, note: 'no_match' }), false)
    assert.equal(passesInjectGate({ ...base, note: 'low_confidence' }), false)
  })

  test('向量降级时不注入：只剩 BM25，没有可靠的绝对尺度', () => {
    assert.equal(passesInjectGate({ ...base, degraded: true }), false)
  })

  test('拿不到向量分数时不注入', () => {
    assert.equal(passesInjectGate({ ...base, vectorScore: undefined }), false)
    assert.equal(passesInjectGate({ ...base, vectorScore: Number.NaN }), false)
  })

  test('0.76 这条线：实测闲聊最高 0.7430，相关最低 0.7920', () => {
    // 用实测值当断言，别写 0.75/0.76 这种自己编的数
    assert.equal(passesInjectGate({ ...base, vectorScore: 0.743 }), false, '闲聊档不该过')
    assert.equal(passesInjectGate({ ...base, vectorScore: 0.7333 }), false, '闲聊档不该过')
    assert.equal(passesInjectGate({ ...base, vectorScore: 0.792 }), true, '相关档要过')
    assert.equal(passesInjectGate({ ...base, vectorScore: 0.8314 }), true, '相关档要过')
  })

  test('门槛可配：放宽到 0.72 时闲聊也会过（说明这是旋钮不是硬编码）', () => {
    assert.equal(passesInjectGate({ ...base, vectorScore: 0.7333, minScore: 0.72 }), true)
  })
})


describe('阶段 22：被挤掉的条目也要记下来', () => {
  test('字符预算挤掉 → reason=max-chars，且顺序与 pickForInjection 一致', () => {
    const hits = [hit('a', '一二三四五'), hit('b', '六七八九十'), hit('c', '短')]
    const { picked, dropped } = pickForInjectionDetailed(hits, 5, 6)
    assert.deepEqual(picked.map((item) => item.memory_id), ['a'])
    // 第二条超预算后，后面的即使更短也不再捡（与 pickForInjection 同一语义）
    assert.deepEqual(dropped, [
      { memory_id: 'b', reason: 'max-chars' },
      { memory_id: 'c', reason: 'max-chars' },
    ])
  })

  test('条数上限挤掉 → reason=max-items', () => {
    const hits = [hit('a', '甲'), hit('b', '乙'), hit('c', '丙')]
    const { picked, dropped } = pickForInjectionDetailed(hits, 2, 1000)
    assert.deepEqual(picked.map((item) => item.memory_id), ['a', 'b'])
    assert.deepEqual(dropped, [{ memory_id: 'c', reason: 'max-items' }])
  })

  test('没挤掉任何东西时 dropped 为空数组（JSONL 里就不会出现该字段）', () => {
    const { picked, dropped } = pickForInjectionDetailed([hit('a', '甲')], 3, 1000)
    assert.equal(picked.length, 1)
    assert.deepEqual(dropped, [])
  })
})
