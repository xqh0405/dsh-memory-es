/**
 * 纯函数契约层：Node 端与测试共用，不 import 任何 @deepseek-ai 包、不碰网络。
 * 把“数据怎么算”钉死在这里，检索/写入两侧都从这里取，避免两处实现漂移。
 *
 * @module dsh-memory-es/fragment
 */

import { createHash } from 'node:crypto'

import { readEdges } from './edges.ts'

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
export interface RrfOptions {
  /**
   * 两路名次一致时的额外加成（乘性，0.1 = 最多 +10%）。
   * 0 = 关闭（默认）。
   *
   * 为什么值得加：RRF 只累加「名次贡献」，但「两路都排第 1」和「一路第 1、一路第 10」
   * 在 RRF 里差别没有想象中大（1/61+1/61 vs 1/61+1/70）。这个 bonus 直接表达
   * 「两个独立信号达成一致」——那比单路高分更可信。
   */
  agreementBonus?: number
  /** 名次差达到多少时加成归零（按每一路的候选数 topK 取） */
  span?: number
}

export function rrfFuse(routes: Hit[][], k = 60, options: RrfOptions = {}): Fused[] {
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

  const bonus = options.agreementBonus ?? 0
  if (bonus > 0) {
    const span = Math.max(1, options.span ?? 20)
    for (const item of acc.values()) {
      const ranks = item.routeRanks.filter((r): r is number => typeof r === 'number')
      // 只有一路命中时没有「一致」可言，不加成
      if (ranks.length < 2) continue
      const gap = Math.max(...ranks) - Math.min(...ranks)
      item.fusedScore *= 1 + bonus * Math.max(0, 1 - gap / span)
    }
  }
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

/**
 * 按 memory_type 的半衰期（天）。
 *
 * 为什么按类型分：统一的 30 天对 `task_progress`（两周就该过时）太慢，
 * 对 `fact` / `decision`（确认过的工程事实与口径）又太快——同一把尺子量不出差别。
 *
 * ⚠️ 数字**不是抄** LivingMemory 的：它的 TTL 描述的是「从对话里自动抽取的原子」的寿命
 * （factual 180 天、planned 2 天），而我们的记忆是**模型显式保存、人确认过的稳定事实**，
 * 语义更重，所以整体给得更长。照抄会把正当的知识提前衰减掉。
 */
export const MEMORY_TYPE_HALF_LIFE_DAYS: Readonly<Record<string, number>> = {
  identity: 3650, // 自述：十年尺度，近似「不衰减」——它本来就该比事实更稳定
  decision: 365, // 决定：用户定下的口径，一年内基本不变
  fact: 365, // 事实：工程事实，确认过就长期成立
  context: 180, // 背景：项目/环境背景，半年内仍有效
  preference: 90, // 偏好：会变，但不像进度那样按周过期
  task_progress: 14, // 进度：两周内还有意义
}

/** 未知类型/缺字段时的兜底半衰期（天），与 config 的 recencyHalfLifeDays 默认值一致 */
export const DEFAULT_HALF_LIFE_DAYS = 30

/**
 * 排序信号配置（对应 config.ts 的 `ranking` 组）。
 * 三项都是**乘子**，作用在跨库合并之后的 fusedScore 上——绝不混进 RRF 分
 * （两者尺度差一个数量级，见 scoreMargin 的注释）。
 */
export interface RankingConfig {
  /** importance 强度：0=关；1 表示 critical ×1.1 / low ×0.9 */
  importanceWeight: number
  /** 命中次数强度：hitWeight × log1p(hit_count)/10 */
  hitWeight: number
  /** 时间新鲜度强度：recencyWeight × exp(-ageDays / halfLife) */
  recencyWeight: number
  /** 时间衰减半衰期（天）：memory_type 不在上表时的兜底 */
  recencyHalfLifeDays: number
  /** 每命中一次，寿命延长多少（比例）；0 = 关闭强化 */
  reinforcementPerHit: number
  /** 强化封顶：总延长不超过这个比例，避免老条目「越用越不朽」 */
  reinforcementCap: number
  /** 两路名次一致的加成（乘性；0 = 关闭）。评测驱动，默认 0 */
  agreementBonus: number
  /**
   * 扩散激活强度（阶段 5.3）：`score += activationAlpha × Σ(邻居分 × 边权)`。
   * 0 = 关闭。邻居只算**同一次检索结果集里**的，不做二次召回。
   */
  activationAlpha: number
  /**
   * 阶段 6.3：情绪一致召回强度。`score × (1 + moodWeight × 相似度)`。
   * 0 = 关闭。**只提权、不降权**——心情差时想不起开心的事会形成自我强化回路。
   */
  moodWeight: number
}

export const DEFAULT_RANKING: RankingConfig = {
  importanceWeight: 1,
  hitWeight: 0.2,
  recencyWeight: 0.1,
  recencyHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  reinforcementPerHit: 0.1,
  reinforcementCap: 0.5,
  agreementBonus: 0,
  activationAlpha: 0,
  moodWeight: 0,
}

/**
 * importance 的乘子取值。
 * 刻意温和（±10%）：它是**微调**，不是主导——否则排序会退化成「按标签排」，
 * 而真正相关的那条反而被一个 critical 标签压下去。
 */
export const IMPORTANCE_FACTORS: Readonly<Record<string, number>> = {
  critical: 1.1,
  normal: 1,
  low: 0.9,
}

/**
 * 阶段 5.3：扩散激活。
 *
 * 语义：一条记忆的邻居如果**也在本次结果集里**，就把它的一部分分借给这条记忆。
 * 只做一次传播、不迭代——迭代会放大偏差，而且排出来的名次没法解释。
 *
 * 为什么不做二次召回：那会让「一条相关」变成「一条相关拖出一串」，候选池失控，
 * 而且评测集是固定的，扩池会同时抬高 hit 和噪声，掩盖真实收益。
 *
 * `alpha = 0` 时逐条返回原对象（评测里要求「与基线逐条一致」）。
 */
export function spreadActivation(hits: readonly ScopedHit[], alpha: number): ScopedHit[] {
  if (!Number.isFinite(alpha) || alpha === 0 || hits.length < 2) return [...hits]

  // 只认本次结果集里的邻居：没有出场的不算，避免「扩池」带来的假提升
  const scores = new Map<string, number>()
  for (const hit of hits) scores.set(hit.id, hit.fusedScore)

  const boosted = hits.map((hit) => {
    const edges = readEdges(hit.source.related)
    if (edges.length === 0) return hit
    let spread = 0
    let used = 0
    for (const edge of edges) {
      const neighbor = scores.get(edge.id)
      if (neighbor === undefined) continue
      spread += neighbor * edge.weight
      used += 1
    }
    if (used === 0) return hit
    return { ...hit, fusedScore: hit.fusedScore + alpha * spread }
  })

  return boosted.sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
    if (a.origin !== b.origin) return a.origin === 'personal' ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

/**
 * 阶段 6.3：一条记忆的情绪色彩与当前心情有多接近。
 *
 * 两个标量都在 [-1, 1] 上，用 `1 - |v - m| / 2`（距离越近越接近 1）。
 * 记忆没标 valence 时返回 `null`——**不加成也不惩罚**，避免"没标 = 中性 = 不加分"
 * 变成对未标注条的隐性打压。
 */
export function moodAffinity(memoryValence: number, moodValence: number): number | null {
  if (!Number.isFinite(memoryValence) || !Number.isFinite(moodValence)) return null
  const v = Math.max(-1, Math.min(1, memoryValence))
  const m = Math.max(-1, Math.min(1, moodValence))
  return 1 - Math.abs(v - m) / 2
}

/**
 * 在 `mergeScopes` 之后应用排序乘子。
 *
 * 三项信号的语义：
 *  · importance —— 用户显式标注的重要度；
 *  · hit_count  —— 被检索命中的次数（反馈信号，由 search 侧回写）；
 *  · 时间新鲜度 —— 优先最近被命中/写入的条目（指数衰减）。
 *
 * 缺字段一律按中性处理（importance=normal、hit_count=0、时间未知不加不减），
 * 这样老文档不需要回填也能参与排序。
 */
export function applyRanking(
  hits: readonly ScopedHit[],
  cfg: RankingConfig,
  now: Date,
  mood?: { valence: number } | null,
): ScopedHit[] {
  if (cfg.importanceWeight === 0 && cfg.hitWeight === 0 && cfg.recencyWeight === 0 && cfg.moodWeight === 0) {
    return [...hits]
  }
  const ranked = hits.map((hit) => {
    const src = hit.source
    const imp = typeof src.importance === 'string' ? (IMPORTANCE_FACTORS[src.importance] ?? 1) : 1
    const hitCount = typeof src.hit_count === 'number' && Number.isFinite(src.hit_count) ? src.hit_count : 0
    const stamp =
      typeof src.last_hit_at === 'string'
        ? src.last_hit_at
        : typeof src.updated_at === 'string'
          ? src.updated_at
          : ''
    const at = Date.parse(stamp)
    const ageDays = Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 86_400_000) : null

    let factor = 1
    factor += cfg.importanceWeight * (imp - 1)
    // 阶段 6.3：只提权不降权；没标 valence 的条目不参与
    if (cfg.moodWeight !== 0 && mood !== undefined && mood !== null) {
      const memoryValence = typeof src.valence === 'number' ? src.valence : Number.NaN
      const affinity = moodAffinity(memoryValence, mood.valence)
      if (affinity !== null) factor += cfg.moodWeight * affinity
    }
    factor += cfg.hitWeight * (Math.log1p(hitCount) / 10)
    if (ageDays !== null) {
      // 半衰期按类型取；被反复命中的条目寿命更长（封顶），
      // 否则「用了三年的关键约定」和「三周前的一句随手记」会一样快地被衰减掉。
      const base = typeof src.memory_type === 'string'
        ? (MEMORY_TYPE_HALF_LIFE_DAYS[src.memory_type] ?? cfg.recencyHalfLifeDays)
        : cfg.recencyHalfLifeDays
      const growth = 1 + Math.min(cfg.reinforcementCap, hitCount * cfg.reinforcementPerHit)
      const halfLife = base * growth
      if (halfLife > 0) factor += cfg.recencyWeight * Math.exp(-ageDays / halfLife)
    }
    return factor === 1 ? hit : { ...hit, fusedScore: hit.fusedScore * factor }
  })
  return ranked.sort((a, b) => {
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
