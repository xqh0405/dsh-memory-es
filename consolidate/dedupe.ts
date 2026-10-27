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
  topicKey?: string
  /** 正文：冲突判定要比对「相反结论」，没有正文就只能按相似度判重复 */
  content?: string
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

/**
 * 「疑似重复」下界：0.75~0.9 一律进人工队列。
 *
 * 旧值曾是 0.6，且**额外要求 topic_key 相同**——那个条件让这道闸实际永不触发。
 * topic_key = `domain:sha256(正文前 60 字)`（见 distill.ts），只能识别「开头相同」的主题，
 * 同一件事换个说法就变成不同 key。2026-10-27 实测 9 条候选里 5 条落在 0.766~0.883，
 * 却全部被判 new 直接入库。所以判断依据换成纯相似度，topic_key 只在报告文案里做补充说明。
 */
export const SIMILAR_SUSPECT = 0.75

/** @deprecated 旧名，仅为兼容外部引用保留；语义已由 SIMILAR_SUSPECT 取代 */
export const SIMILAR_SAME_TOPIC = SIMILAR_SUSPECT

/**
 * 纯判定：给定「团队库里的精确命中」与「kNN 邻居」，决定这条该怎么处理。
 *
 * @param input.shaHit 团队库里 content_sha256 精确命中的 doc_id（null = 没命中）
 * @param input.neighbors kNN 邻居（按相似度降序；本函数不依赖顺序，自己取最大）
 * @param input.topicKey 待写条目的 topic_key（**只用于文案，不再作为闸门**）
 */
export function decideDedupe(input: {
  shaHit: string | null
  neighbors: readonly NeighborHit[]
  topicKey: string
  duplicateThreshold?: number
  /** 疑似重复下界；保留旧参数名以兼容既有调用与测试 */
  sameTopicThreshold?: number
}): DedupeDecision {
  const duplicateThreshold = input.duplicateThreshold ?? SIMILAR_DUPLICATE
  const suspectThreshold = input.sameTopicThreshold ?? SIMILAR_SUSPECT

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
  if (best.score >= suspectThreshold) {
    const sameTopic = best.topicKey !== undefined && best.topicKey === input.topicKey
    return {
      verdict: 'pending',
      reason: sameTopic
        ? `同 topic_key 且相似度 ${best.score.toFixed(3)} 落在 ${suspectThreshold}~${duplicateThreshold}，可能是同主题不同结论，进人工队列`
        : `相似度 ${best.score.toFixed(3)} 落在 ${suspectThreshold}~${duplicateThreshold}，near-duplicate 但 topic_key 不同（可能是换个说法讲同一件事），进人工队列由人裁决`,
      neighborId: best.id,
      topScore: best.score,
    }
  }
  return {
    verdict: 'new',
    reason: `最近邻相似度 ${best.score.toFixed(3)} 低于 ${suspectThreshold}，判新条目`,
    neighborId: best.id,
    topScore: best.score,
  }
}
