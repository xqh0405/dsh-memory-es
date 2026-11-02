/**
 * 会话日志根目录的推导：容器里 `HOME` 不是 `DSH_HOME`。
 *
 * 钉住的原因（2026-11-02 实测 某个成员容器）：
 * 容器里 `HOME=/home/node`、`DSH_HOME=/data/dsh`，会话日志在 `/data/dsh/sessions`。
 * 只用 `homedir()` 拼成 `/home/node/.dsh/sessions`（不存在）→ 读不到当天对话
 * → 日记与人格提炼永远「跳过」，而个人记忆写入完全正常，症状很容易被误判成模型问题。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { dshSessionsRoot } from '../src/sessions.ts'

const original = process.env.DSH_HOME
function restore(): void {
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
}

test('设了 DSH_HOME 就以它为准（容器场景）', () => {
  process.env.DSH_HOME = '/data/dsh'
  try {
    assert.equal(dshSessionsRoot(), join('/data/dsh', 'sessions'))
  } finally {
    restore()
  }
})

test('没有 DSH_HOME 时退回 ~/.dsh/sessions（本机场景）', () => {
  delete process.env.DSH_HOME
  try {
    assert.match(dshSessionsRoot(), /\/\.dsh\/sessions$/)
  } finally {
    restore()
  }
})

test('DSH_HOME 是空串时同样退回默认（不等价于「根目录」）', () => {
  process.env.DSH_HOME = '   '
  try {
    assert.match(dshSessionsRoot(), /\/\.dsh\/sessions$/)
  } finally {
    restore()
  }
})
