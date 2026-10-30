/**
 * 阶段 6.2：情绪状态（纯函数，无 IO）。
 *
 * 设计取舍：
 *  · **状态由事件合成，不由模型自述**。模型会为了迎合而永远"开心"，
 *    所以 `applyEvent` 只接受外部事件（用户明确夸奖/批评、工具失败/成功），
 *    模型说"我很高兴"不产生任何副作用。
 *  · **可回放**：保留最近 `MOOD_MAX_EVENTS` 条事件，状态错了能看出是哪一条推的。
 *  · **会衰退**：情绪是短期量，按半衰期回落到 0（中性）。不做永久累积。
 *
 * 存储字段一律带 `mood_` 前缀（`mood_valence` / `mood_arousal` / `mood_updated_at` / `mood_events`），
 * 避免将来「记忆自带的情绪色彩」用 `valence` 时与状态混在一个名字上。
 */

/** 能推动情绪的事件类型 */
export const MOOD_EVENT_KINDS = ['praise', 'criticism', 'tool_error', 'tool_ok'] as const
export type MoodEventKind = (typeof MOOD_EVENT_KINDS)[number]

/** 每类事件对 valence 的推力。刻意小：单条消息不该把情绪拽到底或拉到顶 */
export const MOOD_DELTAS: Readonly<Record<MoodEventKind, number>> = {
  praise: 0.15,
  criticism: -0.2,
  tool_error: -0.1,
  tool_ok: 0.03,
}

/** 情绪半衰期（小时）：3 小时后偏离量减半 */
export const MOOD_HALF_LIFE_HOURS = 3

/** 保留的事件条数上界（可回放，但不无限增长） */
export const MOOD_MAX_EVENTS = 20

/**
 * 低于这个偏离量就不注入提示词（平静时不打扰模型）。
 *
 * 取值必须**明显小于**单次 `praise`（0.15）：曾经设成 0.15，结果一次夸奖刚好等于阈值、
 * 衰减几秒后就差一点点，永远不注入（2026-10-30 实测踩到）。0.12 保证：
 * 单次夸奖/批评会外露，单次工具失败（0.10）不外露。
 */
export const MOOD_SILENT_THRESHOLD = 0.12

export interface MoodEvent {
  kind: MoodEventKind
  /** ISO 时间 */
  at: string
  /** 该事件施加的 delta（已 clamp 前的原始值，便于回放核对） */
  delta: number
  /** 触发来源的短说明（不含用户原文，避免把对话抄进状态文件） */
  note?: string
}

export interface MoodState {
  /** -1（低落）.. 1（愉快），0 = 中性 */
  valence: number
  /** 0..1 唤醒度：情绪有多"动" */
  arousal: number
  /** 最近一次更新的时间（ISO）；null = 从未有过事件 */
  updatedAt: string | null
  /** 最近的事件（新→旧） */
  events: MoodEvent[]
}

export const NEUTRAL_MOOD: MoodState = { valence: 0, arousal: 0, updatedAt: null, events: [] }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * 指数衰减：`value × 0.5^(ageHours / halfLife)`。
 *
 * 为什么是指数而不是幂律：情绪是短期量，指数在"隔一顿饭就淡了"这个尺度上更贴近直觉；
 * 幂律适合长期记忆的激活强度（那是 5.5 的事，已跳过）。
 */
export function decayMood(value: number, ageHours: number, halfLife = MOOD_HALF_LIFE_HOURS): number {
  if (!Number.isFinite(value)) return 0
  if (!Number.isFinite(ageHours) || ageHours <= 0) return value
  if (!Number.isFinite(halfLife) || halfLife <= 0) return value
  return value * Math.pow(0.5, ageHours / halfLife)
}

/** 把状态按当前时间衰减（不改 updatedAt 以外的语义） */
export function decayState(state: MoodState, now: Date): MoodState {
  if (state.updatedAt === null) return { ...state }
  const updated = Date.parse(state.updatedAt)
  if (!Number.isFinite(updated)) return { ...state }
  const ageHours = (now.getTime() - updated) / 3_600_000
  if (ageHours <= 0) return { ...state }
  return {
    ...state,
    valence: round4(decayMood(state.valence, ageHours)),
    arousal: round4(decayMood(state.arousal, ageHours)),
    updatedAt: now.toISOString(),
  }
}

/**
 * 施加一次事件：先按时间衰减，再加 delta，clamp 回区间。
 *
 * arousal 的推力取 `|delta|` 的一半——大幅情绪波动本身就意味着"被激活"。
 */
export function applyMoodEvent(
  state: MoodState,
  kind: MoodEventKind,
  at: Date,
  note?: string,
): MoodState {
  const delta = MOOD_DELTAS[kind]
  if (delta === undefined) throw new Error(`未知的情绪事件类型：${String(kind)}`)
  const base = decayState(state, at)
  const valence = clamp(base.valence + delta, -1, 1)
  const arousal = clamp(base.arousal + Math.abs(delta) * 0.5, 0, 1)
  const event: MoodEvent = { kind, at: at.toISOString(), delta, ...(note === undefined ? {} : { note }) }
  return {
    valence: round4(valence),
    arousal: round4(arousal),
    updatedAt: at.toISOString(),
    events: [event, ...base.events].slice(0, MOOD_MAX_EVENTS),
  }
}

/** 当前效价对应的离散标签（给提示词用） */
export function moodLabel(valence: number): string {
  if (valence >= 0.5) return '愉快'
  if (valence >= MOOD_SILENT_THRESHOLD) return '不错'
  if (valence <= -0.5) return '低落'
  if (valence <= -MOOD_SILENT_THRESHOLD) return '有点闷'
  return '平静'
}

/**
 * 渲染给提示词的一行。平静时返回空串（不注入，不打扰）。
 *
 * 刻意写得短、不带数字：模型知道"有点闷"就够了，不需要知道 valence=0.37。
 */
export function renderMoodLine(state: MoodState, now: Date): string {
  const decayed = decayState(state, now)
  if (Math.abs(decayed.valence) < MOOD_SILENT_THRESHOLD) return ''
  const label = moodLabel(decayed.valence)
  const hint =
    decayed.valence > 0 ? '可以稍微外露一点，但别夸张' : '语气收一点，先给结论、少开玩笑'
  return `（此刻的心情：${label}。${hint}。）`
}

/** 从 ES 文档字段还原状态（容忍缺失与脏值） */
export function readMoodState(source: Record<string, unknown>): MoodState {
  const valence = typeof source.mood_valence === 'number' && Number.isFinite(source.mood_valence) ? source.mood_valence : 0
  const arousal = typeof source.mood_arousal === 'number' && Number.isFinite(source.mood_arousal) ? source.mood_arousal : 0
  const updatedAt = typeof source.mood_updated_at === 'string' ? source.mood_updated_at : null
  const rawEvents = Array.isArray(source.mood_events) ? source.mood_events : []
  const events: MoodEvent[] = []
  for (const item of rawEvents) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const kind = record.kind
    if (typeof kind !== 'string' || !(MOOD_EVENT_KINDS as readonly string[]).includes(kind)) continue
    const at = typeof record.at === 'string' ? record.at : null
    if (at === null) continue
    events.push({
      kind: kind as MoodEventKind,
      at,
      delta: typeof record.delta === 'number' && Number.isFinite(record.delta) ? record.delta : MOOD_DELTAS[kind as MoodEventKind],
      ...(typeof record.note === 'string' ? { note: record.note } : {}),
    })
  }
  return {
    valence: round4(clamp(valence, -1, 1)),
    arousal: round4(clamp(arousal, 0, 1)),
    updatedAt,
    events: events.slice(0, MOOD_MAX_EVENTS),
  }
}
