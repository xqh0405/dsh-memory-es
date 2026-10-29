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

/** 去掉个人上下文，保留版本号/路径/错误码等可复现信息（§9.3 第二条） */
export function stripPersonalContext(content: string): string {
  let text = normalizeContent(content)
  for (const { pattern, replace } of PERSONAL_PATTERNS) {
    text = text.replace(pattern, replace)
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 环境配置的强特征：「克隆在 /home/xxx」「Maven 已装好于 /opt/xxx」「软链到 …」这类。
 * 它们对**别人**毫无用处——团队库不该收「你的工作目录在哪」。
 */
const ENV_ONLY_PATTERN =
  /(克隆在|已克隆|已装好|已经装好|装好了|已安装|已配好|配好了|已配置|软链|工作目录为|仓库在 \/home|缓存克隆在|装在 \/home|origin=(ssh|https):\/\/git@)/

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
 * 为什么需要它：2026-10-29 整理 xqh 的 258 条记忆，团队库从 9 条涨到 244 条，
 * 其中 39 条含 `/home/user`——「项目 X 克隆在 …」「Maven 已装好于 …」这类环境配置
 * 对别人零价值，只能事后人工清理。与其灌进去再删，不如在这一步就判 personal_only。
 *
 * 边界要说清：这**不是价值判断**，只识别「纯环境配置」这一种明确无价值的形态；
 * 其余仍一律 team_worthy，真正的取舍交给人（dry-run 报告 + 审核台）。
 */
export function classifyValue(content: string): { verdict: 'team_worthy' | 'personal_only'; reason: string } {
  const isKnowledge = KNOWLEDGE_PATTERN.test(content)
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
export function distillBatch(sources: readonly SourceMemory[]): DistilledItem[] {
  return sources.map((source) => {
    const rewritten = stripPersonalContext(source.content)
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
    updated_at: options.now.toISOString(),
  }
  if (options.embedding !== null && options.embedding.length > 0) doc.embedding = options.embedding
  return doc
}
