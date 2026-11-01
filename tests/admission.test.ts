/**
 * 阶段 9：写入准入屏障的纯函数单测。
 *
 * 两份断言清单，对应两条送进来的真实事故形态：
 *  · 凭据：明文口令、令牌、私钥、带密码连接串必须被隔离；而占位符、哈希、
 *    公钥、以及"讨论凭据管理"的正常记忆必须放过（误杀会被当成"记了却没记住"）。
 *  · 原样再摄取：抄检索原文、包一层壳的摘录必须隔离；同义改写与新增信息的复述要放过。
 *
 * 另外钉住一条安全属性：返回值里**不许出现完整凭据**（它会进日志与模型上下文）。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  checkAdmission,
  detectSecret,
  findVerbatimRecall,
  looksLikeOpaqueSecret,
  ORIGIN_VALUES,
  squashForCompare,
  type RecallRecord,
} from '../src/memory/admission.ts'

describe('detectSecret：凭据形态', () => {
  const secrets = [
    ['赋值式口令（英文冒号）', '数据库 password: Passw0rd123!'],
    ['赋值式口令（中文冒号）', '生产库的口令：Kx8vN2mQ'],
    ['赋值式口令（中文"是"）', '这台机器的密码是 Abcd1234ef'],
    ['环境变量形态', 'ELASTIC_PASSWORD=Zxcv1234'],
    ['token 赋值', 'NACOS token: a1b2c3d4e5f6g7h8'],
    ['私钥块', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----'],
    ['AWS Access Key', '备份账号 AKIAIOSFODNN7EXAMPLE 只读'],
    ['GitHub Token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4cWgifQ.c2lnbmF0dXJl'],
    ['带密码连接串', 'mysql://root:S3cretPass@192.0.2.10:3306/lottery_cloud'],
    ['高熵 base64 串', '密钥片段 U2FsdGVkX1+AbCdEf0123456789/XyZ+AbCdEf0123456789'],
  ] as const

  for (const [name, content] of secrets) {
    test(`隔离：${name}`, () => {
      const verdict = checkAdmission(content)
      assert.equal(verdict.allow, false, `应当隔离：${content}`)
      assert.equal(verdict.category, 'secret')
      assert.ok((verdict.reason ?? '').includes('隔离'), '理由要能被人看懂')
    })
  }

  const safe = [
    ['讨论凭据管理（无值）', '凭据别用 curl -u（会进 argv/ps），用 600 临时配置文件 + --config。'],
    ['占位符值', 'ELASTIC_PASSWORD=${ELASTIC_PASSWORD} 由 compose 注入'],
    ['脱敏值', 'token: <REDACTED>'],
    ['sha256 十六进制', '归档 sha256 = 3f786850e387550fdab836ed7e6dc881de23001b7a3f3d3e7b9f0a1b2c3d4e5f'],
    ['git commit 短 hash', '线上跑的是 8b0efd5 那个提交'],
    ['公钥块', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----'],
    ['没有密码的连接串', 'ssh://git@ssh.example.com:2233/ai-agent/team-skills.git'],
    ['中文说明性取值', '密码是见 ~/.dsh/secrets.env'],
    ['普通事实', '宝塔面板的 8888 端口已进安全组白名单，本机探测可达不代表没做来源限制。'],
    ['单词 pass 不算', '比赛已过截止时间，get_beidanstate_time 判成 1。'],
  ] as const

  for (const [name, content] of safe) {
    test(`放行：${name}`, () => {
      assert.equal(detectSecret(content), null, `不应判成凭据：${content}`)
    })
  }

  test('返回值不含完整凭据', () => {
    const verdict = checkAdmission('数据库 password: Passw0rd123!')
    assert.equal(verdict.allow, false)
    const serialized = JSON.stringify(verdict)
    assert.ok(!serialized.includes('Passw0rd123'), `返回值泄露了凭据：${serialized}`)
    assert.ok((verdict.matched ?? '').includes('***'), '应给出脱敏片段')
  })
})

describe('looksLikeOpaqueSecret', () => {
  test('base64 形态命中', () => {
    assert.equal(looksLikeOpaqueSecret('U2FsdGVkX1+AbCdEf0123456789/XyZ+AbCdEf0123456789'), true)
  })
  test('纯 hex 不命中（sha / commit）', () => {
    assert.equal(looksLikeOpaqueSecret('3f786850e387550fdab836ed7e6dc881de23001b7a3f3d3e7b9f0a1b2c3d4e5f'), false)
  })
  test('连字符串不命中', () => {
    assert.equal(looksLikeOpaqueSecret('lottery-cloud-java-change-2026-11-01'), false)
  })
})

describe('findVerbatimRecall：检索原文再摄取', () => {
  const recalled: RecallRecord[] = [
    {
      memoryId: 'mem-1',
      content: '生产库慢查询要看 infra_api_access_log，保留 14 天、每批删 100 行。查询时先按时间收窄。',
    },
  ]

  test('抄检索原文 → 命中', () => {
    const hit = findVerbatimRecall(
      '生产库慢查询要看 infra_api_access_log，保留 14 天、每批删 100 行。查询时先按时间收窄。',
      recalled,
    )
    assert.equal(hit?.memoryId, 'mem-1')
  })

  test('抄片段（子串）→ 命中', () => {
    // 片段要够长：24 字符以下「包含关系」不可靠（一个短句能被子句碰巧命中）
    const hit = findVerbatimRecall(
      '生产库慢查询要看 infra_api_access_log，保留 14 天、每批删 100 行',
      recalled,
    )
    assert.equal(hit?.memoryId, 'mem-1')
  })

  test('包一层壳的摘录（长度几乎没增加）→ 命中', () => {
    const hit = findVerbatimRecall(
      '记住：生产库慢查询要看 infra_api_access_log，保留 14 天、每批删 100 行。查询时先按时间收窄。',
      recalled,
    )
    assert.equal(hit?.memoryId, 'mem-1')
  })

  test('同义改写（有新增信息）→ 放行', () => {
    const hit = findVerbatimRecall(
      'AccessLogCleanJob 每批只删 100 行，导致 43.9GB 的表删了三天才降下来；要按 this_week 分批观察。',
      recalled,
    )
    assert.equal(hit, null)
  })

  test('没有检索素材 → 永不判', () => {
    assert.equal(findVerbatimRecall('随便一句足够长的话，用来确认空素材时不判', []), null)
  })

  test('短候选不判（包含关系不可靠）', () => {
    assert.equal(findVerbatimRecall('保留 14 天', recalled), null)
  })
})

describe('checkAdmission：顺序与来源戳常量', () => {
  test('含凭据且重复时，理由写凭据（那才是要处理的问题）', () => {
    const recalled: RecallRecord[] = [{ memoryId: 'mem-1', content: 'password: Passw0rd123!' }]
    const verdict = checkAdmission('password: Passw0rd123!', { recent: recalled })
    assert.equal(verdict.category, 'secret')
  })

  test('空内容放行（参数校验在别处）', () => {
    assert.equal(checkAdmission('').allow, true)
  })

  test('来源戳枚举固定五类', () => {
    assert.deepEqual([...ORIGIN_VALUES], ['user', 'agent', 'tool', 'import', 'ingest'])
  })

  test('squashForCompare 去空白标点、保留中文', () => {
    assert.equal(squashForCompare('  Nacos 的实例，列表 有 10s 缓存。'), 'nacos的实例列表有10s缓存')
  })
})
