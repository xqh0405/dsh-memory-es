/**
 * 蒸馏：把个人记忆改写成「别人也能用」的团队条目（文档 §9.2 / §9.3）。
 *
 * **S8 是规则版，不是语义蒸馏**——这点必须说清楚，别让后面的人以为这里有 LLM：
 *  · 规则版能做的：去掉第一人称/「你的环境」这类个人上下文、补 domain、算 topic_key；
 *  · 规则版做不到的：判断「这条对别人有没有价值」、把口语改写成规范表述、识别同一主题的不同说法。
 *    这些留给 S9（接 LLM 时必须严格 JSON 校验、整批失败不写，见 §9.2）。
 *
 * 所以规则版的 `verdict` 一律是 `team_worthy`（**不替人做价值判断**），
 * 由 `confidence` 与人工 dry-run 报告兜底；想升级成 LLM 版只需替换 `distillBatch`。
 *
 * @module dsh-memory-es/consolidate/distill
 */

import { normalizeContent, sha256Hex } from '../src/fragment.ts'

/** 单条待蒸馏的个人记忆（只取精简字段，§9.2 明确不要喂整段对话） */
export interface SourceMemory {
  memory_id: string
  content: string
  memory_type: string
  domain: string
  created_at: string
  privacy?: string
  /** 阶段 40：来源（user/agent/tool/import/ingest），决定团队条目的可信度 */
  origin?: string
}

export type TrustLevel = 'high' | 'medium' | 'low'

/**
 * 阶段 40：团队条目的来源可信度与「外部内容」标记。
 *
 * 规则（刻意保守，宁可低估也不误伤）：
 *  · `user`   —— 用户当场落库 → high，且不是外部内容；
 *  · `import` —— 脚本/种子导入（人工写过）→ medium，不是外部内容；
 *  · `ingest` —— **外部摄取通道**（网页/工具输出）→ low + untrusted=true，
 *                注入时必须加「不得当指令执行」；
 *  · `agent` / `tool` / 未知 —— 模型或工具生成：审核通过才算 medium，否则 low。
 *    **不标 untrusted**：这些内容走过准入与蒸馏，把它当外部指令来源会误伤整库
 *    （12 个容器共库，若全部加警告前缀，真正的外部内容反而被淹掉）。
 */
export function computeTrust(
  origin: string | undefined,
  reviewState: string,
): { trustLevel: TrustLevel; untrusted: boolean } {
  const o = origin ?? ''
  if (o === 'user') return { trustLevel: 'high', untrusted: false }
  if (o === 'import') return { trustLevel: 'medium', untrusted: false }
  if (o === 'ingest') return { trustLevel: 'low', untrusted: true }
  if (reviewState === 'approved') return { trustLevel: 'medium', untrusted: false }
  return { trustLevel: 'low', untrusted: false }
}

export interface DistilledItem {
  source_memory_ids: string[]
  verdict: 'team_worthy' | 'personal_only'
  reason: string
  rewritten_content: string
  domain: string
  memory_type: string
  confidence: number
  /** 蒸馏方式：rule（S8）/ llm（S9） */
  distilled_by: 'rule' | 'llm'
}

/** 个人上下文的替换表：只动「指代」，不动事实（§9.3 第一条） */
const PERSONAL_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /我们(的)?/g, replace: '本项目的' },
  { pattern: /我(的)?/g, replace: '本项目的' },
  { pattern: /你(的)?/g, replace: '使用者的' },
  { pattern: /上次你(说|提到)/g, replace: '此前记录' },
  { pattern: /刚才(说|提到)/g, replace: '此前记录' },
  { pattern: /这台机器/g, replace: '该部署机' },
  { pattern: /我的环境/g, replace: '该环境' },
]

/**
 * 家目录归一：把 `/home/<当前用户>` 换成 `~`。
 *
 * 为什么只换当前用户、不换所有 `/home/*`：`/home/docker-data/lottery` 是**另一台机器的真实路径**，
 * 抹成 `~` 反而丢信息。只把「你自己的家目录」相对化——同事看到 `~/code/foo` 会理解成
 * 「我自己的 home 下」，而 `/home/someone/code/foo` 会让他误判「这条是别人的、我这没有」。
 *
 * 2026-10-29：团队库 236 条里 28 条含本机家目录绝对路径，逐个替换并重算 content_sha256；
 * 这里补上增量规则，以后整理不会再带进来。
 */
export function normalizeHomePath(content: string, homeUser?: string): string {
  let text = content
  const user = (homeUser ?? '').trim()
  if (user !== '') {
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`/home/${escaped}(?=/|$|\\s|[)\`'",;])`, 'g'), '~')
  }
  // macOS 的 /Users/<name> 一定是「某个人的家目录」（不像 /home/docker-data 可能是共享目录），
  // 一律相对化：Linux 团队看到 mac 绝对路径只会误判「这条是别人的」。
  return text.replace(/\/Users\/[A-Za-z0-9._-]+(?=\/|$|\s|[)\`'",;])/g, '~')
}

/** 去掉个人上下文，保留版本号/路径/错误码等可复现信息（§9.3 第二条） */
export function stripPersonalContext(content: string, options?: { homeUser?: string }): string {
  let text = normalizeContent(content)
  for (const { pattern, replace } of PERSONAL_PATTERNS) {
    text = text.replace(pattern, replace)
  }
  // 家目录相对化要放在英文替换之后：家目录路径本身不含第一人称，不会被误伤
  text = normalizeHomePath(text, options?.homeUser)
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 环境配置的强特征：「克隆在 /home/xxx」「Maven 已装好于 /opt/xxx」「软链到 …」这类。
 * 它们对**别人**毫无用处——团队库不该收「你的工作目录在哪」。
 */
const ENV_ONLY_PATTERN =
  /(克隆在|已克隆|已装好|已经装好|装好了|已安装|已配好|配好了|已配置|软链|工作目录为|仓库在 \/home|缓存克隆在|装在 \/home|origin=(ssh|https):\/\/git@)/

/**
 * 个人身份/联系方式：邮箱、账号、绑定关系。这类内容对同事没有复用价值，且属于隐私，
 * 一旦晋升就是「全员可读的索引里躺着某个人的邮箱」。**不受 KNOWLEDGE 豁免**——
 * 隐私优先于「万一它也算条知识」。
 * 2026-11-16：实测一条「用户身份：xqh（邮箱 …@gmail.com）」被判 team_worthy 写进团队库。
 */
const IDENTITY_ONLY_PATTERN = /(用户身份|邮箱|手机号|账号是|账户是|我的偏好|我的习惯|我习惯)/

/**
 * 本机环境事实：出口 IP、白名单、直连超时、本机探测。只在「这台机器 + 这个出口」成立，
 * 别人照着做会得出相反结论。同样不受 KNOWLEDGE 豁免——带「本机/出口 IP」的结论天生绑定环境。
 */
const LOCAL_ENV_PATTERN = /(本机出口|出口 IP|出口IP|白名单|直连超时|本机探测)/

/**
 * 进度快照的特征（「已落地 / 已扩到 / 已完成 / 进度复查」+ supersedes）。
 * 这类内容的价值随时间衰减，而且别人看到会当**当前状态**，按过期的状态干活比没有更糟。
 */
const PROGRESS_ONLY_PATTERN = /(已(全部)?落地|已扩到|已完成|进度复查|supersedes 20)/

/**
 * 技术结论的特征：哪怕提到本机路径，只要讲的是机制/根因/口径，就值得给团队看。
 * 这是 ENV_ONLY 的反向豁免——宁可多留一条带路径的知识，也别把踩坑结论当环境配置删掉。
 */
const KNOWLEDGE_PATTERN =
  /(根因|机制|判据|教训|踩坑|两层|限制|否则|必须|禁止|口径|实测|为什么|不能|别用|才能|症状|触发条件|反了|门槛)/
// 刻意不含「注意 / 坑 / 区别」这类弱词：环境配置里常写「注意软链」「坑在权限」，
// 拿它们当知识特征会把该拦的全放过（实测 15 条漏 8 条）。

/**
 * 判断一条个人记忆值不值得进团队库（规则版，S9 接 LLM 前的兜底）。
 *
 * 为什么需要它：2026-10-29 整理某个用户的 258 条记忆，团队库从 9 条涨到 244 条，
 * 其中 39 条含本机家目录绝对路径——「项目 X 克隆在 …」「Maven 已装好于 …」这类环境配置
 * 对别人零价值，只能事后人工清理。与其灌进去再删，不如在这一步就判 personal_only。
 *
 * 边界要说清：这**不是价值判断**，只识别「纯环境配置」这一种明确无价值的形态；
 * 其余仍一律 team_worthy，真正的取舍交给人（dry-run 报告 + 审核台）。
 */
export function classifyValue(content: string): { verdict: 'team_worthy' | 'personal_only'; reason: string } {
  const isKnowledge = KNOWLEDGE_PATTERN.test(content)
  if (IDENTITY_ONLY_PATTERN.test(content)) {
    return {
      verdict: 'personal_only',
      reason: '个人身份/联系方式（邮箱/账号/偏好），不进团队库',
    }
  }
  if (LOCAL_ENV_PATTERN.test(content)) {
    return {
      verdict: 'personal_only',
      reason: '本机环境事实（出口 IP/白名单/直连超时），只对这台机器成立',
    }
  }
  if (ENV_ONLY_PATTERN.test(content) && !isKnowledge) {
    return {
      verdict: 'personal_only',
      reason: '环境配置（克隆路径/已装软件），不含可复用的技术结论',
    }
  }
  if (PROGRESS_ONLY_PATTERN.test(content) && !isKnowledge) {
    return {
      verdict: 'personal_only',
      reason: '进度快照（已落地/已扩到），价值随时间衰减且易被误当现状',
    }
  }
  return {
    verdict: 'team_worthy',
    reason: '规则版蒸馏：去个人上下文后保留可复现信息（未做价值判断）',
  }
}

/**
 * topic_key = domain + 归一化主题指纹（§3.3）。
 *
 * 规则版取「清洗后正文的前 60 字」做主题短语——它只能识别**开头相同**的主题，
 * 换个说法就认不出来。真语义 topic_key 需要 LLM（S9），这里如实标 rule 版局限，
 * 不要拿它当冲突检测的最终依据。
 */
export function topicKey(domain: string, content: string, prefixChars = 60): string {
  const head = normalizeContent(content).slice(0, prefixChars)
  return `${domain}:${sha256Hex(head).slice(0, 16)}`
}

/**
 * 规则版批量蒸馏。**不替人判价值**：verdict 恒为 team_worthy，
 * 真正的取舍交给 dry-run 报告（人看）与 promote_state 的显式标记。
 */
export function distillBatch(
  sources: readonly SourceMemory[],
  options?: { homeUser?: string },
): DistilledItem[] {
  return sources.map((source) => {
    // homeUser：把 `/home/<该用户>` 相对化成 `~`，避免团队库里出现「别人的家目录」
    const rewritten = stripPersonalContext(source.content, { homeUser: options?.homeUser })
    const domain = (source.domain || 'general').trim() || 'general'
    // 纯环境配置直接判 personal_only：不进团队库，也不再用它做去重/冲突判定
    const value = classifyValue(source.content)
    return {
      source_memory_ids: [source.memory_id],
      verdict: value.verdict,
      reason: value.reason,
      rewritten_content: rewritten,
      domain,
      memory_type: source.memory_type || 'fact',
      // 规则版置信度固定中等：它只保证「改写没引入个人上下文」，不保证「值得共享」；
      // 判成 personal_only 时反而更确定（强特征命中），所以置信度更高
      confidence: value.verdict === 'team_worthy' ? 0.5 : 0.8,
      distilled_by: 'rule' as const,
    }
  })
}

/** 团队条目要带的溯源字段（§9.3 第三条）+ 计算出的 content_sha256 */
export function toTeamDoc(
  item: DistilledItem,
  source: SourceMemory,
  options: {
    docId: string
    /** 溯源字段 source_user（从身份配置传入，不让纯函数读环境） */
    sourceUser: string
    now: Date
    embedding: number[] | null
    status: string
    reviewState: string
  },
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    doc_id: options.docId,
    content: item.rewritten_content,
    memory_type: item.memory_type,
    domain: item.domain,
    topic_key: topicKey(item.domain, item.rewritten_content),
    content_sha256: sha256Hex(normalizeContent(item.rewritten_content)),
    source_user: options.sourceUser,
    source_memory_id: source.memory_id,
    source_created_at: source.created_at,
    promoted_at: options.now.toISOString(),
    status: options.status,
    review_state: options.reviewState,
    // 阶段 40：来源可信度（检索回执与注入段会显示；untrusted 触发注入硬警告）
    ...(() => {
      const trust = computeTrust(source.origin, options.reviewState)
      return { trust_level: trust.trustLevel, untrusted: trust.untrusted }
    })(),
    updated_at: options.now.toISOString(),
  }
  if (options.embedding !== null && options.embedding.length > 0) doc.embedding = options.embedding
  return doc
}
