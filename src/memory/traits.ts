/**
 * 阶段 7.2：夜间提炼——从近期记忆里归纳「稳定的自述」（traits）。
 *
 * 与 `distill.ts` 的区别：distill 改写**单条**记忆的摘要与关键词；这里是从**一批**
 * 记忆里归纳出**不属于任何单条**的结论（"他偏好先给结论"不是哪条记忆的内容）。
 *
 * 三条硬规则：
 *  1. **只写候选，不写生效条目**。产出落 `memory_type=identity` + `status='pending'`，
 *     检索只认 `active`，所以提炼结果不会自己溜进上下文；采纳由 7.3 的审核台做。
 *  2. **必须带证据**。每条 trait 记下它依据的 memory_id，审核时能点开核对。
 *     没有证据的归纳等于让模型编。
 *  3. **模型不可用就什么都不做**。提炼是增强能力，不能因为没配模型就报错或写垃圾。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { knnBody } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { normalizeContent, sha256Hex } from '../fragment.ts'
import { checkAdmission } from './admission.ts'
import { NON_FACT_MEMORY_TYPES, assertWriteAllowed, personalIndexFor, type WriteMode } from './common.ts'
import { IDENTITY_MEMORY_TYPE } from './save.ts'

/** 候选 trait 的状态：检索只认 active，所以 pending 天然不进结果 */
export const TRAIT_STATUS = 'pending' as const

/** 归纳时喂给模型的最大条数（context 与成本的上界） */
export const TRAITS_MAX_SOURCE = 80
/** 单次最多接受多少条 trait（防止模型一次吐 50 条） */
export const TRAITS_MAX_OUTPUT = 8
/** 一条 trait 的字符上限 */
export const TRAIT_MAX_CHARS = 300
/** 证据条数下限：少于两条支撑的不叫"稳定" */
export const TRAIT_MIN_EVIDENCE = 2
/**
 * 待审自述候选的存量上限（用户 2026-11-03 定：超过 20 条就不再增长）。
 *
 * 为什么是「存量」而不是「每日」：候选是给人审的，一天 5 条看着不多，
 * 但没人连审三天就攒 15 条，而 2026-11-01 实测一天就攒到 22 条待审。
 * 每日闸门（maxPerDay）管增量、这个管总量，两个都得有。
 */
export const TRAITS_MAX_PENDING = 20

/**
 * 同义候选的判定阈值（kNN 余弦相似度）。
 *
 * 为什么需要它：模型每次归纳的措辞都不同（「自建的 UI/面板/日志一律用中文」vs
 * 「你要求自建的 UI、面板、日志一律使用中文」），而原先的幂等键是**精确内容哈希**，
 * 措辞一变就被当成新条目。2026-10-31 实测：一次提炼新写的 7 条里 3 条是旧 pending 的同义重复。
 *
 * 0.9 的取舍：bge-m3 对「同义换句」通常给到 0.93+，对不同主题的句子一般在 0.85 以下；
 * 阈值定低了会把「同属一个主题但结论不同」的两条误判成重复。
 */
export const TRAIT_DEDUP_MIN_SCORE = 0.9
/**
 * 锚定条目的判重阈值（比普通条目严）。
 *
 * 锚点 = 「这条我定稿了」。普通条目 0.88 是「差不多像」的门槛，锚定的用 0.82：
 * 只要新候选和定稿版有八成像就不再产出。用户 2026-11-01 的要求——自述要少而准，
 * 宁可漏掉一点新意，也不要每天冒出一条「又说了一遍」的。
 */
export const TRAIT_DEDUP_MIN_SCORE_ANCHORED = 0.82

/**
 * 判重只取最近邻几条。
 *
 * 从 5 提到 8：锚定条目要用更严的阈值，可它如果排在 5 名之外，kNN 根本不会返回它，
 * 那道更严的闸就形同虚设。多取 3 条的成本可以忽略。
 */
export const TRAIT_DEDUP_TOPK = 8

/**
 * 「写具体了」的硬标记。
 *
 * 提示词里已经要求抽象、还给了正误对比，但模型仍会把项目细节包进「倾向」的句式里
 * （「破坏性变更会先…先 mvn deploy 到 Nexus」——句式是倾向，内容是项目操作）。
 * 2026-11-01 用户看到 17 条候选后明确说「不要这么具体」，所以这里再加一道**代码级**的闸：
 * 出现下列任何标记就不是「做事方式」，是「这个项目怎么做」。
 *
 * 只收那些**几乎不可能**出现在抽象倾向里的东西（反引号命令、路径、端口、
 * 下划线标识符、版本号）。像 SQL / JVM 这类技术名词不算——换个项目照样成立。
 */
const CONCRETE_MARKERS: readonly RegExp[] = [
  /`[^`]+`/,
  /(?:^|\s)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/,
  /:\d{2,5}\b/,
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/,
  /\b(?:mvn|docker|kubectl|helm|npm|pnpm|grep|awk|sed|curl|wget|systemctl|journalctl)\s+\S/,
  /\bv?\d+\.\d+\.\d+\b/,
]

/** 这条候选是不是「太具体」了（命中任一硬标记）。 */
export function isTooConcrete(content: string): boolean {
  return CONCRETE_MARKERS.some((re) => re.test(content))
}

export const TRAITS_SYSTEM = [
  '你是一个记忆整理器。你的任务是：从一个人最近的记忆条目里，归纳出关于他自己的、稳定的**做事方式**。',
  '',
  '## 什么叫「稳定的做事方式」',
  '',
  '一句话能说清、换一个项目依然成立的那种。例如：',
  '- 「先给结论再解释理由」',
  '- 「判断是否生效看外部可验证的结果，而不是返回值有没有报错」',
  '- 「破坏性变更先完成不可逆的前置准备，再动代码」',
  '',
  '## 什么不算（这一条最重要，请严格）',
  '',
  '- **具体事件、一次性决定、某个项目的操作细节** —— 那是普通记忆，不需要提升',
  '- 任何**只在这个项目里成立**的说法：项目名、产品名、仓库名、命令、函数或字段名、',
  '  文件路径、端口号、数据库表名、版本号、机器名、具体配置项',
  '- 只出现一次的行为',
  '',
  '判断标准：**把项目名全部换掉，这句话还成立吗？** 不成立就说明它太具体，要往上抽象一层。',
  '',
  '正误对比（左边不要，右边才对）：',
  '- ❌「framework 改动必须先 mvn deploy 到 Nexus 再触发构建」',
  '  ✅「有依赖关系的变更按依赖顺序落地，先准备好下游再改上游」',
  '- ❌「UPDATE 后核对 rowcount、构建看镜像 digest」',
  '  ✅「不相信返回值，用独立手段复核实际结果」',
  '- ❌「容器里 TZ=Asia/Shanghai 而 CI 是 UTC，裸 datetime.now() 差 8 小时」',
  '  ✅「处理时间先确认时区，再下结论」',
  '- ❌「15 场北单 12/13/14/15 串 1 真实 58 万注 vs 预算 4096」',
  '  ✅「估算量级时按最坏组合算，不用理想情况的乘积」',
  '',
  '## 硬性要求',
  '',
  '1. 每条必须能独立成立，读者不知道任何上下文也能看懂；不要写「上面提到的」「这些记忆里」。',
  `2. 每条尽量控制在 60 字以内、不超过 ${TRAIT_MAX_CHARS} 字。**写得越具体越没有价值**。`,
  '3. 每条必须由至少 2 条记忆支撑，并给出支撑条目的 id。**例外**：素材里标注 (preference) 的条目是用户明确表达的偏好与规矩，它本身就是直接证据，1 条即可支撑；其它类型（fact/decision/context）仍需至少 2 条互相印证——那才叫归纳，否则只是复述。',
  '4. 用第二人称写（"你倾向于……"）或中性陈述，不要写"用户"。',
  `5. 一次最多 ${TRAITS_MAX_OUTPUT} 条。如果看不出任何稳定的模式，输出空数组 []。**宁可空，不要凑**。`,
  '6. 不要用反引号包裹命令或字段名——出现这种东西就说明你写具体了。',
  '',
  '输出格式（只输出 JSON，不要解释）：',
  '[',
  '  {"content": "你倾向于先给结论再解释理由", "evidence_ids": ["id1", "id2"]}',
  ']',
].join('\n')

export interface TraitCandidate {
  content: string
  evidence_ids: string[]
}

/** 喂给模型的源条目（id + 正文 + 类型） */
export interface TraitSource {
  memory_id: string
  content: string
  memory_type: string
}

export interface TraitsDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'search'>
  writer: Pick<EsClient, 'index'>
  /**
   * 写入开关（2026-11-10 下沉）：缺省 `'on'`，不传不改变历史行为。
   * LLM 直写候选与 memory_save 走同一道闸（配置文案一直这么承诺）。
   */
  writeMode?: WriteMode
  /**
   * 向量服务：候选自述也要带 embedding，否则下一批提炼没法跟它做语义判重
   * （kNN 只查得到有向量的文档）。不可用时跳过判重，**不能因此阻断写入**。
   */
  embed?: { embed(text: string, call?: { signal?: AbortSignal }): Promise<number[]> }
  /** 索引的向量维度，与 `knnBody` 一致 */
  dims?: number
  /**
   * 每天最多写几条候选（跨多次运行累计）。不传就用 TRAITS_MAX_OUTPUT 的默认口径。
   * 定时任务一天跑一次、手动调一次也算一轮——没有这个上限，候选会越堆越多。
   *
   * ⚠️ 这是**增量**闸门（管「今天写了几条」）；管「一共攒了多少」的是 maxPending。
   * 两个都得有：只有每日闸门，连写三天照样攒出一堆没人审的候选。
   */
  maxPerDay?: number
  /**
   * 待审存量上限（默认 20，用户 2026-11-03 定）：pending 总数达到它就不再写，
   * **不继续增长**。这是存量口径，与 maxPerDay 的每日增量口径互补。
   *
   * 检查放在调模型之前：满了连 summarize 都不调，省一次 LLM。
   */
  maxPending?: number
  /** 单次模型返回的候选上限 */
  maxOutput?: number
  /** 同义判定阈值（kNN 余弦） */
  dedupMinScore?: number
  /** 锚定条目的同义判定阈值（更严，默认 0.82） */
  dedupMinScoreAnchored?: number

  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}

/** 把源条目拼成 prompt 正文。id 必须带上去，否则模型给不出证据。 */
export function buildTraitsPrompt(sources: readonly TraitSource[], days: number): string {
  const lines = sources.map((s) => `- [${s.memory_id}] (${s.memory_type}) ${s.content}`)
  return [
    `下面是最近 ${days} 天里的 ${sources.length} 条记忆。请归纳出关于这个人自己的稳定模式。`,
    '',
    ...lines,
  ].join('\n')
}

/**
 * 解析模型输出。容忍 ```json 围栏与前后废话——模型很少严格只吐 JSON。
 *
 * 校验比 distill 严：`content` 必须非空且不超长、`evidence_ids` 至少两条且必须
 * **真的出现在源集合里**（防止模型编造 id）。
 */
export function parseTraitsOutput(
  text: string,
  sourceIds?: ReadonlySet<string>,
  sourceTypes?: ReadonlyMap<string, string>,
  maxOutput: number = TRAITS_MAX_OUTPUT,
): TraitCandidate[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: TraitCandidate[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { content?: unknown; evidence_ids?: unknown }
    if (typeof record.content !== 'string') continue
    const content = record.content.trim()
    if (content === '' || content.length > TRAIT_MAX_CHARS) continue
    if (!Array.isArray(record.evidence_ids)) continue
    const ids = record.evidence_ids
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim())
    // 去重：同一条证据重复三次不算三条支撑
    const unique = [...new Set(ids)]
    // 偏好类记忆是"用户说过一次的规矩"，本来就只存一份：要求两条会把它们全筛掉
    // （2026-10-30 实测：三条真实偏好各自只有一个证据，模型据规则输出空数组）。
    const hasPreferenceEvidence = unique.some((id) => sourceTypes?.get(id) === 'preference')
    const minEvidence = hasPreferenceEvidence ? 1 : TRAIT_MIN_EVIDENCE
    if (unique.length < minEvidence) continue
    if (sourceIds !== undefined && unique.some((id) => !sourceIds.has(id))) continue
    out.push({ content, evidence_ids: unique })
    if (out.length >= maxOutput) break
  }
  return out
}

/** 取最近 N 天的记忆作为素材：只要 active、排除 identity 自己与情绪状态文档 */
export async function collectTraitSources(
  deps: TraitsDeps,
  days: number,
): Promise<TraitSource[]> {
  const now = deps.now?.() ?? new Date()
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const res = await deps.reader.search(index, {
    size: TRAITS_MAX_SOURCE,
    _source: ['memory_id', 'content', 'memory_type'],
    sort: [{ updated_at: 'desc' }],
    query: {
      bool: {
        filter: [
          { term: { status: 'active' } },
          { range: { updated_at: { gte: since } } },
        ],
        must_not: [
          // identity / persona / journal 都不是「发生过什么」的素材：
          // identity 是产出物本身（再归纳就是自我循环），persona 说的是「我」不是「用户」，
          // journal 是我自己写的回顾（喂回去只会强化幻觉）。2026-10-31 只排了 identity，
          // persona 会被当成用户画像素材——正是 README 明令不能混的那条。
          { terms: { memory_type: [...NON_FACT_MEMORY_TYPES] } },
          // 情绪状态文档不是记忆素材
          { term: { status: 'mood' } },
          // 阶段 7.5：锚点自述不参与重新归纳——否则提炼会拿"你已经被确认的样子"再归纳一遍，
          // 只是把同一句话换个说法写回来，还多占一个候选位。
          { term: { anchor: true } },
        ],
      },
    },
  })
  const sources: TraitSource[] = []
  for (const hit of res.hits) {
    const src = hit.source as Record<string, unknown>
    if (typeof src.memory_id !== 'string' || typeof src.content !== 'string') continue
    sources.push({
      memory_id: src.memory_id,
      content: src.content,
      memory_type: typeof src.memory_type === 'string' ? src.memory_type : 'fact',
    })
  }
  return sources
}

/**
 * 今天已经写了多少条自述候选（pending + active）。
 *
 * 为什么按 `created_at` 而不是「本轮写了多少」：定时任务一天跑一次，但手动调一次
 * `memory_traits` 也算一轮。只看单次的话，一天调三次就能写 15 条——2026-11-01
 * 实测就是这么攒到 22 条待审的，人工审不过来，候选反而没人看。
 *
 * 查不到（ES 抖动）时返回 0：配额是「省人工」的手段，不该因为它自己挂了就阻断提炼。
 */
export async function countTraitsToday(deps: TraitsDeps): Promise<number> {
  const now = deps.now?.() ?? new Date()
  const start = new Date(now.getTime())
  start.setHours(0, 0, 0, 0)
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  try {
    const res = await deps.reader.search(index, {
      size: 0,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            { term: { memory_type: IDENTITY_MEMORY_TYPE } },
            { terms: { status: [TRAIT_STATUS, 'active'] } },
            { range: { created_at: { gte: start.toISOString() } } },
          ],
        },
      },
    })
    // search 已经把 ES 的 { hits: { total } } 归一成 { total: number, hits: Hit[] }
    return typeof res.total === 'number' ? res.total : 0
  } catch (err) {
    deps.log?.({ tool: 'traits', event: 'quota_count_failed', error: formatEsError(err) })
    return 0
  }
}

/**
 * 当前**待审**自述候选的存量（`status=pending` 总数，不看 created_at）。
 *
 * 与 countTraitsToday 的区别（两个闸门口径不同，别混）：
 *  · countTraitsToday = 今日增量（pending+active，限今天）→ 管「今天写了几条」；
 *  · 本函数 = 待审存量（只 pending，不限时间）→ 管「一共攒了多少没人审的」。
 * 每日闸门挡不住「连写三天攒 30 条」，存量闸门挡不住「一天写 25 条」——所以要两个。
 *
 * 查不到（ES 抖动）时返回 0：与每日配额同理，闸门自己挂了不该阻断提炼，
 * 但会记 pending_count_failed 日志，便于发现。
 */
export async function countPendingTraits(deps: TraitsDeps): Promise<number> {
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  try {
    const res = await deps.reader.search(index, {
      size: 0,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            { term: { memory_type: IDENTITY_MEMORY_TYPE } },
            { term: { status: TRAIT_STATUS } },
          ],
        },
      },
    })
    return typeof res.total === 'number' ? res.total : 0
  } catch (err) {
    deps.log?.({ tool: 'traits', event: 'pending_count_failed', error: formatEsError(err) })
    return 0
  }
}

/**
 * 查「是否已经有一条意思差不多的自述」。
 *
 * 只跟 `pending`（待审）与 `active`（已采纳）比：
 * - 已采纳的不能再产一份，否则每天早上都要驳同一句话；
 * - 已拒绝（`archived`）的**应当允许重新提出**——模型后来找到更强证据时，它就是新结论。
 *
 * 任何一步失败都返回 null（当作「没有重复」）：判重是省人工的手段，
 * 不能因为它挂了就让整轮提炼失败。
 */
export async function findTraitDuplicate(
  deps: TraitsDeps,
  content: string,
): Promise<{ memory_id: string; score: number; anchored: boolean; threshold: number } | null> {
  const embed = deps.embed
  const dims = deps.dims
  if (embed === undefined || dims === undefined) return null
  const index = personalIndexFor(deps.personalPrefix, deps.userId)

  let vector: number[]
  try {
    vector = await embed.embed(content)
  } catch (err) {
    deps.log?.({ tool: 'traits', event: 'dedup_embedding_failed', error: String(err).slice(0, 160) })
    return null
  }

  try {
    // status: null = 不按状态过滤，pending/active/archived 一起取回来再自己筛
    const res = await deps.reader.search(
      index,
      knnBody(vector, dims, { status: null, memory_type: IDENTITY_MEMORY_TYPE }, TRAIT_DEDUP_TOPK),
    )
    for (const hit of res.hits) {
      const src = hit.source as Record<string, unknown>
      const status = typeof src.status === 'string' ? src.status : ''
      if (status !== TRAIT_STATUS && status !== 'active') continue
      // 锚定条目用更严的阈值：定过稿的那几条不该再冒出新版本
      const anchored = src.anchor === true
      const threshold = anchored
        ? (deps.dedupMinScoreAnchored ?? TRAIT_DEDUP_MIN_SCORE_ANCHORED)
        : (deps.dedupMinScore ?? TRAIT_DEDUP_MIN_SCORE)
      if (!(hit.score >= threshold)) continue
      const memoryId = typeof src.memory_id === 'string' ? src.memory_id : hit.id
      return { memory_id: memoryId, score: hit.score, anchored, threshold }
    }
    return null
  } catch (err) {
    deps.log?.({ tool: 'traits', event: 'dedup_search_failed', error: formatEsError(err) })
    return null
  }
}

/** 写一条候选 trait。用内容哈希做幂等（同一条被提炼两次不会产生两份）。 */
export async function writeTraitCandidate(
  deps: TraitsDeps,
  trait: TraitCandidate,
  days: number,
): Promise<{ written: boolean; memory_id: string; quarantined?: boolean; reason?: string }> {
  // 写闸（2026-11-10 下沉）：LLM 直写候选与 memory_save 同一道闸——
  // 旧版只有准入（下面那段），governance.write=off 时照样能写候选。
  assertWriteAllowed(deps, '自述候选写入')
  // 2026-11-02 评审：准入此前只挂在 memory_save 一条路上，LLM 产物（traits/persona）
  // 直接写库且审核采纳后即 active —— 「明文口令被蒸馏进库」正是这条路径。补同一道闸。
  const verdict = checkAdmission(trait.content)
  if (!verdict.allow) {
    deps.log?.({ tool: 'traits', event: 'quarantine_skipped', reason: verdict.reason })
    return { written: false, memory_id: '', quarantined: true, reason: verdict.reason }
  }
  const now = deps.now?.() ?? new Date()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const memoryId = `trait-${hashContent(trait.content)}`

  const doc: Record<string, unknown> = {
    memory_id: memoryId,
    user_id: deps.userId,
    content: trait.content,
    memory_type: IDENTITY_MEMORY_TYPE,
    domain: 'general',
    privacy: 'private',
    importance: 'normal',
    // 来源戳：这条是插件自动提炼写的，不是模型在对话里调 memory_save（缺省会落 agent）
    origin: 'tool',
    // 关键：pending 而不是 active——检索只认 active，所以候选不会自己生效
    status: TRAIT_STATUS,
    promote_state: 'none',
    distill_state: 'traits',
    evidence_ids: trait.evidence_ids,
    traits_window_days: days,
    // ⚠️ 这两个派生字段必须与 buildMemoryDoc 同口径（2026-11-10 审查 #11/#12）：
    //  · content_sha256 旧版写的是 `hashContent()`（FNV-1a **8 位**），而 dedupeBody
    //    （dsl.ts）校验的是 **64 位 hex** → 永远命不中，同一正文既被提炼又被 save 时不去重；
    //    跨库按 sha 去重（fragment.ts）时两者也永不相等。
    //  · content_exact 旧版不写 → 标识符精确匹配对候选永远不命中，
    //    而且存量回填（scripts/backfill-distill-keys.ts）刚修好的一致性会被新写入重新打破。
    // `hashContent` 保留给 memoryId 派生（上面那行）—— 8 位做 id 够用，做去重键不够。
    content_sha256: sha256Hex(normalizeContent(trait.content)),
    content_exact: trait.content,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }

  // 候选也要带向量：没有它，下一批提炼的 kNN 判重根本看不到这一条，
  // 只能靠精确哈希——措辞一变就又写一份（2026-10-31 实测的症状）
  if (deps.embed !== undefined && deps.dims !== undefined) {
    try {
      doc.embedding = await deps.embed.embed(trait.content)
    } catch (err) {
      deps.log?.({ tool: 'traits', event: 'candidate_embedding_failed', error: String(err).slice(0, 160) })
    }
  }

  try {
    // create 而不是 index：同 id 已存在时返回 409，靠它做幂等（不会把已拒绝/已采纳的条目覆盖回 pending）
    await deps.writer.index(index, doc, { id: memoryId, refresh: 'wait_for', opType: 'create' })
    return { written: true, memory_id: memoryId }
  } catch (err) {
    if (isConflict(err)) return { written: false, memory_id: memoryId }
    deps.log?.({ tool: 'traits', event: 'write_failed', error: formatEsError(err) })
    throw err
  }
}

export interface TraitsResult {
  sources: number
  candidates: number
  written: number
  /** 因与已有 pending/active 自述同义而被跳过的条数（判重不可用时恒为 0） */
  duplicates: number
  /** 因「今天已写满 maxPerDay」而被跳过的条数 */
  quotaSkipped: number
  /** 因「写得太具体」（含命令/路径/端口/字段名）而被丢弃的条数 */
  concreteSkipped: number
  /** 因命中写入准入（疑似凭据/原样搬运）而未落库的条数 */
  blocked?: number
  /** 当天配额上限：只在「配额用完」时带出来给文案用 */
  maxPerDay?: number
  /**
   * 存量闸门（2026-11-03 用户要求：待审核不能超过 20 条，超过不继续增长）。
   * 这是**存量**口径——不看今天写了多少，只看 pending 总数。
   * 带出来给文案与日志用：满了时它是停下来的直接证据。
   */
  pendingCount?: number
  /** 存量上限（默认 20）：只在「存量已满」时带出来 */
  maxPending?: number
  skipped: string | null
  /** 干跑时有候选：直接列出它们的内容（干跑就是为了先看产出，只看数量没法评估） */
  candidatePreview?: string
  /** 干跑时带上模型原始输出（前 200 字符）：空数组和「解析失败」结果一样，必须能区分 */
  rawPreview?: string
  /** 原始输出总长度：与 rawPreview 对比可判断是否被 maxTokens 截断 */
  rawLength?: number
  /** 原始输出结尾：合法 JSON 应以 ] 收尾；不是就说明被截断 */
  rawTail?: string
}

/**
 * 编排：取素材 → （调用方给模型）→ 校验 → 写候选。
 *
 * 模型调用留在外面（`summarize` 由调用方注入）：这里不 import 宿主 llm 类型，
 * 便于单测，也让"没有模型服务"这件事在调用方一次判断完。
 */
export async function runTraitsJob(
  deps: TraitsDeps,
  input: { days: number; summarize: (prompt: string) => Promise<string>; dryRun?: boolean },
): Promise<TraitsResult> {
  const log = deps.log ?? (() => {})

  // ── 存量闸门（用户 2026-11-03 定：待审核不能超过 20 条，超过不继续增长）────
  // 放在最前面：满了就连素材收集和模型调用都跳过（LLM 是这条链上最贵的一步）。
  // dry_run 也停——写入已不可能，预演只会产出一批塞不进去的候选；
  // 返回值带 pendingCount，文案能直接说清「为什么这次没跑」。
  // 与每日配额的关系：这是存量（pending 总数），那是增量（今天写了几条），互补不重叠。
  const maxPending = deps.maxPending ?? TRAITS_MAX_PENDING
  const pendingCount = await countPendingTraits(deps)
  if (pendingCount >= maxPending) {
    log({ tool: 'traits', event: 'pending_full', pendingCount, maxPending })
    return {
      sources: 0,
      candidates: 0,
      written: 0,
      duplicates: 0,
      quotaSkipped: 0,
      concreteSkipped: 0,
      pendingCount,
      maxPending,
      skipped: 'pending_full',
    }
  }

  const sources = await collectTraitSources(deps, input.days)
  if (sources.length < TRAIT_MIN_EVIDENCE) {
    log({ tool: 'traits', skipped: 'too_few_sources', sources: sources.length })
    return { sources: sources.length, candidates: 0, written: 0, duplicates: 0, quotaSkipped: 0, concreteSkipped: 0, skipped: 'too_few_sources' }
  }

  const raw = await input.summarize(buildTraitsPrompt(sources, input.days))
  const sourceIds = new Set(sources.map((s) => s.memory_id))
  const sourceTypes = new Map(sources.map((s) => [s.memory_id, s.memory_type]))
  const maxOutput = deps.maxOutput ?? TRAITS_MAX_OUTPUT
  const candidates = parseTraitsOutput(raw, sourceIds, sourceTypes, maxOutput)
  log({ tool: 'traits', event: 'parsed', sources: sources.length, candidates: candidates.length, chars: raw.length })

  if (input.dryRun === true) {
    return {
      sources: sources.length,
      candidates: candidates.length,
      written: 0,
      skipped: 'dry_run',
      duplicates: 0,
      quotaSkipped: 0,
      concreteSkipped: 0,
      // 有候选就把内容列出来：不然干跑只回一句「5 条候选」，用户没法判断质量
      candidatePreview: candidates.map((c, i) => `${i + 1}. ${c.content}`).join('\n').slice(0, 1200),
      // 诊断用：空数组、格式没解析出来、JSON 被截断，在结果上一模一样，必须能区分
      rawPreview: raw.slice(0, 200),
      rawLength: raw.length,
      rawTail: raw.slice(-80),
    }
  }

  // 每日配额：跨多次运行累计，防止「定时跑一次 + 手动调三次」一天写十几条
  const maxPerDay = deps.maxPerDay ?? TRAITS_MAX_OUTPUT
  const usedToday = await countTraitsToday(deps)
  const quota = Math.max(0, maxPerDay - usedToday)
  if (quota === 0) {
    log({ tool: 'traits', event: 'quota_exhausted', usedToday, maxPerDay })
    return {
      sources: sources.length,
      candidates: candidates.length,
      written: 0,
      duplicates: 0,
      quotaSkipped: 0,
      concreteSkipped: 0,
      skipped: 'quota_exhausted',
      maxPerDay,
    }
  }

  let written = 0
  let blocked = 0
  let duplicates = 0
  let quotaSkipped = 0
  let concreteSkipped = 0
  for (const trait of candidates) {
    // 名额用完就停：剩下的不是「重复」，而是「今天看不过来了」
    if (written >= quota) {
      quotaSkipped += 1
      continue
    }
    // 太具体的直接丢：那是项目操作，不是做事方式
    if (isTooConcrete(trait.content)) {
      concreteSkipped += 1
      log({ tool: 'traits', event: 'skipped_concrete', preview: trait.content.slice(0, 60) })
      continue
    }
    // 先看有没有同义候选：模型每批都换句措辞，只靠精确内容哈希拦不住
    const dup = await findTraitDuplicate(deps, trait.content)
    if (dup !== null) {
      duplicates += 1
      log({
        tool: 'traits',
        event: 'skipped_duplicate',
        existing: dup.memory_id,
        score: Number(dup.score.toFixed(4)),
        anchored: dup.anchored,
        threshold: dup.threshold,
      })
      continue
    }
    const result = await writeTraitCandidate(deps, trait, input.days)
    // 409 = 同一内容哈希已存在，也归入重复（不能静默算成「写了 0 条却不说为什么」）；
    // quarantined = 内容像凭据/原样搬运，根本没落库
    if (result.written) written += 1
    else if (result.quarantined) blocked += 1
    else duplicates += 1
  }
  log({
    tool: 'traits',
    event: 'done',
    sources: sources.length,
    candidates: candidates.length,
    written,
    blocked,
    duplicates,
    quotaSkipped,
    usedToday,
    maxPerDay,
    // 本次跑完之后的待审存量：起始 + 真正落库的（被准入拦下的不算）
    pendingAfter: pendingCount + written,
    maxPending,
  })
  return {
    sources: sources.length,
    candidates: candidates.length,
    written,
    duplicates,
    quotaSkipped,
    concreteSkipped,
    blocked,
    pendingCount: pendingCount + written,
    maxPending,
    skipped: null,
    // 诊断字段**非 dry_run 也要带**（2026-11-10 审查 #15）：
    // 旧版只有干跑分支带，而线上跑的恰恰是 dry_run=false —— 于是「模型给了 0 条候选」时
    // 用户只看到 0，分不清是「真没得提炼」还是「路由没配好、模型返回了 [诊断]…」。
    // `[诊断]` 原文只在 dry_run 吐出，静默失败就是这么来的（v0.6.48 加的启动预警
    // 只看配置字符串非空，兜不住「填了但填错」这类运行期故障）。
    rawPreview: raw.slice(0, 200),
    rawLength: raw.length,
    rawTail: raw.slice(-80),
  }
}

/** 与 save.ts 一致的内容归一化哈希口径（便于两边判重口径相同） */
export function hashContent(content: string): string {
  const normalized = content
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase()
  // 简单 FNV-1a：不需要密码学强度，只要稳定且短
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function isConflict(err: unknown): boolean {
  const record = err as { status?: unknown } | null | undefined
  return record?.status === 409
}

const TRAITS_DESCRIPTION = [
  '从近期记忆里归纳「关于你自己的稳定模式」候选（identity 类型），**只写候选不生效**。',
  '默认 dry_run=true，先看产出再决定是否落库；落库的条目 status=pending，不会进检索。',
  '需要模型服务：没有可用模型时直接返回 skipped，不报错。',
].join('')

export interface TraitsToolDeps extends TraitsDeps {
  /** 由插件层注入：调宿主模型服务；返回模型原文 */
  summarize?: (prompt: string) => Promise<string>
}

/** `memory_traits` 工具：手动触发提炼。默认干跑。 */
export function defineTraitsTool(deps: TraitsToolDeps) {
  return defineTool({
    name: 'memory_traits',
    description: TRAITS_DESCRIPTION,
    parameters: {
      days: {
        type: 'number',
        description: `回看多少天的记忆（默认 14，上限 90）。素材最多取 ${TRAITS_MAX_SOURCE} 条。`,
      },
      dry_run: {
        type: 'boolean',
        description: 'true（默认）= 只返回候选内容不落库；false = 写成 status=pending 的候选。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: { type: 'number', required: true },
          candidates: { type: 'number', required: true },
          written: { type: 'number', required: true },
          duplicates: { type: 'number', required: true },
          quotaSkipped: { type: 'number', required: true },
          concreteSkipped: { type: 'number', required: true },
          // 命中写入准入而未落库的条数（2026-11-02 新增；schema 是 additionalProperties:false，
          // 漏声明就会让 memory_traits 真跑时整条输出被判非法 —— 与 asOf 那个 bug 同型）
          blocked: { type: 'number' },
          // 只在「配额用完」时返回：output schema 是 additionalProperties:false，
          // 漏声明一个字段整个工具就报错（2026-11-01 实测）
          maxPerDay: { type: 'number' },
          skipped: { type: 'string', required: true },
          // 诊断三件套：schema 是 additionalProperties:false，漏一个字段工具就整体报错
          candidatePreview: { type: 'string' },
          rawPreview: { type: 'string' },
          rawLength: { type: 'number' },
          rawTail: { type: 'string' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 一次检索 + 一次模型调用（模型慢，给足）+ 最多 8 次写
    timeoutMs: 120_000,
    async execute(input) {
      const days = clampDays(input.days)
      const dryRun = input.dry_run !== false
      const summarize = deps.summarize
      if (summarize === undefined) {
        return { sources: 0, candidates: 0, written: 0, duplicates: 0, quotaSkipped: 0, concreteSkipped: 0, skipped: 'no_llm_service', text: '没有可用的模型服务，本次没有提炼（记忆库本身不受影响）。' }
      }
      const result = await runTraitsJob(deps, { days, summarize, dryRun })
      return { ...result, skipped: result.skipped ?? '', text: renderTraitsText(result, days, dryRun) }
    },
  })
}

function clampDays(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 14
  return Math.max(1, Math.min(90, n))
}

function renderTraitsText(result: TraitsResult, days: number, dryRun: boolean): string {
  if (result.skipped === 'too_few_sources') {
    return `最近 ${days} 天只有 ${result.sources} 条记忆，不足两条，无法归纳。`
  }
  if (result.skipped === 'dry_run') {
    const base = `最近 ${days} 天共 ${result.sources} 条记忆，模型给出 ${result.candidates} 条候选（干跑，未落库）。要落库请用 dry_run=false。`
    if (result.candidates > 0 && result.candidatePreview !== undefined) {
      return `${base}\n\n${result.candidatePreview}`
    }
    // 0 条时把模型原话带出来：空数组（真的看不出）与格式没解析（模型说了但没解析出来）必须能区分
    if (result.candidates === 0 && result.rawPreview !== undefined) {
      const tail = result.rawTail === undefined ? '' : `\n结尾（判断是否被截断）：\n${result.rawTail}`
      return `${base}\n\n模型原始输出（共 ${result.rawLength ?? 0} 字符，前 200）：\n${result.rawPreview === '' ? '(空)' : result.rawPreview}${tail}`
    }
    return base
  }
  if (result.skipped === 'pending_full') {
    return `待审的自述候选已有 ${result.pendingCount ?? '?'} 条，达到上限 ${result.maxPending ?? 20} 条，本次不再提炼（不继续增长）。\n先在「自述」页签审掉几条，低于上限后会自动恢复；想放宽就调 traits.maxPending。`
  }
  if (result.skipped === 'quota_exhausted') {
    return `最近 ${days} 天共 ${result.sources} 条记忆，模型给出 ${result.candidates} 条候选，但今天的名额已用完（每天上限 ${result.maxPerDay ?? '?'} 条），本次一条都没写。\n想立刻写就先审掉今天的候选，或者把 traits.maxPerDay 调大。`
  }
  const dupNote = result.duplicates > 0 ? `，跳过 ${result.duplicates} 条与已有自述同义` : ''
  const quotaNote = result.quotaSkipped > 0
    ? `，另有 ${result.quotaSkipped} 条因为今天名额已满没写（明天再提）`
    : ''
  const concreteNote = result.concreteSkipped > 0
    ? `，丢弃 ${result.concreteSkipped} 条写得太具体的（含命令/路径/字段名，那属于项目操作不是做事方式）`
    : ''
  const pendingNote = result.pendingCount !== undefined && result.maxPending !== undefined
    ? `；当前待审 ${result.pendingCount}/${result.maxPending} 条`
    : ''
  // 0 候选时把模型原话带出来（2026-11-10 审查 #15）：这条以前只在 dry_run 分支里有，
  // 而线上跑的是 dry_run=false —— 「写了 0 条」与「模型/路由出了问题」在返回上一模一样。
  // `[诊断] 选不到模型路由…` 这类原文必须能被看到，否则只能靠猜。
  const diag = result.candidates === 0 && result.rawPreview !== undefined
    ? `\n\n模型原始输出（共 ${result.rawLength ?? 0} 字符，前 200；用来区分「真没得提炼」与「模型/路由出了问题」）：`
      + `\n${result.rawPreview === '' ? '(空)' : result.rawPreview}`
      + (result.rawTail === undefined ? '' : `\n结尾（判断是否被截断）：\n${result.rawTail}`)
    : ''
  return `最近 ${days} 天共 ${result.sources} 条记忆，模型给出 ${result.candidates} 条候选，新写入 ${result.written} 条（status=pending，未生效）${dupNote}${concreteNote}${quotaNote}${pendingNote}。${diag}`
}
