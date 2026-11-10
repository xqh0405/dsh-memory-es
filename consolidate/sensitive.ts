/**
 * 敏感信息扫描（文档 §9.5 的最小实现）。
 *
 * 定位：这是**入库前的最后一道闸**，不是完整的 DLP。命中就 blocked、不写团队库、
 * 日志里只记类型与位置，**绝不打印原文**。
 *
 * 为什么 S8 就要有：S9 才做完整治理，但 S8 已经开始往团队库写东西了——
 * 没有这道闸，一次失误就是「个人密码进了全员可读的索引」，事后清理比重写这段代码贵得多。
 *
 * @module dsh-memory-es/consolidate/sensitive
 */

import {
  ASSIGN_SEPARATORS,
  CREDENTIAL_WORDS,
  DSN_WITH_PASSWORD,
  KNOWN_TOKEN_PATTERNS,
  PEM_PRIVATE_BLOCK_PATTERN,
} from '../src/security/secret-rules.ts'

export type SensitiveKind =
  | 'private_key'
  | 'cloud_ak'
  | 'api_token'
  | 'id_card'
  | 'phone'
  | 'password_assignment'

export interface SensitiveHit {
  kind: SensitiveKind
  /** 命中的字符区间（起止下标），便于人工定位；**不含原文** */
  start: number
  end: number
  /** 让人能理解的短说明（不含敏感值本身） */
  note: string
}

/**
 * 每类一条正则：宁可多报（进人工），不可漏报（进团队库）。
 *
 * 2026-11-10 审查 #8：**凭据类规则统一取自 `src/security/secret-rules.ts`**，
 * 与写入准入（`src/memory/admission.ts`）共用一份定义 —— 此前两边各写各的，
 * 词表/阈值/字符类逐渐漂移，同一条凭据在两条链路上结论相反
 * （`API key 为 …`、`sk-proj-…`、40 位 AWS secret：准入放行、这里早就能拦）。
 *
 * ⚠️ **`id_card` / `phone` 刻意留在本模块、不上提**：手机号与身份证在个人记忆里
 * 是正常内容，只有晋升团队库才该拦 —— 用户 2026-11-10 拍板「不同步」。
 */
const RULES: Array<{ kind: SensitiveKind; pattern: RegExp; note: string }> = [
  { kind: 'private_key', pattern: PEM_PRIVATE_BLOCK_PATTERN, note: '私钥块' },
  // 令牌类**逐条**从共享定义生成：一份规则两处生效，改阈值不会只改一边。
  // kind 按名字映射 —— 云厂商 AK 单列一类（面板/报告按 kind 分桶），其余归 api_token。
  ...KNOWN_TOKEN_PATTERNS.map((p) => ({
    kind: (p.name === '云厂商 AccessKey' ? 'cloud_ak' : 'api_token') as SensitiveKind,
    pattern: new RegExp(p.re.source, 'g'),
    note: p.name,
  })),
  { kind: 'id_card', pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, note: '身份证号' },
  { kind: 'phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, note: '手机号' },
  {
    kind: 'password_assignment',
    // password=xxx / passwd: xxx / pwd = "xxx" / 密码=xxx（值至少 4 位、且不是占位符）
    //
    // 词表与分隔符取自共享定义（2026-11-10），于是中文赋值（`密码=xxx`）与
    // `secret` / `token` 也一起拦了；**刻意不加裸 `pass`** —— 测试脚本里
    // `PASS=17 项` 是"通过数"，2026-10-29 就因为这条把 3 条复盘误判成密码泄露。
    // 宁可少拦一种写法，也别让「跑了几项测试」变成敏感命中。
    //
    // 不带前置 \\b：中文词前没有 word boundary（`密码` 前是空格时 \\b 会失败）。
    pattern: new RegExp(
      `(?:${CREDENTIAL_WORDS})\\s*(?:${ASSIGN_SEPARATORS})\\s*["']?(?!\\*+|x{4,}|<|\\$\\{|\\{\\{|change-?me|example)[^\\s"',;]{4,}`,
      'gi',
    ),
    note: '密码赋值',
  },
  // 带密码的连接串（共享规则）：原先只有准入侧有这条，晋升侧会放行 —— 同一条 DSN
  // 在两条链路上结论相反，正是本次要消除的分歧。
  // ⚠️ 必须补 g：scanSensitive 用 matchAll，缺 g 会直接抛（DSN 规则本身只给准入侧的 .exec 用，没有 g）
  { kind: 'password_assignment', pattern: new RegExp(DSN_WITH_PASSWORD.source, DSN_WITH_PASSWORD.flags + 'g'), note: '带密码的连接串' },
]

/**
 * 扫描一段文本。返回命中列表（可能为空）。
 * 纯函数：同样的输入永远同样的输出，便于单测与复跑对拍。
 */
export function scanSensitive(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = []
  for (const rule of RULES) {
    // 每条规则独立 clone：lastIndex 不能跨调用残留
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue
      hits.push({
        kind: rule.kind,
        start: match.index,
        end: match.index + match[0].length,
        note: rule.note,
      })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

/** 命中类型的去重摘要（写日志/报告用，不含原文） */
export function summarizeHits(hits: readonly SensitiveHit[]): string {
  const kinds = [...new Set(hits.map((hit) => hit.kind))]
  return kinds.length === 0 ? 'clean' : kinds.join(',')
}
