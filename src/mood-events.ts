/**
 * 阶段 6.4：把宿主事件翻译成情绪事件（纯函数，无 IO）。
 *
 * 边界：
 *  · 这里**只做判定**，不写状态、不碰 ES——事件量很大，判定必须便宜、可单测。
 *  · 判定用关键词而不是模型：调一次模型为了一条"谢谢"不划算，而且模型判「用户是不是在夸」
 *    本身就不稳定。规则的代价是漏判，但漏判比误判安全。
 *  · **不保存用户原文**：`note` 只记命中的类别与关键词，避免把对话抄进状态文档。
 */

import type { MoodEventKind } from './mood.ts'

/** 同一条消息最多产生一次情绪事件；同一 agent 两次事件的最小间隔 */
export const MOOD_EVENT_MIN_INTERVAL_MS = 30_000

export interface MoodSignal {
  kind: MoodEventKind
  /** 给状态事件留痕用的短说明（不含用户原文） */
  note: string
}

/** 褒义线索：按"明确 → 弱"排列，命中即停 */
const PRAISE_PATTERNS: ReadonlyArray<{ re: RegExp; note: string }> = [
  { re: /太棒了|完美|干得漂亮|正是我要的|就是它/, note: '明确夸奖' },
  { re: /谢谢|感谢|辛苦|靠谱|厉害|牛啊|牛！|nice|thanks|thank you|good job/i, note: '致谢或认可' },
  { re: /很好|不错|可以|满意|赞|挺好|对头/, note: '轻度认可' },
]

/**
 * 贬义线索。
 *
 * ⚠️ 否定前缀要单独处理：`不错` 含 `不` 但意思是褒。所以先匹配褒义词里那些
 * 以"不"开头的（`不错`），再匹配贬义；顺序反过来会把 `不错` 判成批评。
 */
const CRITICISM_PATTERNS: ReadonlyArray<{ re: RegExp; note: string }> = [
  { re: /完全不对|全错|搞错|又错|还是错|不是这个|说了多少遍|太差/, note: '明确批评' },
  { re: /不对|错了|不行|别这样|不要这样|烦|讨厌|垃圾|蠢|stupid|wrong|nope/i, note: '否定或不满' },
  { re: /不太行|有点问题|不太对|怪怪的/, note: '轻度不满' },
]

/**
 * 从宿主消息里取纯文本。
 *
 * 用鸭子类型而不是 import 宿主的 `UserMessage`：插件对宿主内部类型面依赖越少越好，
 * 且这里只需要 `content` 里 type === 'text' 的片段。
 */
export function extractUserText(message: unknown): string {
  if (typeof message === 'string') return message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/**
 * 判定一条用户消息该产生什么情绪事件。中性消息返回 null（绝大多数情况）。
 *
 * 判定顺序：先褒（含「不错」这种带否定字的褒义），再贬。都不中就是 null。
 */
export function classifyUserMessage(text: string): MoodSignal | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  for (const { re, note } of PRAISE_PATTERNS) {
    if (re.test(trimmed)) return { kind: 'praise', note }
  }
  for (const { re, note } of CRITICISM_PATTERNS) {
    if (re.test(trimmed)) return { kind: 'criticism', note }
  }
  return null
}

/**
 * 事件节流：同一 key 在 `minIntervalMs` 内只放行一次。
 *
 * 为什么需要：一次对话里"谢谢""好的"会连着出现，不节流的话 10 秒就能把 valence 拉满，
 * 情绪变成噪声。用注入的时钟而不是 Date.now()，测试才能确定。
 */
export class MoodEventThrottle {
  private readonly lastAt = new Map<string, number>()
  private readonly minIntervalMs: number

  // 不用参数属性：Node 的 strip-only TS 模式不支持 `constructor(private x)`。
  constructor(minIntervalMs: number = MOOD_EVENT_MIN_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs
  }

  /** 放行则记录时间并返回 true */
  allow(key: string, now: number): boolean {
    const last = this.lastAt.get(key)
    if (last !== undefined && now - last < this.minIntervalMs) return false
    this.lastAt.set(key, now)
    return true
  }

  /** 测试与卸载时清理 */
  clear(): void {
    this.lastAt.clear()
  }
}
