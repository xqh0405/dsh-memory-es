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

test('pickRoute：配置 > 会话模型 > 列表第一个', async () => {
  const llm = { listModels: async () => [{ provider: 'deepseek', model: 'deepseek-chat' }] }
  const session = { provider: 'siliconflow', model: 'qwen3-32b' }
  // 配置写死时最优先
  assert.deepEqual(await pickRoute(llm, 'p', 'm', session), { provider: 'p', model: 'm', source: 'config' })
  // 配置留空 → 用会话模型（不是列表第一个）
  assert.deepEqual(await pickRoute(llm, '', '', session), { provider: 'siliconflow', model: 'qwen3-32b', source: 'session' })
  // 连会话模型都没有才回落
  assert.deepEqual(await pickRoute(llm, '', '', undefined), { provider: 'deepseek', model: 'deepseek-chat', source: 'first' })
  assert.equal(await pickRoute({ listModels: async () => [] }), null)
})

test('pickRoute：listModels 返回 Promise（宿主真实形态，回归）', async () => {
  // 宿主签名是 listModels(provider): Promise<LlmModelInfo[]>；
  // 旧实现没 await → 拿 Promise 去 for...of → "models is not iterable"，整条提炼直接挂。
  const llm = { listModels: (p) => Promise.resolve([{ provider: p || 'deepseek', model: 'deepseek-chat' }]) }
  assert.deepEqual(await pickRoute(llm, '', '', undefined), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    source: 'first',
  })
})

test('pickRoute：listModels 抛错 → 返回 null（不把异常抛给调用方）', async () => {
  const llm = { listModels: async () => { throw new Error('boom') } }
  assert.equal(await pickRoute(llm, '', '', undefined), null)
})

test('pickRoute：listModels 返回 { models: [...] } 包裹形态也能认', async () => {
  const llm = { listModels: async () => ({ models: [{ providerId: 'p2', modelId: 'm2' }] }) }
  assert.deepEqual(await pickRoute(llm, '', '', undefined), { provider: 'p2', model: 'm2', source: 'first' })
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

// ── content_fault：失败分类（sweep 计次的地基）────────────────────────────
// 分错类的代价不对称：把环境故障算成内容问题 → 一次 LLM 停机判死整批条目；
// 把内容问题算成环境问题 → 毒条目无限重试烧钱。两类都要钉死。

test('content_fault：模型输出不可解析 → true（内容问题，计次）', async () => {
  const result = await runDistillJob(
    {
      userId: 'xqh',
      personalPrefix: 'personal_memory_',
      reader: { get: async () => ({ id: 'm1', source: { memory_id: 'm1', user_id: 'xqh', content: 'x' } }) },
      writer: { update: async () => ({ id: 'm1', result: 'updated', status: 200 }) },
      llm: {
        prepareCall: async () => ({
          config: {},
          stream: async function* () {
            yield { type: 'text-delta', text: '完全不是 JSON 的输出' }
          },
        }),
      },
      provider: 'p',
      model: 'm',
      timeoutMs: 1000,
    },
    { memoryId: 'm1', content: 'x', domain: 'general' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unparsable')
  assert.equal(result.content_fault, true)
})

test('content_fault：蒸馏结果超长被 distillMemory 拒 → true（非 EsError 都算内容）', async () => {
  // 模型给一份超 6000 字的「改写」→ distillMemory 抛超长错误（普通 Error，非 EsError）
  const huge = 'a'.repeat(6001)
  const result = await runDistillJob(
    {
      userId: 'xqh',
      personalPrefix: 'personal_memory_',
      reader: { get: async () => ({ id: 'm1', source: { memory_id: 'm1', user_id: 'xqh', content: 'x' } }) },
      writer: { update: async () => ({ id: 'm1', result: 'updated', status: 200 }) },
      llm: {
        prepareCall: async () => ({
          config: {},
          stream: async function* () {
            yield { type: 'text-delta', text: JSON.stringify({ content: huge }) }
          },
        }),
      },
      provider: 'p',
      model: 'm',
      timeoutMs: 1000,
    },
    { memoryId: 'm1', content: 'x', domain: 'general' },
  )
  assert.equal(result.ok, false)
  assert.match(result.reason, /超过上限/)
  assert.equal(result.content_fault, true)
})

test('content_fault：写库 EsError（ES 抖动）→ false（环境问题，不计次）', async () => {
  const { EsError } = await import('../src/es/http.ts')
  const result = await runDistillJob(
    {
      userId: 'xqh',
      personalPrefix: 'personal_memory_',
      reader: { get: async () => ({ id: 'm1', source: { memory_id: 'm1', user_id: 'xqh', content: 'x' } }) },
      writer: {
        update: async () => {
          throw new EsError('connect ECONNREFUSED 127.0.0.1:9200', { kind: 'network' })
        },
      },
      llm: {
        prepareCall: async () => ({
          config: {},
          stream: async function* () {
            yield { type: 'text-delta', text: '{"content":"改写后"}' }
          },
        }),
      },
      provider: 'p',
      model: 'm',
      timeoutMs: 1000,
    },
    { memoryId: 'm1', content: 'x', domain: 'general' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.content_fault, false, 'ES 故障绝不能算成内容问题——否则一次 ES 抖动吃掉重试预算')
})

test('content_fault：LLM 调用本身抛错（超时/断网）→ 不设（环境问题）', async () => {
  const result = await runDistillJob(
    {
      userId: 'xqh',
      personalPrefix: 'personal_memory_',
      reader: {},
      writer: {},
      llm: {
        prepareCall: async () => {
          throw new Error('ETIMEDOUT')
        },
      },
      provider: 'p',
      model: 'm',
      timeoutMs: 1000,
    },
    { memoryId: 'm1', content: 'x', domain: 'general' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.content_fault, undefined, '环境失败不标 content_fault → sweep 不计次')
})
