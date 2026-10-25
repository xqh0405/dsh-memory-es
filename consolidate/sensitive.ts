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

/** 每类一条正则：宁可多报（进人工），不可漏报（进团队库） */
const RULES: Array<{ kind: SensitiveKind; pattern: RegExp; note: string }> = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/g,
    note: '私钥块',
  },
  { kind: 'cloud_ak', pattern: /\b(?:LTAI|AKIA|AKID)[A-Za-z0-9]{12,24}\b/g, note: '云厂商 AccessKey' },
  {
    kind: 'api_token',
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    note: 'API token（sk-/ghp_/xox）',
  },
  { kind: 'id_card', pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, note: '身份证号' },
  { kind: 'phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, note: '手机号' },
  {
    kind: 'password_assignment',
    // password=xxx / passwd: xxx / pwd = "xxx"（xxx 至少 4 位、且不是占位符）
    pattern: /\b(?:pass(?:word|wd)?|pwd)\s*[=:]\s*["']?(?!\*+|x{4,}|<|\$\{|\{\{|change-?me|example)[^\s"',;]{4,}/gi,
    note: '密码赋值',
  },
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
