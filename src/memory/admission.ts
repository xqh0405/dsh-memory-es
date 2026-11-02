/**
 * 写入准入屏障（阶段 9）——**规则版**，先于 LLM 版落地。
 *
 * 防的是真实发生过的事：巡检把会话里的明文口令蒸馏进了记忆库。
 * 所以这里不是「过滤器」而是**隔离闸**：命中即写 `status=quarantine`，
 * 不进检索、不建边、不蒸馏，但**留在库里等人在面板上审**——
 * 直接丢弃会让人再犯同一次错，而且看不出漏了什么。
 *
 * 三类判据（规则能可靠做的是前两类）：
 *  1. `secret`   ：凭据形态——赋值式口令 / 私钥块 / 已知令牌前缀 / 连接串带密码 / 高熵不透明串；
 *  2. `verbatim` ：与本轮检索到的记忆高度重复、没有新增信息（「检索结果原样再摄取」）；
 *  3. assistant 对用户自述的复述：规则层分不开「复述」与「正常引用」，
 *     交给后置的 LLM 版；它与第 2 类共用「无新增信息」这条硬判据，能兜住最典型的一种。
 *
 * 三条设计约束：
 *  · **纯函数**：不读时钟/配置/网络，便于单测，也便于在 save 路径里同步调用；
 *  · 只回类别与**脱敏片段**，绝不把完整凭据回传——它会进日志、进返回值；
 *  · 宁可少判也不滥杀：占位符、哈希、没有密码的连接串、公钥/证书都必须放过。
 *    （漏网的还有人在面板上审；误杀的会被当成「记了却没记住」。）
 *
 * @module dsh-memory-es/memory/admission
 */

/** 写入来源戳：谁把这条写进来的（阶段 9，字段 `origin`） */
export const ORIGIN_VALUES = ['user', 'agent', 'tool', 'import', 'ingest'] as const
export type Origin = (typeof ORIGIN_VALUES)[number]

/**
 * 缺省来源。
 *
 * 模型调 `memory_save` 是替代理记账，标 `agent`；`user` 留给「用户在本机上直接落库」
 * （将来 CLI / 面板写入）——只有那个场景才真的能断言是人写的。
 */
export const DEFAULT_ORIGIN: Origin = 'agent'

export type AdmissionCategory = 'secret' | 'verbatim'

export interface AdmissionVerdict {
  /** true = 正常入库；false = 隔离待审 */
  allow: boolean
  category?: AdmissionCategory
  /** 一句话理由，写入 `quarantine_reason`，面板与返回值都用它 */
  reason?: string
  /** 命中位置的脱敏片段（如 `pass***（12 字符）`），**不含原文** */
  matched?: string
}

export const ADMISSION_ALLOW: AdmissionVerdict = { allow: true }

/** 与检索结果比对用的最小素材：只要 id 与正文 */
export interface RecallRecord {
  memoryId: string
  content: string
}

export interface AdmissionContext {
  /** 本会话最近一次检索命中的记忆（由 recallCache 提供；空 = 谈不上「原样再摄取」） */
  recent?: readonly RecallRecord[]
}

/**
 * 凭据关键词。`pass` 故意不在词表里（英文单词误伤），只认完整拼写与中文说法。
 */
const CREDENTIAL_WORDS =
  'password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|密码|口令|密钥|私钥|令牌'

/**
 * 赋值式：`password: abcdef` / `密码是 abcdef` / `token=...`。
 *
 * 分隔符带上中文的「是 / 为」，因为中文会话里的口令几乎从不写成冒号。
 *
 * 2026-11-02 评审修：原来值只取「分隔符后第一个 token 且 ≥6 字符」，于是
 * `password：ab cd12345678`、`这台机器密码是 a very secret thing` 全部放行；
 * 关键词插零宽字符（`pass​word:`）也能绕过。现在改成：
 *  · 先把零宽字符剔掉、全角折成半角再扫（见 `scanText`）；
 *  · 值取到行尾/句末标点（最多 60 字），再判断「像不像一个值」。
 */
const ASSIGN_PATTERN = new RegExp(
  `(?:${CREDENTIAL_WORDS})\\s*(?:是|为|[:=])\\s*["']?([^\\n。；;]{2,60})`,
  'giu',
)

/** 剥掉零宽字符再扫描：`pass\u200Bword:` 与 `password:` 在语义上是同一个词 */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/gu

/** 扫描副本：去零宽 + NFKC（全角冒号/等号折成半角），原文不动，返回值只用脱敏片段 */
function scanText(content: string): string {
  return content.replace(PEM_PUBLIC_BLOCK, ' ').replace(ZERO_WIDTH, '').normalize('NFKC')
}

/** 占位符 / 说明性取值：看到这些就不算「真的写了凭据」 */
const PLACEHOLDER_PATTERN =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|%[A-Z_]+%|your[_-].*|changeme|placeholder|redacted|example|dummy|none|null|true|false|略|见.*|同上|不变|已脱敏|按需.*|环境变量.*)$/iu

/** 私钥块（PEM）。公钥与证书在扫描前会被整块剔除，不参与判定。 */
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/** URL 里带密码的连接串：`mysql://user:pass@host` */
const DSN_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{4,}@/iu

/** 已知令牌前缀：云厂商与常见服务的固定形态，认出来就不用看熵了 */
const KNOWN_TOKEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'OpenAI/国内平台 Key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
]

/** 公钥 / 证书块：它们不是秘密，却长得极像凭据，扫描前整块剔除 */
const PEM_PUBLIC_BLOCK = /-----BEGIN (?:[A-Z0-9 ]*PUBLIC KEY|CERTIFICATE)-----[\s\S]*?-----END (?:[A-Z0-9 ]*PUBLIC KEY|CERTIFICATE)-----/g

/**
 * 命中凭据后的脱敏片段：只保留前 3 位与长度。
 * 目的不是让人猜出值，而是让"审的人"认得出这是哪一处（比如 `pass***（12 字符）`）。
 */
function mask(value: string): string {
  const head = value.slice(0, 3)
  return `${head}***（${value.length} 字符）`
}

/** 高熵不透明串：base64/url-safe 形态的长串，且不是可公开识别的哈希 */
export function looksLikeOpaqueSecret(token: string): boolean {
  if (token.length < 44 || token.length > 512) return false
  if (!/^[A-Za-z0-9+/_=-]+$/.test(token)) return false
  // 纯 hex = commit id / sha256 / 文件哈希，公开可共享，绝不该被当凭据
  if (/^[0-9a-f]+$/i.test(token)) return false
  // 必须大小写与数字混排：随机密钥几乎必然如此，而普通标识符很难同时满足
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) return false
  // 含 base64 标点（+ / =）的长度 44 就够可疑；纯字母数字的长串要更长才判，
  // 否则 `lottery-cloud-java-change` 这类连字符串会被误伤。
  return /[+/=]/.test(token) ? true : token.length >= 64
}

/** 扫正文里的凭据形态；命中返回脱敏片段，否则 null */
export function detectSecret(content: string): { matched: string; reason: string } | null {
  // 公钥/证书先剔除（它们的 base64 正文会被熵规则整片误判），再去零宽、折全角
  const text = scanText(content)

  if (PRIVATE_KEY_PATTERN.test(text)) {
    return {
      matched: '-----BEGIN ... PRIVATE KEY-----',
      reason: '命中私钥块（PEM），已隔离待审',
    }
  }

  for (const { name, re } of KNOWN_TOKEN_PATTERNS) {
    const found = re.exec(text)
    if (found !== null) {
      return { matched: `${name} ${mask(found[0])}`, reason: `命中${name}形态，已隔离待审` }
    }
  }

  const dsn = DSN_WITH_PASSWORD.exec(text)
  if (dsn !== null) {
    return { matched: mask(dsn[0]), reason: '命中带密码的连接串，已隔离待审' }
  }

  ASSIGN_PATTERN.lastIndex = 0
  for (let m = ASSIGN_PATTERN.exec(text); m !== null; m = ASSIGN_PATTERN.exec(text)) {
    const raw = (m[1] ?? '').trim().replace(/^["'`]|["'`]$/gu, '').trim()
    if (raw === '') continue
    // 值后面常跟中文说明（"password: Passw0rd123! 记一下"）：在第一个中文字符处截断，
    // 只看前缀——前缀为空说明这本来就是一句说明文字（"密码是见文档"），放过。
    const value = raw.split(/[\u3400-\u9fff]/u)[0]?.trim() ?? ''
    if (value === '') continue
    if (PLACEHOLDER_PATTERN.test(value)) continue
    // 值必须像"东西"：含字母或数字
    if (!/[A-Za-z0-9]/.test(value)) continue
    // 单 token 沿用原判据（≥6 字符）；多词组合只要不是占位符就判——
    // `password: a very secret thing` 这种带空格的写法以前是完整的绕过路径。
    const words = value.split(/\s+/u)
    if (words.length === 1 && value.length < 6) continue
    return {
      matched: mask(value),
      reason: '命中赋值式凭证（形如 password: ...），已隔离待审',
    }
  }

  for (const token of text.split(/[\s"'`,;，；()（）[\]{}<>]+/u)) {
    if (looksLikeOpaqueSecret(token)) {
      return { matched: mask(token), reason: '命中高熵不透明串（疑似密钥），已隔离待审' }
    }
  }

  return null
}

/** 比较用归一化：去空白与标点、统一全半角、大小写折叠（中文原样保留） */
export function squashForCompare(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 3-gram 集合：中文没有词边界，用字符三元组比词更稳 */
function trigrams(input: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i + 3 <= input.length; i += 1) set.add(input.slice(i, i + 3))
  return set
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** 候选太短时「包含关系」没有判别力（一句「好的」能被子句命中） */
const MIN_COMPARE_CHARS = 24
/** 检索片段太短也不比 */
const MIN_RECALL_CHARS = 16

/**
 * 「检索结果原样再摄取」判定：候选与最近命中的某条高度重复、没有新增信息。
 *
 * 三种形态都算：
 *  1. 候选是命中片段的子串 —— 典型的「把检索到的原文抄进记忆」；
 *  2. 候选把整段包了一层壳、长度几乎没有增加（≤1.3×）—— 摘录后加一句"记住这个"；
 *  3. 长度都够长且 3-gram 相似度 ≥0.92（且长度比 ≤1.3）—— 改了几个字的复述。
 *
 * 只跟**最近一次检索**比，不跟全库比：全库相似是「同义改写」，那是值钱的;
 * 刚检索完就复述，才是没有新增信息的搬运。
 */
export function findVerbatimRecall(
  content: string,
  recent: readonly RecallRecord[],
): RecallRecord | null {
  const candidate = squashForCompare(content)
  if (candidate.length < MIN_COMPARE_CHARS) return null

  for (const record of recent) {
    const recalled = squashForCompare(record.content ?? '')
    if (recalled.length < MIN_RECALL_CHARS) continue

    if (recalled.includes(candidate)) return record
    if (candidate.includes(recalled) && candidate.length <= recalled.length * 1.3) return record

    if (
      recalled.length >= 40 &&
      candidate.length >= 40 &&
      candidate.length <= recalled.length * 1.3 &&
      jaccard(trigrams(recalled), trigrams(candidate)) >= 0.92
    ) {
      return record
    }
  }
  return null
}

/**
 * 准入判定：先看凭据（更严重、也更确定），再看是否原样再摄取。
 * 顺序有讲究：一条含口令的候选同时"重复"时，理由应写成凭据——
 * 那才是审的人要处理的问题。
 */
export function checkAdmission(content: string, ctx: AdmissionContext = {}): AdmissionVerdict {
  const text = typeof content === 'string' ? content : ''
  if (text.trim() === '') return ADMISSION_ALLOW

  const secret = detectSecret(text)
  if (secret !== null) {
    return { allow: false, category: 'secret', reason: secret.reason, matched: secret.matched }
  }

  const verbatim = findVerbatimRecall(text, ctx.recent ?? [])
  if (verbatim !== null) {
    return {
      allow: false,
      category: 'verbatim',
      reason: `与本轮检索到的记忆 ${verbatim.memoryId} 高度重复、没有新增信息，已隔离待审`,
      matched: mask(squashForCompare(text).slice(0, 24)),
    }
  }

  return ADMISSION_ALLOW
}
