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
    return {
      source_memory_ids: [source.memory_id],
      verdict: 'team_worthy' as const,
      reason: '规则版蒸馏：去个人上下文后保留可复现信息（未做价值判断）',
      rewritten_content: rewritten,
      domain,
      memory_type: source.memory_type || 'fact',
      // 规则版置信度固定中等：它只保证「改写没引入个人上下文」，不保证「值得共享」
      confidence: 0.5,
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
