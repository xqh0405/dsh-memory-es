/**
 * 运维脚本的命令行契约（2026-11-11 审查 #35）。
 *
 * 为什么值得测：这些脚本的失败模式是**花钱或写错数据**，而不是崩。
 * `backfill-team-summary.ts` 的注释自己写着：`--limit abc` 走 `Number(...) || 0`
 * → 静默变成「不限量」→ **全量调 LLM 花钱**。它已经改成显式报错了，这里钉住。
 *
 * 只测**错误路径**：它们在连 ES / 调 LLM 之前就 `process.exit(2)`，
 * 所以能在没有 ES 的环境里跑（正路会进 main()，不适合单测）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'

const BACKFILL = 'scripts/backfill-team-summary.ts'
const LINK = 'scripts/link-docs.ts'

/** 跑脚本，只关心退出码与 stderr */
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 })
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
}

describe('backfill-team-summary：--limit 非法必须报错退出', () => {
  test('--limit abc → exit 2（不能静默变成不限量）', () => {
    const r = run(BACKFILL, ['--limit', 'abc'])
    assert.equal(r.status, 2, `实际 exit=${r.status}；stdout=${r.stdout.slice(0, 120)}`)
    assert.match(r.stderr, /需要一个正整数/)
  })

  test('--limit 后面跟的是开关（忘了写值）→ exit 2', () => {
    // `--limit --apply` 是很自然的手误；绝不能当成「不限量」跑全量
    const r = run(BACKFILL, ['--limit', '--apply'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /需要一个正整数/)
  })

  test('--limit=0 → exit 2（0 条没有意义，多半是写错了）', () => {
    const r = run(BACKFILL, ['--limit=0'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /需要一个正整数/)
  })
})

describe('link-docs：非法数值同样不能静默回落默认', () => {
  // 2026-11-11 审查 #35 发现：`num()` 对 `Number.isFinite` 为假的值**静默 return fallback**
  // → `--limit=abc` 按 50 片跑（exit 0），`--min-score=abc` 更糟：会按默认阈值 0.55 写边。
  // 这与 backfill-team-summary.ts 的处理不一致，且用户以为限了别的数。
  for (const flag of ['--limit=abc', '--min-score=abc', '--topk=abc', '--max-doc-edges=abc']) {
    test(`${flag} → exit 2（而不是按默认值静默跑）`, () => {
      const r = run(LINK, [flag])
      assert.equal(r.status, 2, `实际 exit=${r.status}；它按默认值跑下去了：${r.stdout.slice(0, 120)}`)
      assert.match(r.stderr, /需要一个数字/)
    })
  }
})
