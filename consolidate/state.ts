/**
 * 整理任务的游标 / 幂等状态（文档 §9.6）。
 *
 * 存成一个 JSON 文件（默认 `<repo>/.state/consolidate.json`，已 gitignore）：
 *  · `lastRunAt`：上次跑完的时间，供 §9.1 的「距上次 ≥ 7 天」触发用；
 *  · `processed`：memory_id → 处理结果，重跑时用来跳过（幂等）；
 *  · `pending`：进人工队列的条目（S8 只记录，不落团队库——见 dedupe.ts 的说明）。
 *
 * 写文件用「临时文件 + rename」：整理任务可能被 kill，半截 JSON 会让下一轮直接崩。
 *
 * @module dsh-memory-es/consolidate/state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ProcessedEntry {
  at: string
  verdict: 'promoted' | 'duplicate' | 'merge_candidate' | 'blocked' | 'pending' | 'personal_only'
  teamDocId?: string
  reason: string
}

export interface PendingEntry {
  memory_id: string
  at: string
  reason: string
  neighborId?: string
}

export interface ConsolidateState {
  version: 1
  lastRunAt: string | null
  processed: Record<string, ProcessedEntry>
  pending: PendingEntry[]
}

export function emptyState(): ConsolidateState {
  return { version: 1, lastRunAt: null, processed: {}, pending: [] }
}

/** 读状态；文件不存在或内容坏了都退化成空状态（不能让状态文件阻断整理） */
export function loadState(path: string): ConsolidateState {
  if (!existsSync(path)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConsolidateState>
    return {
      version: 1,
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
      processed: parsed.processed ?? {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    }
  } catch {
    return emptyState()
  }
}

/** 原子写：先写 .tmp 再 rename，避免半截文件 */
export function saveState(path: string, state: ConsolidateState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** 纯函数：记录一条处理结果（返回新状态，不改入参） */
export function withProcessed(state: ConsolidateState, memoryId: string, entry: ProcessedEntry): ConsolidateState {
  return { ...state, processed: { ...state.processed, [memoryId]: entry } }
}

/** 纯函数：记录一条待人工裁决（同 memory_id 只留最新一条） */
export function withPending(state: ConsolidateState, entry: PendingEntry): ConsolidateState {
  const rest = state.pending.filter((item) => item.memory_id !== entry.memory_id)
  return { ...state, pending: [...rest, entry] }
}

/** 距上次整理多少天（从未跑过返回 null） */
export function daysSinceLastRun(state: ConsolidateState, now = new Date()): number | null {
  if (state.lastRunAt === null) return null
  const last = Date.parse(state.lastRunAt)
  if (Number.isNaN(last)) return null
  return (now.getTime() - last) / 86_400_000
}

/** 这批候选里是否已经处理过（幂等：处理过的默认跳过） */
export function alreadyProcessed(state: ConsolidateState, memoryId: string): boolean {
  return Object.hasOwn(state.processed, memoryId)
}
