/**
 * 凭据类规则的**唯一来源**（2026-11-10 审查 #8）。
 *
 * 为什么要有这个模块：`src/memory/admission.ts`（写入准入 → 隔离）与
 * `consolidate/sensitive.ts`（晋升团队库前的闸 → blocked）**各写了一份凭据规则**，
 * 阈值与字符类逐渐漂移，结果同一条凭据在两条链路上结论相反：
 *
 *   `API key 为 ABCDEF123456` / `access key 为 LTAI…` / `sk-proj-…` / `sk-ant-api03-…`
 *   / 40 位 AWS secret —— admission 全部**放行**，而 sensitive 早就能拦（2026-11-10 实测）。
 *
 * 现在两边都 import 这里，凭据类只有一份定义。**注意边界**：
 *  · `id_card` / `phone` **刻意不进来** —— 手机号、身份证在个人记忆里是正常内容，
 *    用户 2026-11-10 拍板「不同步」，它们只留在 consolidate 侧（进团队库才拦）；
 *  · 各自的**判定逻辑**仍留在原模块（admission 要脱敏片段与「像不像值」的二次判断，
 *    sensitive 要起止下标），这里只统一「规则长什么样」。
 *
 * @module dsh-memory-es/security/secret-rules
 */

/**
 * 凭据关键词。
 *
 * `pass` 故意不在词表里（英文单词误伤），只认完整拼写与中文说法。
 *
 * ⚠️ 分隔符类是 `[_\s-]?` 而不是旧版的 `[_-]?` —— **空格是关键**：
 * 英文多词短语 `API key` / `access key` / `secret key` 旧版整段匹配不上，
 * 赋值式正则无锚可挂，于是 `API key 为 …` 一路放行（2026-11-10 实测漏报之一）。
 */
export const CREDENTIAL_WORDS =
  'password|passwd|pwd|passphrase|secret|token|api[_\\s-]?key|access[_\\s-]?key|'
  + 'secret[_\\s-]?key|private[_\\s-]?key|client[_\\s-]?secret|'
  + '密码|口令|密钥|私钥|令牌'

/** 赋值式分隔符：显式赋值（冒号/等号）与中文「是 / 为」——写的人就是在给值 */
export const ASSIGN_SEPARATORS = '是|为|[:=]'

/**
 * 散文式分隔符：英文 `is` / `are`。
 *
 * 单独一档、**值的判据更严**：`password: X` 是明确赋值，`password is X` 更多是
 * 在陈述要求（`password is required` / `token is invalid`）——用同一套宽松判据会把
 * 技术文档整片误伤。所以散文式额外要求值里**含数字**（见 admission 的 prose 分支）：
 * `password is required`（无数字）放过，`password is abc123456`（有数字）拦下。
 */
export const PROSE_SEPARATORS = '\\bis\\b|\\bare\\b'

/**
 * 已知令牌前缀：云厂商与常见服务的固定形态，认出来就不用看熵了。
 *
 * 三处与旧版的差别（都是 2026-11-10 实测漏报）：
 *  · 云厂商补 `LTAI`（阿里云）与 `AKID`（腾讯云）—— 旧版只有 `AKIA`；
 *  · `sk-` 字符类补 `-`/`_`、阈值 20 → 16 —— 旧版 `[A-Za-z0-9]{20,}` 认不出
 *    `sk-proj-…` / `sk-ant-api03-…` 这类带连字符的现代 key（阈值也不够）；
 *  · `gh[pousr]_` 阈值取 **20**（旧版准入 30、晋升侧 20，两边不一致）：
 *    真实 GitHub token 是 `ghp_` + 36 位，而 `ghp_` 前缀没有合法撞车，
 *    20 两侧都覆盖、也不会漏掉被截短的样本。
 */
export const KNOWN_TOKEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: '云厂商 AccessKey', re: /\b(?:LTAI|AKIA|AKID)[A-Za-z0-9]{12,24}\b/ },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'OpenAI/Anthropic/国内平台 Key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
]

/** 私钥块（PEM）。公钥与证书在扫描前会被整块剔除，不参与判定。 */
export const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * 私钥块**完整形态**（BEGIN → END，带命中区间）。
 *
 * 与 `PRIVATE_KEY_PATTERN` 的分工：写入准入只判「有没有」（一个 `test` 就够）；
 * 晋升侧（consolidate）要拿起止下标给人工定位，必须整块。两处共用这一份定义。
 */
export const PEM_PRIVATE_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

/** URL 里带密码的连接串：`mysql://user:pass@host` */
export const DSN_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{4,}@/iu

/** 公钥 / 证书块：不是秘密却极像凭据，扫描前整块剔除（否则 base64 正文被熵规则整片误判） */
export const PEM_PUBLIC_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]*PUBLIC KEY|CERTIFICATE)-----[\s\S]*?-----END (?:[A-Z0-9 ]*PUBLIC KEY|CERTIFICATE)-----/g

/** 剥掉零宽字符：`pass​word:` 与 `password:` 语义上是同一个词 */
export const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/gu

/** 占位符 / 说明性取值：看到这些就不算「真的写了凭据」 */
// ⚠️ `change-?me` 要带可选连字符：最常见的写法就是 `change-me`，
// 旧写法只有 `changeme`，于是 `password=change-me` 被准入侧当成真口令隔离
// （2026-11-10 对拍测试当场抓到；晋升侧的 lookahead 一直是 `change-?me`）。
export const PLACEHOLDER_PATTERN =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|%[A-Z_]+%|your[_-].*|change-?me|placeholder|redacted|example|dummy|none|null|true|false|略|见.*|同上|不变|已脱敏|按需.*|环境变量.*)$/iu

/**
 * 高熵不透明串：base64/url-safe 形态的长串，且不是可公开识别的哈希。
 *
 * 长度下限 **40**（旧版 44）：AWS secret access key 正好 40 位且含 `/`，
 * 44 的门槛把它整条放行（2026-11-10 实测漏报之一）。
 * 降到 40 不会明显放宽误报面 —— 40~63 位的串**必须含 `+`/`/`/`=`**才会被判
 * （纯字母数字仍要 ≥64），而纯 hex 一律放过（commit id / sha256 不是秘密）。
 */
export const MIN_OPAQUE_SECRET_LENGTH = 40

export function looksLikeOpaqueSecret(token: string): boolean {
  if (token.length < MIN_OPAQUE_SECRET_LENGTH || token.length > 512) return false
  if (!/^[A-Za-z0-9+/_=-]+$/.test(token)) return false
  // 纯 hex = commit id / sha256 / 文件哈希，公开可共享，绝不该被当凭据
  if (/^[0-9a-f]+$/i.test(token)) return false
  // 必须大小写与数字混排：随机密钥几乎必然如此，普通标识符很难同时满足
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) return false
  // 含 base64 标点（+ / = / _）的长度 40 就够可疑；纯字母数字的长串要更长才判，
  // 否则 `lottery-cloud-java-change` 这类连字符串会被误伤。
  return /[+/=_]/.test(token) ? true : token.length >= 64
}

/**
 * 扫描副本：去零宽 + NFKC（全角冒号/等号折半角），再剔除公钥块。
 *
 * 顺序有讲究：先归一化**再**剔公钥 —— 反过来的话 `-----BEGIN​PUBLIC KEY-----`
 * （插了零宽的公钥）匹配不上 PEM 规则，会被熵规则当成凭据隔离（2026-11-02 审计实测）。
 */
export function normalizeForScan(content: string): string {
  return content.replace(ZERO_WIDTH, '').normalize('NFKC').replace(PEM_PUBLIC_BLOCK, ' ')
}

/** 命中后的脱敏片段：只留前 3 位与长度，让人认得出是哪一处、又猜不出值 */
export function maskSecret(value: string): string {
  return `${value.slice(0, 3)}***（${value.length} 字符）`
}
