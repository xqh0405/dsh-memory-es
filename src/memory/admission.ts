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
 * 凭据规则统一到 `src/security/secret-rules.ts`（2026-11-10 审查 #8）。
 *
 * 此处曾自带一份词表 / 令牌前缀 / 熵门限，与 `consolidate/sensitive.ts` 各写各的，
 * 阈值逐渐漂移：`API key 为 …`、`access key 为 LTAI…`、`sk-proj-…`、`sk-ant-api03-…`、
 * 40 位 AWS secret —— 五条在本模块全部放行、而晋升侧早就能拦（同一条凭据两套结论）。
 * 现在两边 import 同一份规则；`id_card` / `phone` 刻意不上提（个人库里是正常内容）。
 */
import {
  ASSIGN_SEPARATORS,
  CREDENTIAL_WORDS,
  DSN_WITH_PASSWORD,
  KNOWN_TOKEN_PATTERNS,
  PLACEHOLDER_PATTERN,
  PRIVATE_KEY_PATTERN,
  PROSE_SEPARATORS,
  looksLikeOpaqueSecret,
  maskSecret,
  normalizeForScan,
} from '../security/secret-rules.ts'

// 老 API 保留：tests/admission.test.ts 等一直从本模块取它
export { looksLikeOpaqueSecret }

/**
 * 赋值式（显式）：`password: abcdef` / `密码是 abcdef` / `token=...` / `API key 为 …`。
 *
 * 分隔符带中文的「是 / 为」——中文会话里的口令几乎从不写成冒号。
 * 2026-11-02 评审起：值取到行尾/句末标点（最多 60 字），再判断「像不像一个值」，
 * 而不是只取第一个 token（那样 `password：ab cd12345678` 会整条放行）。
 */
const ASSIGN_PATTERN = new RegExp(
  `(?:${CREDENTIAL_WORDS})\\s*(?:${ASSIGN_SEPARATORS})\\s*["']?([^\\n。；;]{2,60})`,
  'giu',
)

/**
 * 散文式（英文 `is` / `are`）：`password is abc123456`。
 *
 * 单独一条正则，因为**值的判据必须更严**：`password: X` 是明确赋值，
 * `password is X` 更多在陈述要求（`password is required` / `token is invalid`），
 * 同一套宽松判据会把技术文档整片误伤 —— 所以散文式要求值里**含数字**（见 detectSecret）。
 */
const PROSE_ASSIGN_PATTERN = new RegExp(
  `(?:${CREDENTIAL_WORDS})\\s*(?:${PROSE_SEPARATORS})\\s*["']?([^\\n。；;]{2,60})`,
  'giu',
)

/** 扫描副本：去零宽 + NFKC，再剔除公钥块（规则与顺序的说明见 secret-rules） */
function scanText(content: string): string {
  return normalizeForScan(content)
}

/** 脱敏片段：只留前 3 位与长度，让「审的人」认得出是哪一处、又猜不出值 */
const mask = maskSecret

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

  // 显式赋值（`:` `=` 是 为）与散文式（is are）共用同一套「像不像值」的判断，
  // 只在「值要不要含数字」上分档 —— 理由见 PROSE_ASSIGN_PATTERN。
  const explicit = matchAssignment(ASSIGN_PATTERN, text, false)
  if (explicit !== null) return explicit

  const prose = matchAssignment(PROSE_ASSIGN_PATTERN, text, true)
  if (prose !== null) return prose

  for (const token of text.split(/[\s"'\u0060,\uff0c\uff1b\uff08\uff09[\]{}<>]+/u)) {
    if (looksLikeOpaqueSecret(token)) {
      return { matched: mask(token), reason: '命中高熵不透明串（疑似密钥），已隔离待审' }
    }
  }

  return null
}

/**
 * 跑一条赋值式正则，做「像不像一个值」的二次判断；没命中或全被过滤返回 null。
 *
 * 这些过滤是**误杀防线**，别删：占位符（`<your-password>`）、纯说明文字
 * （`密码是见文档`）、没有字母数字的分隔符残留，都必须放过。
 *
 * @param requireDigit 散文式专用：值必须含数字。`password: X` 是明确赋值所以宽松；
 *   `password is X` 更多在陈述要求 —— 没有这道要求的话
 *   `password is required` / `token is invalid` 会被整片误伤（2026-11-10 加）。
 */
function matchAssignment(
  pattern: RegExp,
  text: string,
  requireDigit: boolean,
): { matched: string; reason: string } | null {
  pattern.lastIndex = 0
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const raw = (m[1] ?? '').trim().replace(/^["'`]|["'`]$/gu, '').trim()
    if (raw === '') continue
    // 值后面常跟中文说明（"password: Passw0rd123! 记一下"）：在第一个中文字符处截断，
    // 只看前缀——前缀为空说明这本来就是一句说明文字（"密码是见文档"），放过。
    const value = raw.split(/[\u3400-\u9fff]/u)[0]?.trim() ?? ''
    if (value === '') continue
    if (PLACEHOLDER_PATTERN.test(value)) continue
    // 值必须像"东西"：含字母或数字
    if (!/[A-Za-z0-9]/.test(value)) continue
    if (requireDigit && !/[0-9]/.test(value)) continue
    // 单 token 沿用原判据（≥6 字符）；多词组合只要不是占位符就判——
    // `password: a very secret thing` 这种带空格的写法以前是完整的绕过路径。
    const words = value.split(/\s+/u)
    if (words.length === 1 && value.length < 6) continue
    return {
      matched: mask(value),
      reason: requireDigit
        ? '命中赋值式凭证（形如 password is ...），已隔离待审'
        : '命中赋值式凭证（形如 password: ...），已隔离待审',
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
