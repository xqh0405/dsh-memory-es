/**
 * 三道去重 / 冲突判定（文档 §9.4）。判定逻辑做成纯函数，ES 查询留在 cli 里做，
 * 这样「阈值怎么判」可以被单测钉死——阈值错一次的代价是团队库被重复内容淹掉。
 *
 * 语义（照文档，别自作主张改）：
 *  1. `content_sha256` 精确命中 → `duplicate`，跳过（团队库已有同文）；
 *  2. kNN top-5 里最高相似度 ≥ 0.90 → `merge_candidate`，判重复、走合并/更新而不是新增；
 *  3. 同 `topic_key` 且相似度 0.6~0.9 → `pending`，进人工队列（**不写团队库**，避免半成品进检索）；
 *  4. 其余 → `new`，正常入库。
 *
 * 为什么 pending 不落库：我们的检索只按 `status=active` 过滤，写进去就会立刻可被检索到，
 * 「pending 不进检索结果」这条就破了。等 S9 有了人工队列的存储再落库。
 *
 * @module dsh-memory-es/consolidate/dedupe
 */

export type DedupeVerdict = 'new' | 'duplicate' | 'merge_candidate' | 'pending'

export interface NeighborHit {
  id: string
  /** kNN 的 cosine 相似度（0~1） */
  score: number
  contentSha256?: string
  topicKey?: string
}

export interface DedupeDecision {
  verdict: DedupeVerdict
  /** 决定依据，给人看的（dry-run 报告里会打） */
  reason: string
  /** 命中最近邻（merge/duplicate 时用来指点「和哪条重复了」） */
  neighborId?: string
  /** 最高相似度（没有邻居时为 null） */
  topScore: number | null
}

export const SIMILAR_DUPLICATE = 0.9
export const SIMILAR_SAME_TOPIC = 0.6

/**
 * 纯判定：给定「团队库里的精确命中」与「kNN 邻居」，决定这条该怎么处理。
 *
 * @param input.shaHit 团队库里 content_sha256 精确命中的 doc_id（null = 没命中）
 * @param input.neighbors kNN 邻居（按相似度降序；本函数不依赖顺序，自己取最大）
 * @param input.topicKey 待写条目的 topic_key
 */
export function decideDedupe(input: {
  shaHit: string | null
  neighbors: readonly NeighborHit[]
  topicKey: string
  duplicateThreshold?: number
  sameTopicThreshold?: number
}): DedupeDecision {
  const duplicateThreshold = input.duplicateThreshold ?? SIMILAR_DUPLICATE
  const sameTopicThreshold = input.sameTopicThreshold ?? SIMILAR_SAME_TOPIC

  if (input.shaHit !== null) {
    return { verdict: 'duplicate', reason: '团队库已有相同 content_sha256', neighborId: input.shaHit, topScore: 1 }
  }

  const best = input.neighbors.reduce<NeighborHit | null>((acc, hit) => (acc === null || hit.score > acc.score ? hit : acc), null)

  if (best === null) {
    return { verdict: 'new', reason: '团队库没有相近条目', topScore: null }
  }
  if (best.score >= duplicateThreshold) {
    return {
      verdict: 'merge_candidate',
      reason: `最近邻相似度 ${best.score.toFixed(3)} ≥ ${duplicateThreshold}，判重复（走合并而非新增）`,
      neighborId: best.id,
      topScore: best.score,
    }
  }
  if (best.score >= sameTopicThreshold && best.topicKey !== undefined && best.topicKey === input.topicKey) {
    return {
      verdict: 'pending',
      reason: `同 topic_key 且相似度 ${best.score.toFixed(3)} 落在 ${sameTopicThreshold}~${duplicateThreshold}，可能是同主题不同结论，进人工队列`,
      neighborId: best.id,
      topScore: best.score,
    }
  }
  // 走到这里有两种情况：① 相似度不够；② 相似度落在 0.6~0.9 但 topic_key 不同。
  // 文案必须分开——否则会打印出「相似度 0.789 低于 0.6」这种自相矛盾的报告（S8 实测踩到）。
  const reason =
    best.score < sameTopicThreshold
      ? `最近邻相似度 ${best.score.toFixed(3)} 低于 ${sameTopicThreshold}，判新条目`
      : `最近邻相似度 ${best.score.toFixed(3)} 在 ${sameTopicThreshold}~${duplicateThreshold}，但 topic_key 不同（判不同主题）`
  return { verdict: 'new', reason, neighborId: best.id, topScore: best.score }
}
