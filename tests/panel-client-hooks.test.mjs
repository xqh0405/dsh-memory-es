// 客户端 hook 顺序守卫（2026-11-02 星图白屏的根因）
//
// 事故：GraphView 在 `if (state.loading) return …` 之后加了一个 React.useMemo，
// 加载完成时 hook 数量从 N 变 N+1 → React 抛
// "Rendered more hooks than during the previous render"，整个星图白掉。
//
// 这类 bug 用「渲染一次」的冒烟测不出来（SSR 只渲一次、hook 数量一致），
// 所以这里用静态检查兜住：同一组件里，loading/error 早退之后不许再出现 hook 调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const LINES = readFileSync(new URL('../panel/client.js', import.meta.url), 'utf8').split('\n')

/** 4 空格缩进的 function 声明视为组件/辅助函数边界 */
const FUNCTION_BOUNDARY = /^ {4}function [A-Za-z_]\w*\(/

test('loading/error 早退之后不能再调用 hook', () => {
  const problems = []
  let guardedAt = null
  for (let i = 0; i < LINES.length; i += 1) {
    const line = LINES[i]
    if (FUNCTION_BOUNDARY.test(line)) guardedAt = null
    if (guardedAt === null && /if \(state\.(loading|error)/.test(line)) guardedAt = i + 1
    if (guardedAt !== null && /React\.use[A-Z]\w*\(/.test(line)) problems.push(`${i + 1}: ${line.trim()}`)
  }
  assert.deepEqual(problems, [], `这些 hook 出现在早退之后：\n${problems.join('\n')}`)
})

test('守卫本身有效：把 useMemo 塞回早退之后能被抓到', () => {
  // 用一段与事故同形的假源码跑同一套规则，防止「正则写空了所以永远绿」
  const fake = [
    '    function GraphView({ t }) {',
    "      if (state.loading) return h('div', null, 'loading')",
    "      const bad = React.useMemo(() => 1, [])",
    '    }',
  ]
  const problems = []
  let guardedAt = null
  for (let i = 0; i < fake.length; i += 1) {
    const line = fake[i]
    if (FUNCTION_BOUNDARY.test(line)) guardedAt = null
    if (guardedAt === null && /if \(state\.(loading|error)/.test(line)) guardedAt = i + 1
    if (guardedAt !== null && /React\.use[A-Z]\w*\(/.test(line)) problems.push(`${i + 1}: ${line.trim()}`)
  }
  assert.equal(problems.length, 1, '守卫必须能抓到早退后的 hook')
})
