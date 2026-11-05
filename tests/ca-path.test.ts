/**
 * CA 路径解析（评审 M2）：默认值不能再是仓库相对路径。
 *
 * 这组断言钉的是**顺序**本身——发行包把证书放在 `$DSH_HOME/memory-es/es/certs/ca.crt`，
 * 仓库开发放在 `deploy/es/certs/ca.crt`。顺序错了不会报错，只会「读不到 CA」，
 * 所以必须用测试固定「先哪儿、后哪儿」。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { resolveCaCertPath } from '../src/es/http.ts'

const DATA = '/data/dsh/memory-es'
const CWD = '/work/repo'

describe('resolveCaCertPath', () => {
  test('显式配置原样返回（首尾空格被去掉）', () => {
    assert.equal(resolveCaCertPath('  /etc/ssl/my-ca.pem  ', DATA, CWD), '/etc/ssl/my-ca.pem')
  })

  test('空配置 → 第一候选：$DSH_HOME/memory-es/es/certs/ca.crt', () => {
    assert.equal(resolveCaCertPath('', DATA, CWD), join(DATA, 'es', 'certs', 'ca.crt'))
  })

  test('undefined 与纯空白等价于空配置', () => {
    assert.equal(resolveCaCertPath(undefined, DATA, CWD), join(DATA, 'es', 'certs', 'ca.crt'))
    assert.equal(resolveCaCertPath('   ', DATA, CWD), join(DATA, 'es', 'certs', 'ca.crt'))
  })

  test('第一候选存在时用它（发行包的标准落点）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-path-'))
    const target = join(dir, 'es', 'certs', 'ca.crt')
    mkdirSync(join(dir, 'es', 'certs'), { recursive: true })
    writeFileSync(target, 'PEM')
    assert.equal(resolveCaCertPath('', dir, CWD), target)
  })

  test('第一候选缺失、第二候选存在时用第二（$DSH_HOME/memory-es/ca.crt）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-path-'))
    const target = join(dir, 'ca.crt')
    writeFileSync(target, 'PEM')
    assert.equal(resolveCaCertPath('', dir, CWD), target)
  })

  test('前两个都缺失、仓库相对路径存在时用第三个', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-path-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ca-cwd-'))
    mkdirSync(join(cwd, 'deploy', 'es', 'certs'), { recursive: true })
    writeFileSync(join(cwd, 'deploy', 'es', 'certs', 'ca.crt'), 'PEM')
    assert.equal(resolveCaCertPath('', dir, cwd), join(cwd, 'deploy', 'es', 'certs', 'ca.crt'))
  })

  test('一个都不存在时返回第一候选（错误信息指向「该放哪」）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-path-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ca-cwd-'))
    assert.equal(resolveCaCertPath('', dir, cwd), join(dir, 'es', 'certs', 'ca.crt'))
  })
})