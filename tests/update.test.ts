/**
 * 自更新的纯函数测试：版本比较、到点判断、模板解析、字段差异、动作判定。
 *
 * 这里**不测**下载/解包/install.sh（要真网络与真文件系统），那部分由
 * `scripts/update-now.sh --dry-run` 在真机验证。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  compareVersions,
  diffMapping,
  isDue,
  parseTemplates,
  planUpdate,
  TEMPLATE_TO_INDEX_KIND,
} from '../src/update.ts'

test('版本比较：按数字段比，不能按字符串比', () => {
  // 字符串比较会把 "0.6.9" 判成大于 "0.6.54"，方向完全相反
  assert.equal(compareVersions('0.6.54', '0.6.9'), 1)
  assert.equal(compareVersions('0.6.9', '0.6.54'), -1)
  assert.equal(compareVersions('0.6.54', '0.6.54'), 0)
  // 带 v 前缀也要认
  assert.equal(compareVersions('v0.7.0', '0.6.54'), 1)
  // 位不足补 0
  assert.equal(compareVersions('0.6', '0.6.0'), 0)
})

test('到点判断：今天查过就不再查；没到点不查', () => {
  // 2026-11-11 07:00 北京时间 = 2026-11-10 23:00 UTC
  const morning = new Date('2026-11-10T23:00:00Z')
  assert.equal(isDue('06:00', 'Asia/Shanghai', undefined, morning), true)
  assert.equal(isDue('06:00', 'Asia/Shanghai', '2026-11-11', morning), false)
  // 05:00 还没到点
  const early = new Date('2026-11-10T21:00:00Z')
  assert.equal(isDue('06:00', 'Asia/Shanghai', undefined, early), false)
  // 昨天查过、今天过了点 → 该查
  assert.equal(isDue('06:00', 'Asia/Shanghai', '2026-11-10', morning), true)
})

test('模板解析：能从真实的 init-indices.sh 里取出四个模板', () => {
  const script = readFileSync(new URL('../scripts/init-indices.sh', import.meta.url), 'utf8')
  const templates = parseTemplates(script)
  const names = Object.keys(templates)
  for (const expected of Object.keys(TEMPLATE_TO_INDEX_KIND)) {
    assert.ok(names.includes(expected), `缺少模板 ${expected}，实际解析到：${names.join(', ')}`)
  }
  // 抽查一个字段：personal_memory_template 必须有 memory_id（keyword）
  const memory = templates.personal_memory_template!
  assert.equal((memory.memory_id as { type?: string }).type, 'keyword')
  // 文档模板里的冷引用字段（16b 加的）也要在
  assert.ok(templates.personal_doc_template!.cold_memory_id !== undefined)
})

test('模板解析：坏 JSON 的那段跳过，不影响其它模板', () => {
  const broken = [
    "es_quiet -X PUT \"$ES/_index_template/good_template\" -d @- <<'JSON'",
    '{"template":{"mappings":{"properties":{"a":{"type":"keyword"}}}}}',
    'JSON',
    "es_quiet -X PUT \"$ES/_index_template/bad_template\" -d @- <<'JSON'",
    '{ 这不是 JSON }',
    'JSON',
  ].join('\n')
  const templates = parseTemplates(broken)
  assert.deepEqual(Object.keys(templates), ['good_template'])
})

test('字段差异：新增、类型变化、历史多出的字段分开算', () => {
  const expected = {
    a: { type: 'keyword' },
    b: { type: 'date' },
    c: { type: 'text', analyzer: 'ik_max_word' },
  }
  const current = {
    a: { type: 'keyword' },
    b: { type: 'long' }, // 类型变了
    c: { type: 'text', analyzer: 'standard' }, // 分词器变了
    legacy: { type: 'keyword' }, // 模板里没有，历史遗留
  }
  const diff = diffMapping(expected, current)
  assert.deepEqual(diff.additions, [])
  assert.deepEqual(diff.typeChanges.map((item) => item.field).sort(), ['b', 'c'])
  assert.deepEqual(diff.extra, ['legacy'])
})

test('字段差异：缺字段就是新增', () => {
  const diff = diffMapping({ a: { type: 'keyword' }, b: { type: 'boolean' } }, { a: { type: 'keyword' } })
  assert.deepEqual(diff.additions, ['b'])
  assert.equal(diff.typeChanges.length, 0)
})

test('动作判定：成员缺字段 → wait-index，管理员 → 先迁移再装', () => {
  const base = { localVersion: '0.6.54', releaseVersion: '0.6.55', typeChanges: [] as Array<{ field: string; from: string; to: string }> }

  assert.deepEqual(planUpdate({ ...base, mode: 'member', additions: ['personal_memory_x:new_field'] }), {
    action: 'wait-index',
    additions: ['personal_memory_x:new_field'],
  })
  assert.deepEqual(planUpdate({ ...base, mode: 'migrate', additions: ['personal_memory_x:new_field'] }), {
    action: 'migrate-then-install',
    additions: ['personal_memory_x:new_field'],
  })
  // 都没缺字段：两边都是直接装
  assert.deepEqual(planUpdate({ ...base, mode: 'member', additions: [] }), { action: 'install' })
  assert.deepEqual(planUpdate({ ...base, mode: 'migrate', additions: [] }), { action: 'install' })
})

test('动作判定：类型变化任何模式都不自动改', () => {
  const plan = planUpdate({
    localVersion: '0.6.54',
    releaseVersion: '0.6.55',
    mode: 'migrate',
    additions: [],
    typeChanges: [{ field: 'b', from: 'long', to: 'date' }],
  })
  assert.equal(plan.action, 'manual')
})

test('动作判定：Release 不比本地新就跳过（不降级）', () => {
  const plan = planUpdate({
    localVersion: '0.6.54',
    releaseVersion: '0.6.54',
    mode: 'migrate',
    additions: ['x'],
    typeChanges: [],
  })
  assert.equal(plan.action, 'skip')
})

test('防重启死循环：已尝试过同一版本就不再下载', async () => {
  // 场景：上次装完了但进程版本没变（装到别处/没重启）。跨天也不能再试，
  // 否则每天装一次、重启一次，版本永远不变。判据 = 只查一次版本，绝不下载。
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runUpdate } = await import('../src/update.ts')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-'))
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastAttemptVersion: '0.6.56', lastAttemptDate: '2026-11-10' }))
    let fetches = 0
    const outcome = await runUpdate({
      mode: 'member',
      stateDir: dir,
      pluginDir: dir,
      dshHome: dir,
      profile: 'web',
      localVersion: '0.6.55',
      repo: 'x/y',
      timeZone: 'Asia/Shanghai',
      at: '06:00',
      restartDelayMs: 1000,
      indexes: { memory: 'personal_memory_x', doc: 'personal_doc_x', searchLog: 'search_log_x', audit: 'personal_audit_x' },
      es: { getMapping: async () => ({}), putMapping: async () => {} },
      log: () => {},
      now: () => new Date('2026-11-11T00:00:00Z'),
      exit: () => {},
      fetchImpl: (async () => {
        fetches += 1
        return new Response(JSON.stringify({
          tag_name: 'v0.6.56',
          assets: [
            { name: 'dsh-memory-es-0.6.56.tar.gz', browser_download_url: 'https://example.invalid/a' },
            { name: 'dsh-memory-es-0.6.56.tar.gz.sha256', browser_download_url: 'https://example.invalid/b' },
          ],
        }), { status: 200 })
      }) as typeof fetch,
    })
    assert.equal(outcome.action, 'skipped')
    assert.match(outcome.reason, /已尝试安装/)
    assert.equal(fetches, 1, '只查一次版本；走不到下载')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
