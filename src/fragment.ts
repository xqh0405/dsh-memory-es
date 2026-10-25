/**
 * 纯函数契约层：Node 端与测试共用，不 import 任何 @deepseek-ai 包、不碰网络。
 * 把“数据怎么算”钉死在这里，检索/写入两侧都从这里取，避免两处实现漂移。
 *
 * @module dsh-memory-es/fragment
 */

import { createHash } from 'node:crypto'

/** 检索命中的最小结构（BM25 与 kNN 两路共用） */
export interface Hit {
  /** 文档 id（ES 的 _id） */
  id: string
  /** 该路的原始分数：BM25 的 _score，或 kNN 的 cosine 相似度 */
  score: number
  /** 命中的 _source（只取需要的字段） */
  source: Record<string, unknown>
}

/** 融合后的命中：额外记录在每一路里的名次，便于排查 */
export interface Fused extends Hit {
  /** routeRanks[i] = 在第 i 路里的名次（1 起）；缺席为 undefined */
  routeRanks: Array<number | undefined>
  /** RRF 融合分 */
  fusedScore: number
}

/**
 * 正文归一化：NFKC（全角转半角）+ 折叠空白 + 去首尾空白。
 * 幂等：normalizeContent(normalizeContent(x)) === normalizeContent(x)。
 * 用作幂等键（content_sha256）的计算输入。
 */
export function normalizeContent(input: string): string {
  return input.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** 归一化正文的 SHA-256（十六进制），用于精确去重 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * RRF（Reciprocal Rank Fusion）融合多路结果：score = Σ 1/(k + rank)，rank 从 1 起。
 * 只依赖名次、不依赖各路分数尺度——这正是它适合混合 BM25 + cosine 的原因。
 */
export function rrfFuse(routes: Hit[][], k = 60): Fused[] {
  const acc = new Map<string, Fused>()
  routes.forEach((hits, routeIdx) => {
    hits.forEach((hit, idx) => {
      const rank = idx + 1
      const cur = acc.get(hit.id)
      if (cur) {
        cur.routeRanks[routeIdx] = rank
        cur.fusedScore += 1 / (k + rank)
      } else {
        const routeRanks: Array<number | undefined> = []
        routeRanks[routeIdx] = rank
        acc.set(hit.id, { ...hit, routeRanks, fusedScore: 1 / (k + rank) })
      }
    })
  })
  return [...acc.values()].sort((a, b) => b.fusedScore - a.fusedScore)
}

/**
 * 置信度 margin = top1 - top2。
 *
 * 注意：**必须作用在 kNN 的原始 cosine 分数上，不能用于 RRF 融合分**。
 * 两者尺度完全不同（cosine 在 0~1，RRF ≈ 1/(60+rank) ≈ 0.016），
 * 文档 §8.4 实测得到的 0.05 门槛是 cosine 尺度上的结论。
 *
 * 入参须已按相似度降序；少于 2 条返回 0（无法比较，交给调用方判空）。
 */
export function scoreMargin(scoresDesc: number[]): number {
  if (scoresDesc.length < 2) return 0
  return scoresDesc[0] - scoresDesc[1]
}

/** 记忆来源：个人库（一人一索引）还是团队库 */
export type Scope = 'personal' | 'team'

/** 融合后带来源标记的命中（`origin` 而不是 `source`：`source` 已经被 `_source` 文档占了） */
export interface ScopedHit extends Fused {
  origin: Scope
  /** 去重键：content_sha256；文档没带就退回 id（保证一定能去重） */
  contentHash: string
}

/**
 * 合并多个库的融合结果（文档 §8.3）：
 *  1. 每条乘来源权重（个人库 1.2，让贴近当前上下文的那条不被团队库压过）；
 *  2. 按 content_sha256 去重——同一条被晋升后两库都有，保留高分那条；
 *  3. 按加权后的分数降序；同分时个人优先、再按 id，保证结果稳定（可测）。
 */
export function mergeScopes(
  groups: ReadonlyArray<{ source: Scope; hits: readonly Fused[] }>,
  options: {
    weights?: Partial<Record<Scope, number>>
    hashOf?: (hit: Fused) => string
  } = {},
): ScopedHit[] {
  const weights = options.weights ?? {}
  const best = new Map<string, ScopedHit>()

  for (const group of groups) {
    const weight = weights[group.source] ?? 1
    for (const hit of group.hits) {
      const rawHash = options.hashOf?.(hit)
      const contentHash =
        rawHash ??
        (typeof hit.source.content_sha256 === 'string' && hit.source.content_sha256 !== ''
          ? hit.source.content_sha256
          : hit.id)
      const candidate: ScopedHit = {
        ...hit,
        origin: group.source,
        contentHash,
        fusedScore: hit.fusedScore * weight,
      }
      const previous = best.get(contentHash)
      if (previous === undefined || candidate.fusedScore > previous.fusedScore) {
        best.set(contentHash, candidate)
      }
    }
  }

  return [...best.values()].sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
    if (a.origin !== b.origin) return a.origin === 'personal' ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

/** 给模型看的精简命中（§6.3 的返回结构，content 截断） */
export interface Projected {
  memory_id: string
  content: string
  memory_type: string
  domain: string
  updated_at: string
  source: Scope
  score: number
}

/**
 * 投影：把 ES 命中裁成给模型看的精简字段（content 截断）。
 * `source` 优先用调用方显式给的值（检索层知道这条从哪个索引来）；
 * 不给时才退回「有 source_user 就算团队库」的旧启发式。
 */
export function projectHit(hit: Fused, maxChars = 500, source?: Scope): Projected {
  const src = hit.source
  const rawContent = typeof src.content === 'string' ? src.content : ''
  return {
    memory_id: typeof src.memory_id === 'string' ? src.memory_id : hit.id,
    content: rawContent.length > maxChars ? `${rawContent.slice(0, maxChars)}…` : rawContent,
    memory_type: typeof src.memory_type === 'string' ? src.memory_type : '',
    domain: typeof src.domain === 'string' ? src.domain : '',
    updated_at: typeof src.updated_at === 'string' ? src.updated_at : '',
    source: source ?? (src.source_user === undefined ? 'personal' : 'team'),
    score: hit.fusedScore,
  }
}

/** 把投影后的命中渲染成给模型读的短文本（空结果也要说清楚） */
export function renderText(hits: ReadonlyArray<Projected>): string {
  if (hits.length === 0) return '没有找到相关记忆。'
  const lines = hits.map((hit, index) => {
    const day = hit.updated_at.slice(0, 10)
    const meta = [hit.source, hit.memory_type, day].filter((part) => part !== '').join('·')
    return `${index + 1}. [${meta}] ${hit.content}`
  })
  return lines.join('\n')
}
