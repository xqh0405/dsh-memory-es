/**
 * 部署脚本的**成败判定**回归（2026-11-10 审查 M3/#24）。
 *
 * 背景：`scripts/deploy-panel.sh` 原来是
 *   `ssh … | grep '自检' | tail -1 || true`  +  无条件 `echo 完成：vX 已部署`
 * 于是「容器 healthy 但插件/面板没起来」（grep 找不到自检行 → 管道非 0 → `|| true` 吞掉）
 * 时照样打印成功并 exit 0。而 `deploy-all-panel.sh` **只看退出码**，
 * 于是整批都记成成功 —— 部署脚本报假成功比不报更糟。
 *
 * 本文件的做法：**从脚本里抠出那段判定**（不是另写一份实现），用受控的
 * `selfcheck` / `VERSION` 跑它，断言退出码。这样判定逻辑被改坏时这里立刻红。
 *
 * @module dsh-memory-es/tests/deploy-gate
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const SCRIPT = new URL('../scripts/deploy-panel.sh', import.meta.url)
const src = readFileSync(SCRIPT, 'utf8')

/** 抠出脚本里 `# --- 部署成败判定` 到 `esac` 的那段（改了脚本里的标记就会抠不到）。 */
function decisionBlock() {
  const m = src.match(/# --- 部署成败判定[\s\S]*?\nesac/)
  assert.ok(m, 'deploy-panel.sh 里找不到「部署成败判定」块 —— 改了标记要同步本测试')
  return m[0]
}

/** 在子 shell 里跑那段判定，返回退出码与输出。 */
function runDecision(selfcheck, version) {
  const block = decisionBlock()
  const script = [
    `selfcheck=${JSON.stringify(selfcheck)}`,
    `VERSION=${JSON.stringify(version)}`,
    block,
  ].join('\n')
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error) {
    const err = error
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const VER = '0.6.53'
const GOOD = `[记忆库面板] 自检通过 v${VER} | 配置行=include:dsh-memory-es ES=可达`

describe('deploy-panel.sh 的部署成败判定', () => {
  test('抠得到判定块（标记被改会红，而不是静默跳过）', () => {
    assert.match(decisionBlock(), /自检通过 v\$\{VERSION\}/)
  })

  test('自检行为空 → 非 0（容器 healthy 但插件没起来，绝不能算成功）', () => {
    const r = runDecision('', VER)
    assert.notEqual(r.code, 0, '空自检行必须失败')
    assert.match(r.out, /部署未确认/)
  })

  test('自检行版本不符 → 非 0（铺的不是这个版本就是没铺成）', () => {
    const r = runDecision('[记忆库面板] 自检通过 v0.6.52 | 配置行=…', VER)
    assert.notEqual(r.code, 0, '旧版本自检行必须失败')
    assert.match(r.out, /v0\.6\.53/)
  })

  test('自检行根本不是自检内容 → 非 0', () => {
    const r = runDecision('Error: Cannot find module dsh-memory-es', VER)
    assert.notEqual(r.code, 0, '非自检内容必须失败')
  })

  test('正确的自检行 → 0，且打印「完成」', () => {
    const r = runDecision(GOOD, VER)
    assert.equal(r.code, 0, `正确自检行应成功，实际 rc=${r.code}：${r.out}`)
    assert.match(r.out, new RegExp(`完成：v${VER} 已部署到`))
  })
})
