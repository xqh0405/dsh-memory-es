/**
 * 面板 host 侧纯函数的单元测试（P2）。
 *
 * 为什么测这几个：面板前几轮出的错，全是"看起来对、其实口径错"的类型 ——
 *  · 待裁决计数漏 status=active（拒绝后数字不变）
 *  · 跨两库分页 from/size 各算一次（翻页重复）
 *  · configEditor 的行 id 是 include: 前缀（配置一次都没读到，接口 404）
 * 这些都是纯函数能被钉住的地方，不需要真 ES。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { pendingQuery, indexNames, mergeConfig, projectHit, entryLabels, findEntryRow, EDITABLE, classifyCluster, feedbackScript, classifyIdentityAction, summarizeInjectRecords, handleInjectLog } = await import(
  '../panel/index.js'
)

test('classifyIdentityAction：active 自述能设锚点（顺序回归，2026-11-05）', () => {
  const verdict = classifyIdentityAction('identity', 'active', 'anchor')
  assert.equal(verdict.ok, true, 'anchor 的目标状态就是 active；任何 pending 前置校验都会让「设为锚点」永远点不动')
})

test('classifyIdentityAction：采纳/拒绝仍然只收 pending', () => {
  for (const action of ['approve', 'reject']) {
    const verdict = classifyIdentityAction('identity', 'active', action)
    assert.equal(verdict.ok, false)
    assert.match(verdict.error, /只有 pending 能被采纳/)
  }
})

test('classifyIdentityAction：锚点只给 identity + active', () => {
  assert.match(classifyIdentityAction('persona', 'active', 'anchor').error, /不是 identity，不能设锚点/)
  assert.match(classifyIdentityAction('identity', 'pending', 'anchor').error, /只有生效中的自述能设锚点（当前 pending）/)
  assert.match(classifyIdentityAction('fact', 'active', 'anchor').error, /不能走采纳闸门/)
})

test('pendingQuery：待裁决必须同时限定 review_state 与 status=active', () => {
  const filter = pendingQuery().bool.filter
  assert.equal(filter.length, 2, '少一个条件就会把已撤回/已驳回的文档也算进待裁决')
  assert.deepEqual(filter[0], { term: { review_state: 'pending' } })
  assert.deepEqual(filter[1], { term: { status: 'active' } })
})

test('indexNames：个人索引由前缀 + userId 拼出', () => {
  const names = indexNames({
    index: { personalPrefix: 'personal_memory_', team: 'team_knowledge' },
    identity: { userId: 'xqh' },
  })
  assert.equal(names.personal, 'personal_memory_xqh')
  assert.equal(names.team, 'team_knowledge')
})

test('mergeConfig：override 覆盖 inherited，缺的键回落默认值', () => {
  const merged = mergeConfig(
    { es: { url: 'https://inherited:9200', requestTimeoutMs: 5000 }, identity: { userId: 'xqh' } },
    { es: { url: 'https://override:9200' } },
  )
  assert.equal(merged.es.url, 'https://override:9200')
  assert.equal(merged.es.requestTimeoutMs, 5000, '继承值应保留')
  assert.equal(merged.identity.userId, 'xqh')
  assert.equal(merged.defaults.domain, 'general', '未提供的键走默认值')
})

test('projectHit：id 优先 memory_id，同时暴露 esId 供写操作用', () => {
  const row = projectHit(
    {
      _id: 'es-primary-key',
      _source: { memory_id: 'mem-1', doc_id: 'doc-1', content: '正文', status: 'active', domain: 'general', memory_type: 'fact', updated_at: '2026-10-25T10:00:00Z' },
    },
    'team',
  )
  assert.equal(row.esId, 'es-primary-key')
  assert.equal(row.id, 'mem-1')
  assert.equal(row.scope, 'team')
  assert.equal(row.content, '正文')
})

test('projectHit：没有 memory_id 时退到 doc_id，再退到 _id', () => {
  const withDoc = projectHit({ _id: 'es-1', _source: { doc_id: 'doc-9' } }, 'team')
  assert.equal(withDoc.id, 'doc-9', 'doc_id 是业务字段，展示用它')
  assert.equal(withDoc.esId, 'es-1', '主键与业务字段必须分开')

  const bare = projectHit({ _id: 'es-2', _source: {} }, 'personal')
  assert.equal(bare.id, 'es-2')
})

test('entryLabels：include: 前缀的行也能被识别（当初 404 的根因）', () => {
  const labels = entryLabels({ entry: { id: 'include:dsh-memory-es', name: '' } })
  assert.ok(
    labels.some((label) => label === 'include:dsh-memory-es'),
    '必须能拿到 include: 形式的 id，否则永远匹配不到配置行',
  )
})

function fakeCtx(rows) {
  return { get: (name) => (name === 'configEditor' ? { configuration: () => rows } : undefined) }
}

test('findEntryRow：优先挑真的带 es.url 的行', () => {
  const empty = { entry: { id: 'include:dsh-memory-es' }, inherited: undefined, override: undefined }
  const full = {
    entry: { id: 'dsh-memory-es' },
    inherited: {
      es: { url: 'https://dsh-es-xqh:9200' },
      identity: { userId: 'xqh' },
    },
    override: undefined,
  }
  const result = findEntryRow(fakeCtx([empty, full]))
  assert.equal(result.ok, true)
  assert.equal(result.value.es.url, 'https://dsh-es-xqh:9200')
})

test('findEntryRow：只有空条目时给出可读的错误（不是静默返回 undefined）', () => {
  const empty = { entry: { id: 'include:dsh-memory-es' }, inherited: undefined, override: undefined }
  const result = findEntryRow(fakeCtx([empty]))
  assert.equal(result.ok, false)
  assert.match(result.error, /没有一条含完整配置/)
})

test('findEntryRow：configEditor 不可用时明确报错', () => {
  const result = findEntryRow({ get: () => undefined })
  assert.equal(result.ok, false)
  assert.match(result.error, /configEditor/)
})

// ── 权限：普通账号（没有整理身份）不该能审 ────────────────────────────────
const panel = await import('../panel/index.js')
const { handleCapabilities, handleDeleteMemory, handleDocArchive, handleDocRestore, handleMemories, handleMaintenanceGet, handleRestoreMemory, handleReviewAction, handleUsers } = panel

const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const { Readable } = await import('node:stream')

function ctxWith(identity) {
  const row = {
    entry: { id: 'include:dsh-memory-es' },
    inherited: {
      es: { url: 'https://example:9200', caCertPath: '' },
      index: { personalPrefix: 'personal_memory_', team: 'team_knowledge' },
      identity,
    },
    override: undefined,
  }
  return { get: (name) => (name === 'configEditor' ? { configuration: () => [row] } : undefined) }
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
    },
    end(body) {
      this.body = String(body ?? '')
    },
  }
}

const READER = { userId: 'xqh', readUsername: 'mem-reader-xqh', readPassword: 'x', writerUsername: 'mem-writer', writerPassword: 'y' }
const ADMIN = { ...READER, consolidatorUsername: 'mem-consolidator', consolidatorPassword: 'z' }

test('capabilities：普通账号 canReview=false、role=reader', async () => {
  const res = fakeRes()
  await handleCapabilities(ctxWith(READER), res)
  const body = JSON.parse(res.body)
  assert.equal(body.value.canReview, false)
  assert.equal(body.value.role, 'reader')
})

test('capabilities：配了整理身份 canReview=true、role=reviewer', async () => {
  const res = fakeRes()
  await handleCapabilities(ctxWith(ADMIN), res)
  const body = JSON.parse(res.body)
  assert.equal(body.value.canReview, true)
  assert.equal(body.value.role, 'reviewer')
})

test('审核动作：没有整理身份直接 403，且不碰 ES', async () => {
  const res = fakeRes()
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ confirm: true, reason: 'x' }))]), { method: 'POST' })
  await handleReviewAction(ctxWith(READER), res, 'doc-1', 'approve', req)
  assert.equal(res.statusCode, 403, '必须是 403 权限拒绝，不是 500')
  assert.match(JSON.parse(res.body).error, /整理身份/)
})

test('审核动作：驳回仍然要求填原因（先于权限返回 400）', async () => {
  const res = fakeRes()
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ confirm: true, reason: '' }))]), { method: 'POST' })
  await handleReviewAction(ctxWith(ADMIN), res, 'doc-1', 'reject', req)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /原因/)
})

// ── validateConfig：单账号与旧三账号两条路径 ──────────────────────────────
// src/config.ts 是 TS：Node 22.18+ 可直接 strip 类型导入（这里只取纯函数 validateConfig）
const { validateConfig } = await import('../src/config.ts').catch((error) => {
  console.error('[skip] 无法导入 src/config.ts:', String(error?.message ?? error))
  return { validateConfig: null }
})
if (validateConfig) {
  const base = {
    es: { url: 'https://x:9200', caCertPath: '', requestTimeoutMs: 8000 },
    index: { personalPrefix: 'personal_memory_', team: 'team_knowledge' },
    embedding: { url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024 },
    retrieval: { topK: 10, rrfK: 60, limit: 20 },
    defaults: { domain: 'general' },
  }
  const identity = (extra) => ({
    userId: 'xqh', username: '', password: '', teamWrite: false,
    readUsername: '', readPassword: '', writerUsername: '', writerPassword: '',
    consolidatorUsername: '', consolidatorPassword: '', ...extra,
  })

  test('validateConfig：单账号齐全时通过（不要求 readPassword）', () => {
    const problems = validateConfig({ ...base, identity: identity({ username: 'mem-user-xqh', password: 'p', teamWrite: true }) })
    assert.deepEqual(problems, [])
  })

  test('validateConfig：既没单账号也没 readPassword 时明确报错', () => {
    const problems = validateConfig({ ...base, identity: identity({}) })
    assert.ok(problems.some((p) => p.includes('readPassword')), `实际：${problems}`)
  })

  test('validateConfig：userId 缺失仍然拦（审计要记人）', () => {
    const problems = validateConfig({ ...base, identity: identity({ userId: '', username: 'u', password: 'p', teamWrite: true }) })
    assert.ok(problems.some((p) => p.includes('userId')), `实际：${problems}`)
  })
}

// ── 配置写入的类型收敛：布尔开关别把 true 写成字符串 "true" ──────────────
test('coerceFieldValue：布尔/数字/字符串各归各位', () => {
  const { coerceFieldValue } = panel
  assert.equal(coerceFieldValue({ type: 'boolean', value: true }), true)
  assert.equal(coerceFieldValue({ type: 'boolean', value: 'true' }), true)
  assert.equal(coerceFieldValue({ type: 'boolean', value: 'false' }), false)
  assert.equal(coerceFieldValue({ type: 'boolean', value: false }), false)
  assert.equal(coerceFieldValue({ type: 'number', value: '30000' }), 30000)
  assert.equal(coerceFieldValue({ type: 'string', value: 'bge-m3' }), 'bge-m3')
  // 重点：布尔字段不能变成字符串，否则插件侧 z.boolean() 会拒配置
  assert.notEqual(coerceFieldValue({ type: 'boolean', value: 'true' }), 'true')
})

// ── 鉴权闸：面板路由必须复用 dsh 的 connection.admit（2026-10-26 修的真漏洞）──
test('admitRequest：未登录返回 401，可信来源放行', () => {
  const { admitRequest } = panel
  const denied = { get: (name) => (name === 'connection' ? { admit: () => ({ rejection: 401 }) } : undefined) }
  assert.equal(admitRequest(denied, {}), 401)

  const forbidden = { get: () => ({ admit: () => ({ rejection: 403 }) }) }
  assert.equal(admitRequest(forbidden, {}), 403)

  const allowed = { get: () => ({ admit: () => ({ peer: { id: 'p1' } }) }) }
  assert.equal(admitRequest(allowed, {}), null)
})

test('admitRequest：没有 connection 服务时失败关闭（503），不能放行', () => {
  const { admitRequest } = panel
  assert.equal(admitRequest({ get: () => undefined }, {}), 503)
  assert.equal(admitRequest({}, {}), 503)
  // admit 自己抛错也不能当成放行
  const broken = { get: () => ({ admit: () => { throw new Error('boom') } }) }
  assert.equal(admitRequest(broken, {}), 401)
})

// ── 写盘类型：布尔字段绝不能变成字符串（2026-10-26 线上报错复现）──
test('coerceFieldValue：字段定义说了算，客户端传 type=string 也按 boolean 转', () => {
  const { coerceFieldValue, fieldTypeOf } = panel
  assert.equal(fieldTypeOf('distill.enabled'), 'boolean')
  assert.equal(fieldTypeOf('es.requestTimeoutMs'), 'number')
  // 旧客户端把复选框当文本框：type=string + "true"
  assert.equal(coerceFieldValue({ key: 'distill.enabled', type: 'string', value: 'true' }), true)
  assert.equal(coerceFieldValue({ key: 'distill.enabled', value: true }), true)
  // 数字字段同理
  assert.equal(coerceFieldValue({ key: 'es.requestTimeoutMs', type: 'string', value: '8000' }), 8000)
})

test('写盘后的配置能被 schemastery 接受（boolean 不是 "true"）', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const { coerceFieldValue } = panel
  const schema = z.object({
    distill: z.object({ enabled: z.boolean().default(false), model: z.string().default(''), timeoutMs: z.number().default(30000) }),
  })
  const value = coerceFieldValue({ key: 'distill.enabled', type: 'string', value: 'true' })
  assert.equal(typeof value, 'boolean')
  // 这里若写成 String(value) 就会复现 "expected boolean but got true"
  assert.doesNotThrow(() => schema({ distill: { enabled: value } }))
  assert.throws(() => schema({ distill: { enabled: String(value) } }), /expected boolean/)
})

// ── 写盘结果：布尔必须保持布尔（线上报错的直接回归测试）──
test('applyConfigChanges：boolean 原样写入，不变成字符串', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const { applyConfigChanges, coerceFieldValue } = panel
  const changes = [{ key: 'distill.enabled', type: 'string', value: 'true' }]
  const resolved = new Map([['distill.enabled', coerceFieldValue(changes[0])]])
  const current = {
    es: { url: 'https://127.0.0.1:9200' },
    distill: { enabled: false, provider: '', model: '', timeoutMs: 30000 },
  }
  const next = applyConfigChanges(current, changes, resolved)
  assert.equal(typeof next.distill.enabled, 'boolean')
  assert.equal(next.distill.enabled, true)
  // 其余分组原样带回（configEditor 要完整 raw config）
  assert.equal(next.es.url, 'https://127.0.0.1:9200')

  const schema = z.object({
    es: z.object({ url: z.string() }),
    distill: z.object({ enabled: z.boolean().default(false), provider: z.string().default(''), model: z.string().default(''), timeoutMs: z.number().default(30000) }),
  })
  assert.doesNotThrow(() => schema(next), '写盘结果必须能通过插件 schema')
})

// ── 删除接口：权限、必填原因、幂等 ────────────────────────────────────────
// 用一个进程内假 ES：只实现删除路径会用到的三个端点，并记录收到的请求，
// 好断言"参数不合格时一次都不该碰 ES"。
const { createServer } = await import('node:http')

const SINGLE = { userId: 'xqh', username: 'mem-user-xqh', password: 'pw', teamWrite: true }

/** 假 ES：_has_privileges 按索引名分别回答，DELETE / 审计写入按参数给状态码 */
async function startFakeEs({
  canDeletePersonal = true,
  canDeleteTeam = true,
  deleteStatus = 200,
  auditStatus = 201,
  indexBuckets = [],
  restoreSource = null,
  // 归档/恢复（2026-11-10 审查 P6/#21）：线上跑的 setDocStatus 要这三样
  docSlices = null,
  /** 切片上的 cold_memory_id（审查 16b：恢复时按它精确删掉冷引用） */
  sliceColdRef = null,
  failUpdateFor = null,
  coldRefFail = false,
} = {}) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      calls.push({ method: req.method, url: req.url, body })
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(payload === undefined ? '' : JSON.stringify(payload))
      }
      if (req.url.startsWith('/_security/user/_has_privileges')) {
        const parsed = JSON.parse(body || '{}')
        const names = parsed?.index?.[0]?.names ?? []
        const allow = names.includes('team_knowledge') ? canDeleteTeam : canDeletePersonal
        return send(200, { has_all_requested: Boolean(allow), index: {} })
      }
      if (req.method === 'DELETE') {
        return send(deleteStatus, { result: deleteStatus === 404 ? 'not_found' : 'deleted' })
      }
      if (req.url.startsWith('/memory_audit/_doc')) return send(auditStatus, { result: auditStatus >= 400 ? 'error' : 'created' })
      // /users 用的 _index 聚合：任何 personal_memory_* 的 _search 都回同一份 buckets；
      // 其他 _search 回空页（handleMemories 会拿它拼两库结果）
      if (req.url.includes('_search')) {
        // restore 走 `ids` 查询取单条（面板读侧没有 get）——给了 restoreSource 就回它，
        // 这样才能断言「恢复写出去的 patch 长什么样」
        if (restoreSource !== null && body.includes('"ids"')) {
          return send(200, {
            hits: { total: { value: 1 }, hits: [{ _id: 'es-1', _score: 1, _source: restoreSource }] },
          })
        }
        // 归档/恢复（#21）：`term: doc_id` 取这篇文档的**全部切片**一起改状态
        if (docSlices !== null && body.includes('"term"')) {
          return send(200, {
            took: 1,
            hits: {
              total: { value: docSlices.length, relation: 'eq' },
              hits: docSlices.map((id) => ({
                _id: id,
                _score: 1,
                _source: {
                  doc_id: 'doc-1',
                  title: '测试文档',
                  domain: 'general',
                  chunk_total: docSlices.length,
                  // 老文档没有这个字段 —— 只有显式给了才带上（这样才能测「没有也不报错」）
                  ...(sliceColdRef === null ? {} : { cold_memory_id: sliceColdRef }),
                },
              })),
            },
          })
        }
        return send(200, {
          hits: { total: { value: 0 }, hits: [] },
          // docs: 维护页"文档数"的 cardinality 聚合（固定 42，方便断言它不再是占位）
          aggregations: { by_user: { buckets: indexBuckets }, docs: { value: 42 } },
        })
      }

      // 逐切片状态更新（setDocStatus 的主循环）；可按切片 id 让某些失败
      if (req.url.includes('/_update/')) {
        const id = decodeURIComponent((req.url.split('/_update/')[1] ?? '').split(/[?/]/)[0] ?? '')
        if ((failUpdateFor ?? []).includes(id)) {
          return send(500, { error: { type: 'internal_server_error', reason: `update ${id} boom` } })
        }
        return send(200, { _id: id, result: 'updated' })
      }

      // 冷引用写入（personal 索引 _doc）——归档必写；失败要降级提示、不回滚归档
      if ((req.method === 'POST' || req.method === 'PUT') && req.url.includes('/_doc')) {
        if (coldRefFail) {
          return send(500, { error: { type: 'internal_server_error', reason: 'coldref boom' } })
        }
        return send(201, { result: 'created' })
      }

      return send(200, {})
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((resolve) => server.close(resolve)) }
}

function ctxWithEs(identity, esUrl) {
  const row = {
    entry: { id: 'include:dsh-memory-es' },
    inherited: {
      es: { url: esUrl, caCertPath: '' },
      index: { personalPrefix: 'personal_memory_', team: 'team_knowledge' },
      identity,
    },
    override: undefined,
  }
  return { get: (name) => (name === 'configEditor' ? { configuration: () => [row] } : undefined) }
}

function postReq(payload) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST' })
}

test('删除：缺 confirm 直接 400，且一次都不碰 ES', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'personal' }))
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /confirm/)
    assert.equal(es.calls.length, 0, '参数不合格时不该向 ES 发请求')
  } finally {
    await es.close()
  }
})

test('删除：scope 非法 400', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'team_knowledge', confirm: true }))
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /scope/)
  } finally {
    await es.close()
  }
})

test('删除：团队记忆缺原因 400（先于权限判断）', async () => {
  const es = await startFakeEs({ canDeleteTeam: true })
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'team', confirm: true, reason: ' ' }))
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /原因/)
  } finally {
    await es.close()
  }
})

test('删除：没有团队 delete 权限 → 403，且不执行删除', async () => {
  const es = await startFakeEs({ canDeleteTeam: false, canDeletePersonal: true })
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'team', confirm: true, reason: '删错' }))
    assert.equal(res.statusCode, 403)
    assert.match(JSON.parse(res.body).error, /团队删除权限/)
    assert.equal(es.calls.filter((c) => c.method === 'DELETE').length, 0, '没权限不该真的发 DELETE')
  } finally {
    await es.close()
  }
})

test('删除：团队删除成功 → 200 且写 memory_audit', async () => {
  const es = await startFakeEs({ canDeleteTeam: true })
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'team', confirm: true, reason: '内容过时' }))
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.deleted, true)
    assert.equal(body.value.auditWritten, true)
    const del = es.calls.find((c) => c.method === 'DELETE')
    assert.ok(del, '必须真的发 DELETE')
    assert.match(del.url, /team_knowledge\/_doc\/doc-1/)
    const audit = es.calls.find((c) => c.url.startsWith('/memory_audit/_doc'))
    assert.ok(audit, '团队删除必须写审计')
    assert.equal(JSON.parse(audit.body).event, 'deleted')
    assert.equal(JSON.parse(audit.body).reason, '内容过时')
    // 顺序是这次修复的核心：审计必须**早于**删除（旧版先删后审计，审计失败就无痕删掉了）
    const auditIdx = es.calls.findIndex((c) => c.url.startsWith('/memory_audit/_doc'))
    const delIdx = es.calls.findIndex((c) => c.method === 'DELETE')
    assert.ok(auditIdx < delIdx, `审计必须先于删除，实际 audit@${auditIdx} del@${delIdx}`)
  } finally {
    await es.close()
  }
})

test('删除：团队审计写入失败 → 502 且不执行删除（无审计不删）', async () => {
  const es = await startFakeEs({ canDeleteTeam: true, auditStatus: 403 })
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'team', confirm: true, reason: '内容过时' }))
    assert.equal(res.statusCode, 502, '审计写不进去必须报错，不能返回 200 假装成功')
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.match(body.error, /审计写入失败/)
    assert.match(body.error, /已中止删除/)
    assert.equal(
      es.calls.filter((c) => c.method === 'DELETE').length,
      0,
      '审计没写成时绝不能删 —— 否则团队记忆被无痕删除（memory_audit 是唯一的人维度证据）',
    )
  } finally {
    await es.close()
  }
})

test('删除：审计已写但删除失败 → 补一条更正审计，不让审计说谎', async () => {
  const es = await startFakeEs({ canDeletePersonal: true, canDeleteTeam: true, deleteStatus: 500 })
  try {
    const res = fakeRes()
    // handler 直接把删除失败抛出去，由路由层顶层 catch 兜成 500（panel/index.js 的 500 分支）
    let thrown = null
    try {
      await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-1', scope: 'team', confirm: true, reason: '内容过时' }))
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, '删除失败必须抛出，不能静默返回 200')
    assert.match(String(thrown?.message ?? thrown), /500|HTTP/)
    const audits = es.calls.filter((c) => c.url.startsWith('/memory_audit/_doc'))
    assert.equal(audits.length, 2, `应有 deleted + delete_failed 两条，实际 ${audits.length}`)
    assert.equal(JSON.parse(audits[0].body).event, 'deleted')
    assert.equal(JSON.parse(audits[1].body).event, 'delete_failed')
    assert.match(JSON.parse(audits[1].body).reason, /作废/)
  } finally {
    await es.close()
  }
})

test('删除：删不存在的条目按幂等成功（404 → deleted=false）', async () => {
  const es = await startFakeEs({ canDeletePersonal: true, deleteStatus: 404 })
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'gone', scope: 'personal', confirm: true }))
    assert.equal(res.statusCode, 200, '重复删除不该报错')
    assert.equal(JSON.parse(res.body).value.deleted, false)
  } finally {
    await es.close()
  }
})

test('删除：个人库删除成功，且按设计不写审计', async () => {
  const es = await startFakeEs({ canDeletePersonal: true })
  try {
    const res = fakeRes()
    await handleDeleteMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'doc-2', scope: 'personal', confirm: true }))
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.deleted, true)
    assert.equal(body.value.auditWritten, false, '个人删除按设计不审计，不能假装写了')
    assert.equal(es.calls.filter((c) => c.url.startsWith('/memory_audit/_doc')).length, 0)
    const del = es.calls.find((c) => c.method === 'DELETE')
    assert.match(del.url, /personal_memory_xqh\/_doc\/doc-2/)
  } finally {
    await es.close()
  }
})

// ── 恢复隔离：distill_state 必须跟着重置（2026-11-10 审查 #16）─────────────
// 面板与工具侧是**两套独立实现**，历史上正是「一边修了另一边漏」反复出 bug
// （工具侧恢复曾经不清 quarantine_reason，就是这么发现的）。所以两边都得钉。
test('恢复：distill_state=skipped → 重置为 pending，回执带 requeueDistill', async () => {
  const es = await startFakeEs({
    restoreSource: { status: 'quarantine', distill_state: 'skipped', quarantine_reason: '命中赋值式凭证', embedding: null },
  })
  try {
    const res = fakeRes()
    await handleRestoreMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'es-1', scope: 'personal' }))
    assert.equal(res.statusCode, 200, `实际：${res.body}`)
    const body = JSON.parse(res.body)
    assert.equal(body.value.status, 'active')
    assert.equal(body.value.requeueDistill, true, '回执要告诉客户端「已重新排队蒸馏」')
    assert.equal(body.value.embeddingMissing, true, '隔离条目按设计无向量')

    const upd = es.calls.find((c) => c.url.includes('/_update/'))
    assert.ok(upd, '应发出 update')
    const patch = JSON.parse(upd.body).doc
    assert.equal(patch.status, 'active')
    assert.equal(patch.quarantine_reason, null)
    assert.equal(patch.distill_state, 'pending', '不重置的话清扫只查 pending，这条永不蒸馏、永远补不回向量')
  } finally {
    await es.close()
  }
})

test('恢复：distill_state=done → 不动它（已蒸馏过，别白烧一轮模型）', async () => {
  const es = await startFakeEs({
    restoreSource: { status: 'quarantine', distill_state: 'done', embedding: [0.1] },
  })
  try {
    const res = fakeRes()
    await handleRestoreMemory(ctxWithEs(SINGLE, es.url), res, postReq({ esId: 'es-1', scope: 'personal' }))
    const body = JSON.parse(res.body)
    assert.equal(body.value.requeueDistill, false)
    assert.equal(body.value.embeddingMissing, false)

    const patch = JSON.parse(es.calls.find((c) => c.url.includes('/_update/')).body).doc
    assert.equal(
      'distill_state' in patch,
      false,
      `已蒸馏的条目不该被重置，实际 patch=${JSON.stringify(patch)}`,
    )
  } finally {
    await es.close()
  }
})

// ── 文档归档/恢复：**线上跑的那套** setDocStatus（2026-11-10 审查 P6/#21）─────
// 背景：`src/memory/doc-archive.ts` 是**死代码**（只有它自己那份测试在引用），
// 而线上走的是 `panel/index.js` 的 `setDocStatus` —— 逐切片改状态 + **直写冷引用**，
// 绕过 saveMemory / governance / 准入，**以前零测试**。
// 归档是管理员的日常动作（清容量），所以把线上这份钉住，而不是去测那份没人跑的。
// ⚠️ 修法里的「接 doc.limitBytes」与「统一两套实现」按用户 2026-11-10 拍板**本次不做**：
//   前者要先对 11 个 personal_doc_* 索引（5454 切片）加字段迁移再上代码（与单独排的 16b 同类）；
//   后者与「面板刻意不 import 主插件产物」的现有结构冲突，属高风险结构性改动。
//   两者都已记进修复文档第 21 项，别当成做完。
const DOC_ADMIN = { ...SINGLE, consolidatorUsername: 'mem-consolidator', consolidatorPassword: 'z' }
// 非管理员：canReviewTeam 的判据是「单账号 + teamWrite」**或**「有整理身份」，
// 所以必须两条都不满足 —— 直接用 SINGLE（teamWrite:true）会反而被放行。
const DOC_MEMBER = { ...SINGLE, teamWrite: false, consolidatorUsername: '', consolidatorPassword: '' }
const coldWrites = (es) => es.calls.filter((c) => c.url.includes('personal_memory') && c.url.includes('/_doc'))
const sliceUpdates = (es) => es.calls.filter((c) => c.url.includes('/_update/'))

test('归档：非管理员 403，且一次都不碰 ES', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0'] })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_MEMBER, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 403, `实际 ${res.statusCode}: ${res.body}`)
    assert.match(JSON.parse(res.body).error, /管理员/)
    assert.equal(es.calls.length, 0, '权限没过之前连查询都不该发')
  } finally {
    await es.close()
  }
})

test('归档：缺 docId → 400（先于权限检查，报错更具体）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0'] })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ reason: '占容量' }))
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /docId/)
    assert.equal(es.calls.length, 0)
  } finally {
    await es.close()
  }
})

test('归档：文档不存在 → 404（不是 200 装作改了）', async () => {
  const es = await startFakeEs({ docSlices: [] })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'nope' }))
    assert.equal(res.statusCode, 404)
    assert.match(JSON.parse(res.body).error, /不存在/)
    assert.equal(sliceUpdates(es).length, 0, '查不到就不该发任何状态更新')
  } finally {
    await es.close()
  }
})

test('归档：全部切片成功 + 冷引用写入（否则归档等于失踪）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0', 'd1-1', 'd1-2'] })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1', reason: '占满容量' }))
    assert.equal(res.statusCode, 200, `实际 ${res.statusCode}: ${res.body}`)
    const value = JSON.parse(res.body).value
    assert.equal(value.status, 'archived')
    assert.equal(value.chunks, 3, '三个切片都要改（只改一部分会一半出现一半消失）')
    assert.equal(value.total, 3)
    assert.deepEqual(value.failures, [])
    assert.match(value.coldMemoryId, /^coldref-/, '冷引用必须有 id，否则调用方无从回收')

    const cold = coldWrites(es)[0]
    assert.ok(cold, '必须写冷引用 —— 没有冷引用的归档等于失踪')
    assert.match(cold.body, /doc_id: doc-1/, '冷引用正文必须带 doc_id 才能被 memory_search 捡回来')
    assert.match(cold.body, /占满容量/, '归档原因要落进冷引用正文')
    // 审查 16b：归档时每个切片写**两次** —— 一次 status、一次 cold_memory_id
    // （后者给恢复用：没有它，恢复就只能按 content 模糊搜，代价大且会误伤别的文档）
    const statusWrites = sliceUpdates(es).filter((c) => c.body.includes('"status"'))
    const coldIdWrites = sliceUpdates(es).filter((c) => c.body.includes('cold_memory_id'))
    assert.equal(statusWrites.length, 3, '3 个切片各写一次 status')
    assert.equal(coldIdWrites.length, 3, '3 个切片各写一次 cold_memory_id（16b）')
    assert.match(coldIdWrites[0].body, /"cold_memory_id":"coldref-/, '写回的必须是刚生成的那个冷引用 id')
  } finally {
    await es.close()
  }
})

test('归档：部分切片失败 → failures 逐条列出，仍返回 200（部分成功不算全败）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0', 'd1-1', 'd1-2'], failUpdateFor: ['d1-1'] })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 200, `部分失败不该整体报错：${res.body}`)
    const value = JSON.parse(res.body).value
    assert.equal(value.chunks, 2)
    assert.equal(value.total, 3)
    assert.equal(value.failures.length, 1, `要报出是哪一片失败，实际 ${JSON.stringify(value.failures)}`)
    assert.match(value.failures[0], /d1-1/, 'failures 必须带切片 id，否则运维没法定位')
    assert.match(value.coldMemoryId, /^coldref-/, '部分成功时冷引用照写（归档确实生效了）')
  } finally {
    await es.close()
  }
})

// ── 16b：归档→恢复必须清掉冷引用（2026-11-11）────────────────────────────
// 不清理的话：personal_memory 里永远留一条「【已归档文档】…」的记忆，而文档其实
// 已经活了 —— 它还会被 memory_search 命中，指路的却是一篇并未归档的文档。
// 根因是 restore 手上只有 docId，而冷引用 id 是 `coldref-<8位>-<ts>`，没有反向索引；
// 解法是归档时把 id 写回切片，恢复时按它**精确**删。
test('恢复：按切片上的 cold_memory_id 精确删掉冷引用（16b）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0', 'd1-1'], sliceColdRef: 'coldref-doc1-abc' })
  try {
    const res = fakeRes()
    await handleDocRestore(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 200, `实际 ${res.statusCode}: ${res.body}`)
    const value = JSON.parse(res.body).value
    assert.equal(value.status, 'active')
    // 两个切片共用同一个冷引用 → 只该删一次（去重）
    const dels = es.calls.filter((c) => c.method === 'DELETE')
    assert.equal(dels.length, 1, `两个切片共用一个冷引用，只该删一次，实际 ${dels.length} 次`)
    assert.match(
      dels[0].url,
      /\/personal_memory_xqh\/_doc\/coldref-doc1-abc/,
      '删的必须是冷引用 id，不能是切片 id',
    )
    assert.match(value.note, /已清理 1\/1/, `note 要说明清了几条，实际 ${JSON.stringify(value.note)}`)
  } finally {
    await es.close()
  }
})

test('恢复：老文档没有 cold_memory_id → 不发删除、不报错（向后兼容）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0'] }) // 不给 sliceColdRef
  try {
    const res = fakeRes()
    await handleDocRestore(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 200, `缺字段不该让恢复失败：${res.body}`)
    assert.equal(
      es.calls.filter((c) => c.method === 'DELETE').length,
      0,
      '没有冷引用 id 就不该删任何东西（猜着删会误伤别的记忆）',
    )
    assert.equal(JSON.parse(res.body).value.note, '', '没东西可清时 note 留空')
  } finally {
    await es.close()
  }
})

test('恢复：冷引用已被手删（DELETE 404）→ 按清理成功算，保持幂等', async () => {
  const es = await startFakeEs({
    docSlices: ['d1-0'],
    sliceColdRef: 'coldref-gone-x',
    deleteStatus: 404,
  })
  try {
    const res = fakeRes()
    await handleDocRestore(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 200, `404 不该让恢复失败：${res.body}`)
    const value = JSON.parse(res.body).value
    assert.match(value.note, /已清理 1\/1/, '本来就没了也算清理成功，否则重跑会一直报失败')
    assert.deepEqual(value.failures, [], '404 不该进 failures')
  } finally {
    await es.close()
  }
})

test('归档：一条都没改成 → 500，且不写冷引用（不能留一条指向未归档文档的指路条）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0', 'd1-1'], failUpdateFor: ['d1-0', 'd1-1'] })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 500)
    assert.match(JSON.parse(res.body).error, /一条都没改成功/)
    assert.equal(coldWrites(es).length, 0, '全败时绝不能写冷引用 —— 那会指向一篇没归档的文档')
  } finally {
    await es.close()
  }
})

test('归档：冷引用写失败 → 降级提示，但归档本身仍成功（不回滚成半成品）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0'], coldRefFail: true })
  try {
    const res = fakeRes()
    await handleDocArchive(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 200, `冷引用失败不该让归档整体失败：${res.body}`)
    const value = JSON.parse(res.body).value
    assert.equal(value.chunks, 1, '切片状态已经改成功了')
    assert.equal(value.coldMemoryId, '', '写失败时必须把 id 清空，不能让调用方以为拿到了可用引用')
    assert.match(value.note, /冷引用写入失败/, '要给出可读提示，而不是静默')
  } finally {
    await es.close()
  }
})

test('恢复：改成 active，且**不写**冷引用（恢复不是归档，不该留「已归档」条）', async () => {
  const es = await startFakeEs({ docSlices: ['d1-0', 'd1-1'] })
  try {
    const res = fakeRes()
    await handleDocRestore(ctxWithEs(DOC_ADMIN, es.url), res, postReq({ docId: 'doc-1' }))
    assert.equal(res.statusCode, 200, `实际 ${res.statusCode}: ${res.body}`)
    const value = JSON.parse(res.body).value
    assert.equal(value.status, 'active')
    assert.equal(value.chunks, 2)
    assert.equal(value.coldMemoryId, '')
    assert.equal(coldWrites(es).length, 0, '恢复路径不写冷引用（29.5 那个「不清理」是另一条待办）')
  } finally {
    await es.close()
  }
})

// ── 维护页收拢到管理员 + 跨用户查看（2026-10-29）─────────────────────────
const MEMBER = { userId: 'lisi', username: 'mem-user-lisi', password: 'pw', teamWrite: false }

test('维护概览：非管理员 403，且一次都不碰 ES', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleMaintenanceGet(ctxWithEs(MEMBER, es.url), res)
    assert.equal(res.statusCode, 403, '维护页只有管理员能看，不能靠"界面没入口"兜底')
    assert.equal(es.calls.length, 0)
  } finally {
    await es.close()
  }
})

test('用户列表：非管理员 403', async () => {
  const es = await startFakeEs({ indexBuckets: [{ key: 'personal_memory_xqh', doc_count: 3 }] })
  try {
    const res = fakeRes()
    await handleUsers(ctxWithEs(MEMBER, es.url), res)
    assert.equal(res.statusCode, 403)
    assert.equal(es.calls.length, 0)
  } finally {
    await es.close()
  }
})

test('用户列表：管理员拿到 [_index] 聚合并剥掉前缀', async () => {
  const es = await startFakeEs({
    indexBuckets: [
      { key: 'personal_memory_xqh', doc_count: 268 },
      { key: 'personal_memory_laoliu', doc_count: 5 },
    ],
  })
  try {
    const res = fakeRes()
    await handleUsers(ctxWithEs(SINGLE, es.url), res)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.self, 'xqh')
    assert.deepEqual(body.value.users, [
      { userId: 'xqh', count: 268 },
      { userId: 'laoliu', count: 5 },
    ])
    // 通配索引名必须原样发出去（encodeURIComponent 不会编码 *）
    assert.ok(es.calls.some((c) => c.url.startsWith('/personal_memory_*/_search')), '要查通配索引才能跨用户聚合')
  } finally {
    await es.close()
  }
})

test('记忆浏览：管理员带 user 就查那个人的个人库', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleMemories(ctxWithEs(SINGLE, es.url), res, new URL('http://x/memories?scope=personal&user=laoliu'))
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.userId, 'laoliu')
    assert.equal(body.value.viewingOther, true)
    assert.ok(es.calls.some((c) => c.url.startsWith('/personal_memory_laoliu/_search')))
    assert.ok(!es.calls.some((c) => c.url.startsWith('/personal_memory_xqh/_search')), '不该同时查自己的库')
  } finally {
    await es.close()
  }
})

test('记忆浏览：普通成员带 user 也只能看自己', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleMemories(ctxWithEs(MEMBER, es.url), res, new URL('http://x/memories?scope=personal&user=xqh'))
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.userId, 'lisi', 'user 参数对非管理员无效')
    assert.equal(body.value.viewingOther, false)
    assert.ok(es.calls.some((c) => c.url.startsWith('/personal_memory_lisi/_search')))
  } finally {
    await es.close()
  }
})

// ── 入参校验：user 白名单 / export 目录白名单（2026-10-29 审计修复）──────
const { handleExport } = panel

test('记忆浏览：user 传通配符 → 400（不给拼索引名的机会）', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleMemories(ctxWithEs(SINGLE, es.url), res, new URL('http://x/memories?user=*'))
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /不合法/)
    assert.equal(es.calls.length, 0, '参数不合格不该碰 ES')
  } finally {
    await es.close()
  }
})

test('记忆浏览：user 带路径分隔符 → 400', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleMemories(ctxWithEs(SINGLE, es.url), res, new URL('http://x/memories?user=../admin'))
    assert.equal(res.statusCode, 400)
  } finally {
    await es.close()
  }
})

test('导出：目录越界 → 400（不能写任意路径）', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleExport(ctxWithEs(SINGLE, es.url), res, postReq({ dir: '/etc/cron.d' }))
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /镜像目录|必须位于/)
  } finally {
    await es.close()
  }
})

test('维护概览：带 user 时统计那个人的个人库', async () => {
  const es = await startFakeEs()
  try {
    const res = fakeRes()
    await handleMaintenanceGet(ctxWithEs(SINGLE, es.url), res, new URL('http://x/maintenance?user=laoliu'))
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.userId, 'laoliu')
    assert.equal(body.value.viewingOther, true)
    assert.ok(es.calls.some((c) => c.url.startsWith('/personal_memory_laoliu/_search')), '统计要落到目标用户的索引')
    assert.ok(!es.calls.some((c) => c.url.startsWith('/personal_memory_xqh/_search')))
    // 文档数不再是 '-'：接口要真的返回这个字段，且落到目标用户的文档索引
    assert.equal(body.value.counts.docs, 42)
    assert.ok(es.calls.some((c) => c.url.startsWith('/personal_doc_laoliu/_search')))
  } finally {
    await es.close()
  }
})

test('可编辑字段白名单：es.url / caCertPath 必须不可写（凭据外发面）', async () => {
  const { EDITABLE } = await import('../panel/index.js')
  const keys = EDITABLE.map((field) => field.path.join('.'))
  // 这两个字段决定「Basic Auth 凭据发往哪个地址」，可写 = 会话被盗就能把管理员凭据导走；
  // 而且改完本来也要重启才生效，收益不比手改 profile 高。
  assert.equal(keys.includes('es.url'), false, 'es.url 不该出现在面板可写字段里')
  assert.equal(keys.includes('es.caCertPath'), false, 'caCertPath 不该出现在面板可写字段里')
  // 2026-11-02 评审追加：embedding.url 是「正文发给谁」的开关、index.team 是租户开关、
  // dims 必须与索引 mapping 一致 —— 三个都不能从面板改。
  for (const forbidden of ['embedding.url', 'embedding.dims', 'index.team']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} 不该出现在面板可写字段里`)
  }
  // 反面：其余字段仍在白名单里（别为了安全把整个配置面关死）
  for (const needed of ['es.requestTimeoutMs', 'embedding.model', 'persona.seed', 'journal.at', 'traits.days', 'retrieval.abstainOnLowConfidence']) {
    assert.ok(keys.includes(needed), `${needed} 应当仍可编辑`)
  }
})

// ── 表情包预览：宿主从这里把图片读给浏览器，是新增的对外读取面，规则要钉住 ──────
function fakeBinaryRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body
    },
  }
}

function stickerCtx(dir) {
  return {
    get: (name) =>
      name === 'configEditor'
        ? {
            configuration: () => [
              {
                entry: { id: 'dsh-memory-es' },
                // findEntryRow 要「真的带 es.url + userId」的行才算数（空条目会被跳过）
                // 写接口现在要求管理员（canReviewTeam）：给单账号 + teamWrite
                inherited: {
                  es: { url: 'https://example:9200' },
                  identity: { userId: 'xqh', username: 'mem-user-xqh', password: 'x', teamWrite: true },
                  stickers: { dir },
                },
                override: undefined,
              },
            ],
          }
        : undefined,
  }
}

test('写接口门禁：非管理员 POST /config 与新增表情包一律 403（2026-11-02 评审）', async () => {
  const { handleConfigWrite, handleStickerAdd } = await import('../panel/index.js')
  // 非管理员：单账号但没有 teamWrite，也没有 consolidator
  const ctx = {
    get: (name) =>
      name === 'configEditor'
        ? {
            configuration: () => [
              {
                entry: { id: 'dsh-memory-es' },
                inherited: { es: { url: 'https://example:9200' }, identity: { userId: 'xqh' } },
                override: undefined,
              },
            ],
          }
        : undefined,
  }
  const body = (value) => ({ on() {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)) } })

  const res1 = fakeRes()
  await handleConfigWrite(ctx, res1, body({ confirm: true, changes: [{ key: 'persona.seed', value: 'x', type: 'string' }] }))
  assert.equal(res1.statusCode, 403, `config 写接口应 403，实际 ${res1.statusCode}`)

  const res2 = fakeRes()
  await handleStickerAdd(ctx, res2, {
    on() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ label: 'x', when: 'y', file: '' }))
    },
  })
  assert.equal(res2.statusCode, 403, `表情包新增应 403，实际 ${res2.statusCode}`)
})

test('写接口白名单：即便管理员也不能改 embedding.url / dims / index.team（2026-11-02）', async () => {
  const { handleConfigWrite } = await import('../panel/index.js')
  // handleConfigWrite 直接读 ctx.configEditor（不走 ctx.get），而 requireAdmin 走 get('configEditor') —— 两个形状都要给
  const configEditor = {
    configuration: () => [
      {
        entry: { id: 'dsh-memory-es' },
        inherited: {
          es: { url: 'https://example:9200' },
          identity: { userId: 'xqh', username: 'mem-user-xqh', password: 'x', teamWrite: true },
        },
        override: undefined,
      },
    ],
    edit: async () => {},
  }
  const ctx = { configEditor, get: (name) => (name === 'configEditor' ? configEditor : undefined) }
  /** readJsonBody 走 req.on('data'|'end')，假的 req 必须真的触发这两个事件 */
  const fakeReq = (value) => {
    const handlers = {}
    const req = {
      on(event, fn) {
        ;(handlers[event] ??= []).push(fn)
        return req
      },
    }
    queueMicrotask(() => {
      const buf = Buffer.from(JSON.stringify(value))
      for (const fn of handlers.data ?? []) fn(buf)
      for (const fn of handlers.end ?? []) fn()
    })
    return req
  }
  for (const key of ['embedding.url', 'embedding.dims', 'index.team']) {
    const res = fakeRes()
    await handleConfigWrite(ctx, res, fakeReq({ confirm: true, changes: [{ key, value: 'x', type: 'string' }] }))
    assert.equal(res.statusCode, 400, `${key} 应被白名单拒绝，实际 ${res.statusCode}`)
    assert.match(res.body, /不可修改的字段/)
  }
})

test('buildCoverage：三级口径分开说（2026-11-02 星图截断诚实）', async () => {
  const { buildCoverage } = await import('../panel/index.js')

  // 全取全画：不算截断
  const full = buildCoverage({ personal: 5, team: 3 }, { personal: 5, team: 3 }, 8)
  assert.equal(full.truncated, false)
  assert.deepEqual(full.reasons, [])
  assert.equal(full.totalCount, 8)

  // 索引里有 20 条、只取到 8 条 → 「候选未取全」
  const sampled = buildCoverage({ personal: 20 }, { personal: 8 }, 8)
  assert.equal(sampled.truncated, true)
  assert.deepEqual(sampled.reasons, ['sampled'])

  // 取到 8 条、只画 5 个 → 「节点上限」
  const limited = buildCoverage({ personal: 8 }, { personal: 8 }, 5)
  assert.equal(limited.truncated, true)
  assert.deepEqual(limited.reasons, ['limited'])

  // 两级同时发生：两个原因都要报出来，不能只留一个
  const both = buildCoverage({ personal: 50 }, { personal: 10 }, 4)
  assert.deepEqual(both.reasons, ['sampled', 'limited'])
})

test('resolveStickerDir：~ 开头的按家目录展开，绝对路径原样', async () => {
  const { resolveStickerDir } = await import('../panel/index.js')
  const home = os.homedir()
  assert.equal(resolveStickerDir({ value: { stickers: { dir: '~/.dsh/stickers' } } }), path.join(home, '.dsh/stickers'))
  assert.equal(resolveStickerDir({ value: { stickers: { dir: '~' } } }), home)
  assert.equal(resolveStickerDir({ value: { stickers: { dir: '/srv/pics' } } }), '/srv/pics')
  // 没配就回落默认目录，不能变成"读当前工作目录"
  assert.equal(resolveStickerDir({ value: {} }), path.join(home, '.dsh/stickers'))
})

test('表情包预览：只读同目录图片，路径穿越与非图片一律 400', async () => {
  const { handleStickerImageGet } = await import('../panel/index.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sticker-'))
  fs.writeFileSync(path.join(dir, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(dir, 'note.txt'), 'not an image')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'inner.png'), 'x')
  // 上级目录的图片：用来验证 ../ 被挡住
  fs.writeFileSync(path.join(os.tmpdir(), 'mem-sticker-outside.png'), 'x')

  const ctx = stickerCtx(dir)
  const call = (file) => {
    const res = fakeBinaryRes()
    return handleStickerImageGet(ctx, res, new URL(`http://x/sticker?file=${encodeURIComponent(file)}`)).then(() => res)
  }

  const ok = await call('ok.png')
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.headers['content-type'], 'image/png')
  assert.ok(Buffer.isBuffer(ok.body), '图片必须按二进制原样返回')

  // 这三条是安全边界：能读到目录外、能读非图片、能靠子目录绕，都等于把宿主文件系统开了个口子
  for (const [file, why] of [
    ['../mem-sticker-outside.png', '上级目录'],
    ['sub/inner.png', '子目录'],
    ['/etc/passwd', '绝对路径'],
    ['note.txt', '非图片文件'],
    ['ok.svg', 'svg（可带脚本）'],
  ]) {
    const res = await call(file)
    assert.equal(res.statusCode, 400, `${why} 应当被拒绝：${file}`)
  }

  const missing = await call('none.png')
  assert.equal(missing.statusCode, 404)
  assert.match(String(missing.body), /文件不存在/)
})

// ── 表情包新增：面板里唯一「写宿主磁盘」的接口，边界必须一条条钉住 ──────────────
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
const STICKER_PNG_URL = `data:image/png;base64,${PNG_HEAD.toString('base64')}`

function stickerUpload(payload) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST' })
}

test('表情包新增：合法上传落盘并追加进 stickers.json，且保留原有其它字段', async () => {
  const { handleStickerAdd } = await import('../panel/index.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sticker-add-'))
  // 已有的 maxPerTurn 必须原样保留：这是用户配的，不是本接口该管的字段
  fs.writeFileSync(path.join(dir, 'stickers.json'), JSON.stringify({ version: 1, maxPerTurn: 2, items: [] }))

  const res = fakeRes()
  await handleStickerAdd(stickerCtx(dir), res, stickerUpload({
    label: '委屈',
    when: '被否了方案、想撒娇但又不太服气',
    note: '低头撇嘴',
    file: { name: 'pout-2.png', dataUrl: STICKER_PNG_URL },
  }))
  assert.equal(res.statusCode, 200, res.body)
  const body = JSON.parse(res.body)
  assert.equal(body.value.file, 'pout-2.png')
  assert.equal(body.value.id, 'custom-1', '自定义表情按 custom-N 递增，不占用内置 id')
  assert.equal(body.value.total, 1)
  assert.ok(fs.existsSync(path.join(dir, 'pout-2.png')), '图片必须真的落到表情包目录')

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'stickers.json'), 'utf8'))
  assert.equal(doc.items.length, 1)
  assert.equal(doc.items[0].when, '被否了方案、想撒娇但又不太服气')
  assert.equal(doc.items[0].note, '低头撇嘴')
  assert.equal(doc.maxPerTurn, 2, 'maxPerTurn 不能被写丢')
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith('stickers.json.bak-')),
    true,
    '写清单前必须留一份备份',
  )
})

test('表情包新增：缺 when / svg / 超大 / 重名 / 穿越文件名 / 坏 JSON 各自的处理', async () => {
  const { handleStickerAdd } = await import('../panel/index.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sticker-reject-'))
  fs.writeFileSync(path.join(dir, 'dup.png'), PNG_HEAD)
  fs.writeFileSync(path.join(dir, 'stickers.json'), JSON.stringify({ version: 1, items: [] }))
  const ctx = stickerCtx(dir)
  const call = async (payload) => {
    const res = fakeRes()
    await handleStickerAdd(ctx, res, stickerUpload(payload))
    return res
  }
  const base = { label: 'x', when: 'y', file: { name: 'a.png', dataUrl: STICKER_PNG_URL } }

  // 「什么时候用」是模型判断的唯一依据，空着等于这张图永远贴不出来
  const noWhen = await call({ ...base, when: '   ' })
  assert.equal(noWhen.statusCode, 400)
  assert.match(JSON.parse(noWhen.body).error, /什么时候用/)

  const svg = await call({
    ...base,
    file: { name: 'a.svg', dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` },
  })
  assert.equal(svg.statusCode, 400, 'svg 能带脚本，与预览接口保持同一口径：一律拒')

  const dup = await call({ ...base, file: { name: 'dup.png', dataUrl: STICKER_PNG_URL } })
  assert.equal(dup.statusCode, 409, '同名文件是用户自己放的，不覆盖')

  // 穿越：取 basename 后只落在本目录内，绝不能写到目录外
  const traversal = await call({ ...base, file: { name: '../../evil.png', dataUrl: STICKER_PNG_URL } })
  assert.equal(traversal.statusCode, 200, traversal.body)
  assert.equal(fs.existsSync(path.join(dir, 'evil.png')), true)
  assert.equal(fs.existsSync(path.join(dir, '..', '..', 'evil.png')), false, '不能写到表情包目录之外')

  // 5.5 MiB 的图：过得了 8 MiB 的请求体上限，被单张 5 MiB 的上限挡住
  const huge = await call({
    ...base,
    file: { name: 'big.png', dataUrl: `data:image/png;base64,${Buffer.alloc(5.5 * 1024 * 1024).toString('base64')}` },
  })
  assert.equal(huge.statusCode, 413)

  // 坏 JSON：宁可报错，也不能把用户手写到一半的清单覆盖掉
  fs.writeFileSync(path.join(dir, 'stickers.json'), '{ broken')
  const broken = await call({ ...base, file: { name: 'b.png', dataUrl: STICKER_PNG_URL } })
  assert.equal(broken.statusCode, 500)
  assert.equal(fs.readFileSync(path.join(dir, 'stickers.json'), 'utf8'), '{ broken')
})

// ── 顶层路由器（2026-11-11 审查 #32）────────────────────────────────────
// 两个缺口：① 405 守卫夹在路由表**中间**，语义是「非 GET 一律 405」——
//   任何 POST 路由排到它后面就会被吞成 405（identity/review 踩过）。
//   原来只钉了 `/stickers/add` 一条；这里扫**全部** POST 路由。
// ② `handle()` 本身从未被调用过：方法过滤 / 404 / 「POST 能穿过去」都没测。
test('顶层路由：**所有** POST 路由都必须排在 405 兜底之前', async () => {
  const source = fs.readFileSync(new URL('../panel/index.js', import.meta.url), 'utf8')
  const guardAt = source.indexOf("req.method !== 'GET'")
  assert.ok(guardAt > 0, '找不到 405 兜底，测试的前提变了')

  // 路由表里两形态：`path === '…' && req.method === 'POST'`，以及 review 那条
  // `req.method === 'POST' && reviewMatch`（正则路由，path 是动态的）。
  const postRouteRe = /(?:path === '[^']+'[^\n]*?req\.method === 'POST'|req\.method === 'POST' && reviewMatch)/g
  const hits = [...source.matchAll(postRouteRe)].map((m) => ({ text: m[0].trim(), at: m.index ?? 0 }))
  assert.ok(hits.length >= 8, `只找到 ${hits.length} 条 POST 路由，正则可能已失效（先修正则再信任这条测试）`)

  const late = hits.filter((h) => h.at > guardAt)
  assert.deepEqual(
    late.map((h) => h.text),
    [],
    '这些 POST 路由排在 405 兜底之后，请求会被吞成 405；'
    + '要么把它挪到 `req.method !== \'GET\'` 之前，要么把它改成不受该守卫影响的写法',
  )
})

test('顶层路由：405 / 404 / 方法过滤的先后（handle 从未被测过）', async () => {
  const { handle } = await import('../panel/index.js')
  const es = await startFakeEs({ docSlices: ['d1-0'] })
  try {
    const ctx = ctxWithEs(DOC_MEMBER, es.url)
    /** 造一条带 url 的请求（postReq 没有 url，不能直接用） */
    const reqWith = (method, url, payload) =>
      Object.assign(
        Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]),
        { method, url },
      )

    // ① POST 到只支持 GET 的路径 → 405（不是 404，也不是真的执行）
    let res = fakeRes()
    await handle(ctx, reqWith('POST', '/overview'), res)
    assert.equal(res.statusCode, 405, `实际 ${res.statusCode}: ${res.body}`)
    assert.match(JSON.parse(res.body).error, /只支持 GET/)

    // ② GET 到不存在的路径 → 404，且报错里带路径（排查时能知道打到了哪）
    res = fakeRes()
    await handle(ctx, reqWith('GET', '/no-such-endpoint-zzz'), res)
    assert.equal(res.statusCode, 404)
    assert.match(JSON.parse(res.body).error, /未知接口/)
    assert.match(JSON.parse(res.body).error, /no-such-endpoint-zzz/)

    // ③ POST 到不存在的路径 → 405（方法过滤比路径更早 —— 这正是 405 夹在路由表中间的后果）
    res = fakeRes()
    await handle(ctx, reqWith('POST', '/no-such-endpoint-zzz'), res)
    assert.equal(res.statusCode, 405)

    // ④ POST 到**真实**的 POST 路由 → 必须穿过 405 守卫进到 handler。
    // 用非管理员身份：期望 403（handler 的权限判定），**不是** 405（被守卫吞掉）。
    res = fakeRes()
    await handle(ctx, reqWith('POST', '/maintenance/doc-archive', { docId: 'doc-1' }), res)
    assert.equal(
      res.statusCode,
      403,
      `POST 路由没穿过去：拿到 ${res.statusCode}（405 就是被兜底吞了）: ${res.body}`,
    )
    assert.match(JSON.parse(res.body).error, /管理员/)
  } finally {
    await es.close()
  }
})

// ── 星图构图：度数上限与节点上限决定了图是"能看"还是"一团毛球" ────────────
const { buildGraph } = await import('../panel/index.js')

const nodeOf = (id, extra = {}) => ({
  id,
  scope: 'personal',
  label: id,
  type: 'fact',
  domain: extra.domain ?? 'general',
  updatedAt: extra.updatedAt ?? '2026-10-01T00:00:00Z',
  status: 'active',
})

test('buildGraph：A→B 与 B→A 是同一条边，权重取大', () => {
  const graph = buildGraph(
    [nodeOf('a'), nodeOf('b')],
    [
      { source: 'a', target: 'b', weight: 0.6 },
      { source: 'b', target: 'a', weight: 0.7 },
    ],
  )
  assert.equal(graph.edges.length, 1, '无向图里两点之间只能有一条边')
  assert.equal(graph.edges[0].weight, 0.7)
  assert.equal(graph.stats.nodes, 2)
  assert.equal(graph.stats.edges, 1)
})

test('buildGraph：单点度数不超过上限（防毛球）', () => {
  const hub = nodeOf('hub')
  const leaves = Array.from({ length: 20 }, (_, i) => nodeOf(`leaf${i}`))
  const edges = leaves.map((leaf, i) => ({ source: 'hub', target: leaf.id, weight: 0.6 + i / 100 }))
  const graph = buildGraph([hub, ...leaves], edges, { limit: 100, maxDegree: 3 })
  const hubNode = graph.nodes.find((node) => node.id === 'hub')
  assert.ok(hubNode.degree <= 3, `度数应为 3，实际 ${hubNode.degree}`)
  // 留的是权重最高的三条（索引末尾那几个）
  const linked = graph.edges.map((edge) => (edge.source === 'hub' ? edge.target : edge.source))
  assert.deepEqual(linked.sort(), ['leaf17', 'leaf18', 'leaf19'])
})

test('buildGraph：节点上限按「度数 → 新鲜度」，孤立点沉底', () => {
  const connected = [nodeOf('a', { updatedAt: '2026-10-01T00:00:00Z' }), nodeOf('b', { updatedAt: '2026-10-01T00:00:00Z' })]
  const fresh = nodeOf('fresh', { updatedAt: '2026-11-01T00:00:00Z' })
  const old = nodeOf('old', { updatedAt: '2025-01-01T00:00:00Z' })
  const graph = buildGraph(
    [...connected, fresh, old],
    [{ source: 'a', target: 'b', weight: 0.7 }],
    { limit: 3 },
  )
  assert.deepEqual(graph.nodes.map((node) => node.id).slice(0, 2).sort(), ['a', 'b'], '有边的先留下')
  assert.equal(graph.nodes.length, 3)
  // 剩下一个名额给更新的孤立点
  assert.ok(graph.nodes.some((node) => node.id === 'fresh'))
  assert.equal(graph.stats.orphans, 1, 'fresh 是孤儿，应当计入统计')
})

test('buildGraph：指向取不到端点的边计入 unresolved，不入图', () => {
  const graph = buildGraph(
    [nodeOf('a')],
    [
      { source: 'a', target: 'missing', weight: 0.8 },
      { source: 'a', target: 'a', weight: 0.9 },
    ],
  )
  assert.equal(graph.edges.length, 0, '自环与被裁掉的端点都不该出现在边里')
  assert.equal(graph.stats.unresolved, 1)
  assert.equal(graph.stats.orphans, 1)
})

test('buildGraph：按 domain 分团，计数与节点一致', () => {
  const graph = buildGraph(
    [nodeOf('a', { domain: 'lottery-cloud' }), nodeOf('b', { domain: 'lottery-cloud' }), nodeOf('c', { domain: 'huoxin-data' })],
    [{ source: 'a', target: 'b', weight: 0.7 }],
  )
  const total = graph.clusters.reduce((sum, cluster) => sum + cluster.count, 0)
  assert.equal(total, graph.nodes.length)
  assert.equal(graph.clusters[0].domain, 'lottery-cloud')
  assert.equal(graph.clusters[0].count, 2)
})

test('配置页字段都带 default，且与 schema 的默认值一致', () => {
  // 为什么值得钉：GET /config 读的是「配置行里显式写了什么」，不是运行中的合并配置。
  // 字段不带 default 时，未配置的数值会被渲染成 0 —— 用户会以为生效值是 0（2026-11-01 真踩）。
  const { readFileSync } = process.getBuiltinModule('node:fs')
  const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
  const schemaDefault = (key) => {
    // 只看 `key: z....default(x)` 那一行（dedupMinScore 是 dedupMinScoreAnchored 的前缀，必须精确）
    const match = src.match(new RegExp(`^\\s*${key}:\\s*z\\.[^\\n]*?default\\(([^)]+)\\)`, 'm'))
    return match ? match[1].trim() : null
  }

  for (const field of EDITABLE) {
    assert.ok(Object.hasOwn(field, 'default'), `${field.path.join('.')} 缺 default：未配置时会显示 0`)
  }

  // 只对「容易被误当成 0」的数值字段做 schema 对照（其余字段由上一行的存在性断言兜住）
  for (const key of ['maxPerDay', 'maxOutput', 'dedupMinScore', 'dedupMinScoreAnchored', 'days']) {
    const field = EDITABLE.find((item) => item.path.join('.').endsWith(`.${key}`))
    // 2026-11-11 审查 #33：原来是 `if (!field) continue` —— 把这个字段从 EDITABLE
    // 删掉（或改名）时对照会**静默消失**，测试照样绿。改成硬断言：要动这份名单，
    // 就得同时改这里，否则这条测试立刻红。
    assert.ok(
      field !== undefined,
      `EDITABLE 里找不到 ${key}：字段被删/改名了？那这条「default 与 schema 一致」的对照就静默失效了`,
    )
    const expected = schemaDefault(key)
    assert.ok(expected !== null, `config.ts 里找不到 ${key} 的 default`)
    assert.equal(String(field.default), expected, `${field.path.join('.')} 的 default 与 schema 不一致`)
  }
})

test('classifyCluster：覆盖率三档的口径', () => {
  // 一次都没命中 = 内容缺口（最值钱的那张清单）
  assert.equal(classifyCluster({ maxHits: 0, notes: {} }).status, 'miss')
  // 答上过也漏过：要看「有漏答」，不能因为后来答上了就抹掉缺口
  assert.equal(classifyCluster({ maxHits: 3, notes: { ok: 2, no_match: 1 } }).status, 'mixed')
  // 答上了但低置信：候选区分度不足
  assert.equal(classifyCluster({ maxHits: 2, notes: { low_confidence: 2 } }).status, 'low')
  // 正常命中
  assert.equal(classifyCluster({ maxHits: 2, notes: { ok: 2 } }).status, 'hit')
  // max(hits) 缺失时按 0 处理，不抛错
  assert.equal(classifyCluster({ notes: {} }).status, 'miss')
})

test('indexNames：没显式配置的前缀要兜底（面板读的是「写了什么」，不是 schema 默认）', () => {
  // 2026-11-01 自检踩过：searchLogPrefix 没写 → 拼出 `undefinedxqh` → ES 403
  const names = indexNames({
    index: { personalPrefix: 'personal_memory_', team: 'team_knowledge' },
    identity: { userId: 'xqh' },
  })
  assert.equal(names.searchLog, 'search_log_xqh')
  assert.equal(names.docs, 'personal_doc_xqh')
  assert.equal(names.personalAudit, 'personal_audit_xqh')
})

test('feedbackScript：👍 记 confirmed_use、👎 记 corrections，未知类型抛错', () => {
  const now = '2026-11-01T12:00:00.000Z'
  const up = feedbackScript('useful', now)
  assert.match(up.source, /confirmed_use \+= 1/)
  assert.doesNotMatch(up.source, /corrections \+= 1/)
  assert.equal(up.params.now, now, '时间戳来自调用方，脚本不自己取')

  const down = feedbackScript('wrong', now)
  assert.match(down.source, /corrections \+= 1/)
  assert.doesNotMatch(down.source, /confirmed_use \+= 1/)

  assert.throws(() => feedbackScript('meh'), /未知反馈类型/)
})

test('projectHit：反馈计数缺失按 0（0 是真实值，不是「没数据」）', () => {
  const bare = projectHit({ _id: 'es-1', _source: { memory_id: 'm1' } }, 'personal')
  assert.equal(bare.confirmedUse, 0)
  assert.equal(bare.corrections, 0)
  const scored = projectHit(
    { _id: 'es-2', _source: { memory_id: 'm2', confirmed_use: 3, corrections: 1, feedback_at: '2026-11-01T12:00:00.000Z' } },
    'personal',
  )
  assert.equal(scored.confirmedUse, 3)
  assert.equal(scored.corrections, 1)
  assert.equal(scored.feedbackAt, '2026-11-01T12:00:00.000Z')
})


test('summarizeInjectRecords：四态分开统计，超时率与注入率各算各的', () => {
  const records = [
    { outcome: 'injected', ms: 80, chars: 400, items: [{ memory_id: 'a' }, { memory_id: 'b' }], dropped: [{ memory_id: 'z' }] },
    { outcome: 'injected', ms: 120, chars: 200, items: [{ memory_id: 'c' }] },
    { outcome: 'timeout', ms: 500, chars: 0, items: [] },
    { outcome: 'low_confidence', ms: 90, chars: 0, items: [] },
  ]
  const stats = summarizeInjectRecords(records)
  assert.equal(stats.total, 4)
  assert.equal(stats.byOutcome.injected, 2)
  assert.equal(stats.timeoutRate, 0.25, '超时率只数 timeout，不能把 low_confidence 也算进去')
  assert.equal(stats.injectedRate, 0.5)
  // 条均/字符均只按**真正注入成功的**那几条算，否则被拦下的会把均值拉低到没意义
  assert.equal(stats.avgItems, 1.5)
  assert.equal(stats.avgChars, 300)
  assert.equal(stats.droppedTotal, 1)
  assert.equal(stats.avgMs, 198)
})

test('summarizeInjectRecords：空输入不产生 NaN', () => {
  const stats = summarizeInjectRecords([])
  assert.equal(stats.total, 0)
  assert.equal(stats.timeoutRate, 0)
  assert.equal(stats.injectedRate, 0)
  assert.equal(stats.avgItems, 0)
  assert.equal(stats.avgMs, 0)
})


test('handleInjectLog 必须包在 { ok, value } 里（前端 apiGet 取的是 body.value）', async () => {
  // 2026-11-06 踩过：直接摊开 { ok, stats, records } 时，前端拿到 data=undefined，
  // 页面只剩一行说明、一个数都不显示，而接口本身是 200 —— 光看网络面板看不出来。
  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(chunk) { this.body = chunk },
  }
  await handleInjectLog({}, res, new URL('http://localhost/inject-log?limit=3'))
  const body = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'value'), '响应必须带 value 包络')
  assert.ok(body.value && typeof body.value === 'object')
  assert.ok(Object.prototype.hasOwnProperty.call(body.value, 'stats'), 'value.stats 必须存在（哪怕为空统计）')
})

test('记忆浏览：搜索时给全局名次 rank，跨两库一起排（阶段 27）', async () => {
  // 名次必须是**合并后**的全局位置：个人 #1、团队 #2、个人 #3。
  // 如果只在页内算，翻到第 2 页又会从 1 开始——所以 rank 由后端算并随行下发。
  const server = createServer((req, res) => {
    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url.startsWith('/_security/user/_has_privileges')) return send({ has_all_requested: true, index: {} })
    if (req.url.includes('_search')) {
      const isPersonal = req.url.startsWith('/personal_memory_')
      const hits = isPersonal
        ? [
            { _id: 'p1', _score: 9.5, _source: { memory_id: 'p1', content: '个人最高分', status: 'active', updated_at: '2026-11-08T00:00:00Z' } },
            { _id: 'p2', _score: 3.2, _source: { memory_id: 'p2', content: '个人最低分', status: 'active', updated_at: '2026-11-07T00:00:00Z' } },
          ]
        : [
            { _id: 't1', _score: 6.1, _source: { doc_id: 't1', content: '团队中间分', status: 'active', review_state: 'approved', updated_at: '2026-11-06T00:00:00Z' } },
          ]
      return send({ hits: { total: { value: hits.length }, hits } })
    }
    return send({})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = fakeRes()
    await handleMemories(
      ctxWithEs(SINGLE, `http://127.0.0.1:${port}`),
      res,
      new URL('http://x/memories?scope=both&q=测试'),
    )
    assert.equal(res.statusCode, 200)
    const rows = JSON.parse(res.body).value.rows
    assert.equal(rows.length, 3, '两库各回 2/1 条')
    assert.deepEqual(rows.map((r) => r.id), ['p1', 't1', 'p2'], '按跨库可比的 score 降序')
    assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3], '名次是合并后的全局位置')
    assert.deepEqual(rows.map((r) => r.scope), ['personal', 'team', 'personal'], '来源路由随行下发，前端据此出徽标')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('记忆浏览：空查询按时间排，不冒充名次（rank 仍给但有 score 才展示）', async () => {
  // 空查询没有相关性可言，score 缺失即「不是在搜索」——前端靠这一点决定不显示 #N。
  const server = createServer((req, res) => {
    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url.startsWith('/_security/user/_has_privileges')) return send({ has_all_requested: true, index: {} })
    if (req.url.includes('_search')) {
      return send({
        hits: {
          total: { value: 1 },
          hits: [{ _id: 'p9', _source: { memory_id: 'p9', content: '按时间排的条目', status: 'active', updated_at: '2026-11-08T00:00:00Z' } }],
        },
      })
    }
    return send({})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = fakeRes()
    await handleMemories(
      ctxWithEs(SINGLE, `http://127.0.0.1:${port}`),
      res,
      new URL('http://x/memories?scope=personal'),
    )
    const rows = JSON.parse(res.body).value.rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].score, undefined, '空查询不该有 score——前端据此隐藏名次')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
