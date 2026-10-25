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

const { pendingQuery, indexNames, mergeConfig, projectHit, entryLabels, findEntryRow } = await import(
  '../panel/index.js'
)

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
