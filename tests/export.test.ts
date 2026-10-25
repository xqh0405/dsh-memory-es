/**
 * Markdown 镜像纯函数与落盘行为（S10）：文件名清洗、按 domain 分组、渲染、清理旧文件、dry-run。
 *
 * 重点守两条：
 *  · 清理旧文件时**只删带生成标记的**（人手写的 md 一律不碰）；
 *  · 渲染出来的每条都必须带来源，否则这份"备份"没法追溯。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  GENERATED_MARKER,
  groupByDomain,
  renderDomainMarkdown,
  renderIndex,
  safeFileName,
  writeMirror,
  type TeamDocForExport,
} from '../consolidate/export.ts'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const META = { generatedAt: NOW, teamIndex: 'team_knowledge', endpoint: 'https://127.0.0.1:9200' }

function doc(over: Partial<TeamDocForExport> = {}): TeamDocForExport {
  return {
    doc_id: 'd1',
    content: '北单中断开奖必须同时写两个字段。',
    memory_type: 'fact',
    domain: 'lottery-cloud',
    topic_key: 'lottery-cloud:abc',
    source_user: 'xqh',
    source_memory_id: 'm1',
    promoted_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    ...over,
  }
}

describe('safeFileName', () => {
  test('保留中文与连字符，路径分隔符/空白换成 -', () => {
    assert.equal(safeFileName('lottery-cloud'), 'lottery-cloud')
    assert.equal(safeFileName('a/b:c d'), 'a-b-c-d')
    assert.equal(safeFileName('中文 域'), '中文-域')
  })

  test('空/纯空白 → general；不产生前导横线', () => {
    assert.equal(safeFileName('   '), 'general')
    assert.equal(safeFileName(' /x '), 'x')
  })
})

describe('groupByDomain', () => {
  test('空 domain 归 general，且按 domain 名排序（稳定 diff）', () => {
    const groups = groupByDomain([
      doc({ doc_id: 'b', domain: 'zeta' }),
      doc({ doc_id: 'a', domain: 'alpha' }),
      doc({ doc_id: 'g', domain: '' }),
    ])
    assert.deepEqual([...groups.keys()], ['alpha', 'general', 'zeta'])
    assert.equal(groups.get('general')?.[0].doc_id, 'g')
  })
})

describe('renderDomainMarkdown', () => {
  test('首行是生成标记；头部写清口径；每条带来源与 doc_id', () => {
    const md = renderDomainMarkdown('lottery-cloud', [doc()], META)
    const lines = md.split('\n')
    assert.equal(lines[0], GENERATED_MARKER)
    assert.match(md, /# lottery-cloud/)
    assert.match(md, /review_state ∈ \{auto, approved\}/)
    assert.match(md, /xqh \/ `m1` @ 2026-10-01T00:00:00Z/)
    assert.match(md, /doc_id：`d1`/)
    assert.match(md, /北单中断开奖必须同时写两个字段/)
  })

  test('多条按 promoted_at 升序编号', () => {
    const md = renderDomainMarkdown(
      'd',
      [doc({ doc_id: 'late', promoted_at: '2026-10-09T00:00:00Z', content: '后' }), doc({ doc_id: 'early', content: '先' })],
      META,
    )
    const first = md.indexOf('## 1.')
    const second = md.indexOf('## 2.')
    assert.ok(first > 0 && second > first)
    assert.ok(md.slice(first, second).includes('先'), '较早的那条应排在 1')
  })
})

describe('renderIndex', () => {
  test('表格含 domain / 条目数 / 链接，并汇总总数', () => {
    const groups = new Map([
      ['alpha', [doc()]],
      ['beta', [doc({ doc_id: 'b2' }), doc({ doc_id: 'b3' })]],
    ])
    const md = renderIndex(groups, META)
    assert.match(md, /全量共 3 条，2 个 domain/)
    assert.match(md, /\| alpha \| 1 \| \[`alpha\.md`\]\(\.\/alpha\.md\) \|/)
    assert.match(md, /\| beta \| 2 \|/)
  })
})

describe('writeMirror', () => {
  test('写文件 + 清理旧生成文件，但绝不动人写的 md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-'))
    try {
      // 上一轮留下的：一个带标记的旧 domain，一个人手写的笔记
      writeFileSync(join(dir, 'stale.md'), `${GENERATED_MARKER}\n# 旧 domain\n`, 'utf8')
      writeFileSync(join(dir, '手写笔记.md'), '# 我自己写的\n', 'utf8')

      const groups = new Map([['alpha', [doc()]]])
      const result = writeMirror(dir, groups, META)

      assert.deepEqual(result.files.map((f) => f.file), ['alpha.md'])
      assert.equal(result.total, 1)
      assert.equal(existsSync(join(dir, 'alpha.md')), true)
      assert.equal(existsSync(join(dir, 'INDEX.md')), true)
      assert.deepEqual(result.pruned, ['stale.md'], '只删带生成标记的旧文件')
      assert.equal(existsSync(join(dir, '手写笔记.md')), true, '人写的文件必须留着')
      assert.equal(existsSync(join(dir, 'stale.md')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dryRun 只算不写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-dry-'))
    try {
      const result = writeMirror(dir, new Map([['alpha', [doc()]]]), META, { dryRun: true })
      assert.deepEqual(result.files.map((f) => f.file), ['alpha.md'])
      assert.equal(readFileSize(dir), 0, 'dry-run 不能落任何文件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function readFileSize(dir: string): number {
  try {
    return readFileSync(join(dir, 'alpha.md')).byteLength
  } catch {
    return 0
  }
}
