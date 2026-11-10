/**
 * 两套敏感规则的**对拍**（2026-11-10 审查 #8）。
 *
 * 背景：写入准入（`src/memory/admission.ts`，命中 → 隔离待审）与晋升闸
 * （`consolidate/sensitive.ts`，命中 → 不进团队库）曾各写一份凭据规则，
 * 阈值与字符类逐渐漂移，同一条凭据两条链路结论相反。现在两边都从
 * `src/security/secret-rules.ts` 取规则——**本文件钉住「取得到、且都生效」**：
 * 共享规则一旦被改坏或只接到一侧，这里就会红。
 *
 * 对拍范围是**共享规则覆盖的样本**，不是「两边逐字等价」——两边的容忍度刻意不同：
 *  · 准入侧多出**散文式赋值**（`password is X`，值须含数字）与**高熵串**，
 *    因为它要防「会话里的口令被蒸馏进库」，宁可多拦一道、人再放行；
 *  · 晋升侧多出 **`id_card` / `phone`**（用户 2026-11-10 拍板：手机号、身份证在
 *    个人记忆里是正常内容，只有进团队库才拦）。
 * 这两类差异是**有意的**，不进对拍；进了就只能靠删规则来「求同」，那才是退步。
 *
 * @module dsh-memory-es/tests/secret-rules-parity
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { scanSensitive } from '../consolidate/sensitive.ts'
import { detectSecret } from '../src/memory/admission.ts'

/**
 * 晋升侧的「凭据类」kind。
 * `id_card` / `phone` 排除在对拍之外（见文件头：个人库里是正常内容）。
 */
const CREDENTIAL_KINDS = new Set(['private_key', 'cloud_ak', 'api_token', 'password_assignment'])

/** 两边都必须拦的凭据样本（全部由共享规则或两侧共有的赋值逻辑覆盖） */
const MUST_CATCH: Array<[label: string, text: string]> = [
  ['PEM 私钥块', '凭证如下\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n请妥善保管'],
  ['AWS AccessKey', 'AccessKey 为 AKIA1234567890ABCDEF'],
  ['阿里云 AccessKey（旧版漏的 LTAI）', 'access key 为 LTAI5tAbCdEfGhIjKlMn'],
  ['sk 带连字符（旧版字符类漏的）', 'OpenAI key: sk-proj-aaaa1111bbbb2222cccc3333'],
  ['sk-ant 形态（旧版字符类漏的）', 'anthropic: sk-ant-api03-aaaabbbbccccdddd'],
  ['GitHub token（真实长度 36）', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['英文赋值（冒号）', '数据库 password: Passw0rd123'],
  ['中文赋值（是）', '这台机器的密码是 Abcd1234ef'],
  ['多词短语 + 中文分隔（旧版词表漏的空格）', 'API key 为 ABCDEF123456'],
  ['带密码的连接串', '连接串 mysql://user:pass@host/db 要换掉'],
]

/** 两边都必须放行的干净样本（误杀防线，任一侧拦了都算退步） */
const MUST_PASS: string[] = [
  '验证 PASS=17 项', // 测试通过计数，不是密码赋值（2026-10-29 回归）
  'Mockito PASS=8/14',
  'password is required', // 散文式陈述要求，不是赋值
  'token is invalid',
  'password=change-me', // 占位符
  'password=${DB_PASS}',
  'password=******',
  '密码是见文档', // 说明文字，不是值
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // sha256，公开可共享
  'lottery-cloud-java-change', // 连字符串，不是密钥
  '这是公钥\n-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----',
]

describe('secret-rules 对拍：共享规则两边都生效', () => {
  for (const [label, text] of MUST_CATCH) {
    test(`拦得住：${label}`, () => {
      const admission = detectSecret(text)
      assert.notEqual(admission, null, `准入侧漏了：${text.slice(0, 40)}`)

      const hits = scanSensitive(text).filter((h) => CREDENTIAL_KINDS.has(h.kind))
      assert.ok(hits.length > 0, `晋升侧漏了：${text.slice(0, 40)}`)
    })
  }

  for (const text of MUST_PASS) {
    test(`不误杀：${text.slice(0, 34)}${text.length > 34 ? '…' : ''}`, () => {
      assert.equal(detectSecret(text), null, `准入侧误杀：${text.slice(0, 40)}`)
      const hits = scanSensitive(text).filter((h) => CREDENTIAL_KINDS.has(h.kind))
      assert.equal(hits.length, 0, `晋升侧误杀：${text.slice(0, 40)}`)
    })
  }

  test('共享规则确实是同一份：改一边的词表不会让两边结论分叉', () => {
    // 反向钉：若哪天有人把某侧改回本地定义（比如只在 admission 里加个前缀），
    // 这条会因为「准入拦了、晋升没拦」而红。
    const samples = [
      'key: AKID1234567890abcdef',
      'sk-ant-api03-aaaabbbbccccdddd',
      'xoxb-abcdefghijklmn',
    ]
    for (const text of samples) {
      const a = detectSecret(text) !== null
      const s = scanSensitive(text).some((h) => CREDENTIAL_KINDS.has(h.kind))
      assert.equal(a, s, `两侧结论分叉：${text}（准入=${a} 晋升=${s}）`)
    }
  })
})
