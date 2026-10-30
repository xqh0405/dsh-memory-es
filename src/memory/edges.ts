/**
 * 阶段 5.2：写入时建边。
 *
 * 语义边界（为什么是这个区间）：
 *  · `maxScore`（默认 0.85）以上算**重复**——入库时已被 `content_sha256` 去重拦住，
 *    真走到建边这步说明内容不同但语义几乎相同，建边没有信息量，徒增噪声；
 *  · `minScore`（默认 0.55）以下算**不相关**——kNN 永远会返回 topK，哪怕全是噪声；
 *  · 中间这段才是「相关但不重复」，也正好落在实测的去重带 `0.75~0.85` 两侧。
 *
 * 全部是纯函数：ES 查询与写回在 `save.ts`，这里只做取舍，便于单测。
 */

/** 一条邻接边：指向 `id`，权重是写入时的相似度。 */
export interface Edge {
  id: string
  /** 相似度（cosine），保留 4 位小数 */
  weight: number
}

/** kNN 命中的最小面（只要 id 与分数） */
export interface NeighborHit {
  id: string
  score: number
}

export interface PickNeighborsOptions {
  /** 排除自己，避免自环 */
  excludeId?: string
  /** 低于该相似度不建边 */
  minScore: number
  /** 大于等于该相似度视为重复，不建边 */
  maxScore: number
  /** 最多保留几条边 */
  topK: number
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * 从 kNN 命中里挑出该建边的邻居。
 *
 * 规则：排除自身 / 非有限分数 / 空 id；分数落在 `[minScore, maxScore)`；
 * 同一 id 只留最高分；按分数降序；截断 `topK`。
 */
export function pickNeighbors(
  hits: readonly NeighborHit[],
  options: PickNeighborsOptions,
): Edge[] {
  const { excludeId, minScore, maxScore, topK } = options
  if (!Number.isFinite(minScore) || !Number.isFinite(maxScore) || !Number.isInteger(topK) || topK < 0) {
    throw new Error('pickNeighbors: minScore / maxScore / topK 非法')
  }
  if (topK === 0) return []

  const best = new Map<string, number>()
  for (const hit of hits) {
    const id = typeof hit.id === 'string' ? hit.id.trim() : ''
    if (id === '' || id === excludeId) continue
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) continue
    // 先舍入再判区间：存进去的值才代表「这条边属于哪个带」。
    // 用原始分数判、再用舍入值存，会让 0.84996 被存成 0.85 而冒充判重带边界（实测踩过）。
    const weight = round4(hit.score)
    if (weight < minScore || weight >= maxScore) continue
    const seen = best.get(id)
    if (seen === undefined || weight > seen) best.set(id, weight)
  }

  return [...best.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, topK)
    .map(([id, weight]) => ({ id, weight }))
}

/**
 * 把新边合并进已有邻接表（幂等）。
 *
 *  · 同一 id 取**较大**权重：邻居不会因为一次查询结果偏弱就被削弱；
 *  · 已有但本轮没出现的边**保留**：kNN 的 topK 有限，本轮没进 topK 不等于不相关；
 *  · 排序后截断 `topK`，保证邻接表大小有上界（否则 268 条库会膨胀成 O(n²)）。
 */
export function mergeEdges(
  existing: readonly Edge[],
  incoming: readonly Edge[],
  topK: number,
): Edge[] {
  if (!Number.isInteger(topK) || topK < 0) {
    throw new Error('mergeEdges: topK 必须是非负整数')
  }
  if (topK === 0) return []

  const merged = new Map<string, number>()
  for (const edge of existing) {
    const id = typeof edge.id === 'string' ? edge.id.trim() : ''
    if (id === '' || typeof edge.weight !== 'number' || !Number.isFinite(edge.weight)) continue
    merged.set(id, edge.weight)
  }
  for (const edge of incoming) {
    const id = typeof edge.id === 'string' ? edge.id.trim() : ''
    if (id === '' || typeof edge.weight !== 'number' || !Number.isFinite(edge.weight)) continue
    const seen = merged.get(id)
    if (seen === undefined || edge.weight > seen) merged.set(id, edge.weight)
  }

  return [...merged.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, topK)
    .map(([id, weight]) => ({ id, weight: round4(weight) }))
}

/**
 * 把 `related` 字段读成边数组（旧文档没有该字段、或被手工写坏时一律当空）。
 * `related` 是 `enabled:false` 的 object，读回来就是原始 JSON。
 */
export function readEdges(raw: unknown): Edge[] {
  if (!Array.isArray(raw)) return []
  const out: Edge[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const weight = typeof record.weight === 'number' ? record.weight : Number.NaN
    if (id === '' || !Number.isFinite(weight)) continue
    out.push({ id, weight: round4(weight) })
  }
  return out
}
