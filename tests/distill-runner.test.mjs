/** 后台蒸馏的纯函数与降级行为（不碰网络、不碰 ES） */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseDistillOutput, buildDistillPrompt, pickRoute, collectStream, runDistillJob, DISTILL_SYSTEM } =
  await import('../src/memory/distillRunner.ts')

test('parse：标准 JSON', () => {
  const out = parseDistillOutput('{"content":"改写后","summary":"一句话","keywords":["a","b"],"topic_key":"deploy"}')
  assert.equal(out.content, '改写后')
  assert.deepEqual(out.keywords, ['a', 'b'])
  assert.equal(out.topicKey, 'deploy')
})

test('parse：容忍 ```json 围栏和前后废话', () => {
  const out = parseDistillOutput('好的，结果如下：\n```json\n{"content":"x"}\n```\n以上。')
  assert.equal(out.content, 'x')
})

test('parse：没有 content 就返回 null（宁可 pending，也不要写空）', () => {
  assert.equal(parseDistillOutput('{"summary":"只有摘要"}'), null)
  assert.equal(parseDistillOutput('完全不是 JSON'), null)
  assert.equal(parseDistillOutput(''), null)
})

test('prompt：带 domain，且原文原样进入（不允许截断丢信息）', () => {
  const raw = 'a'.repeat(3000)
  const prompt = buildDistillPrompt(raw, 'deploy')
  assert.ok(prompt.includes('deploy'))
  assert.ok(prompt.includes(raw), '原文必须整段给模型，截断就等于丢信息')
})

test('系统提示词强调保留数字/路径/命令（防止提炼成空话）', () => {
  assert.match(DISTILL_SYSTEM, /数字|版本号|路径|命令|错误码/)
})

test('pickRoute：配置优先，其次从 listModels 里挑', () => {
  const llm = { listModels: () => [{ provider: 'deepseek', model: 'deepseek-chat' }] }
  assert.deepEqual(pickRoute(llm, 'p', 'm'), { provider: 'p', model: 'm' })
  assert.deepEqual(pickRoute(llm), { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(pickRoute({ listModels: () => [] }), null)
})

test('collectStream：只累加 text-delta', async () => {
  async function* gen() {
    yield { type: 'text-delta', text: 'ab' }
    yield { type: 'finish', reason: 'stop' }
    yield { type: 'text-delta', text: 'cd' }
  }
  assert.equal(await collectStream(gen()), 'abcd')
})

test('没有 llm 服务时：不抛错，返回 no_llm_service（条目留在 pending）', async () => {
  const result = await runDistillJob(
    { userId: 'xqh', personalPrefix: 'personal_memory_', reader: {}, writer: {}, timeoutMs: 1000 },
    { memoryId: 'm1', content: 'x', domain: 'general' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no_llm_service')
})
