/**
 * 阶段 6.2：情绪状态的存取（ES）。
 *
 * 为什么复用 `personal_memory_<uid>` 而不是新开索引：
 *  · 新索引要改 `init-user.sh` 的角色名列表（精确授权，不是通配）并重跑用户初始化，
 *    为了一个 key-value 去动 ACL 不划算；
 *  · 检索一律带 `status: active` 过滤，所以 `status: 'mood'` 的文档**永远不会**出现在
 *    `memory_search` 结果里，不会污染召回；
 *  · 固定 id `__mood__`，一个用户至多一份，读写都是 O(1)。
 *
 * 代价：`_count(match_all)` 之类的统计会多一条，文档里必须写明，别让以后的清理脚本误删。
 */

import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { personalIndexFor } from './common.ts'
import { NEUTRAL_MOOD, readMoodState, type MoodState } from '../mood.ts'

/** 状态文档的固定 id：一个用户至多一份 */
export const MOOD_DOC_ID = '__mood__'

/** 状态文档的 `status` 值：与 `active` 区分开，检索过滤天然排除 */
export const MOOD_STATUS = 'mood'

export interface MoodStoreDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'get'>
  writer: Pick<EsClient, 'index'>
  log?: (event: Record<string, unknown>) => void
}

function indexOf(deps: MoodStoreDeps): string {
  return personalIndexFor(deps.personalPrefix, deps.userId)
}

/**
 * 读当前状态。文档不存在（第一次用）返回中性态，不抛错。
 * 其它错误照常抛：读不到状态时宁可让调用方知道，也不要用错误的中性态悄悄覆盖真实情绪。
 */
export async function readMood(deps: MoodStoreDeps, signal?: AbortSignal): Promise<MoodState> {
  try {
    const doc = await deps.reader.get(indexOf(deps), MOOD_DOC_ID, { signal })
    return readMoodState(doc.source)
  } catch (err) {
    if (isNotFound(err)) return { ...NEUTRAL_MOOD }
    throw err
  }
}

/** 写回状态（upsert，`refresh: wait_for` 保证下一次读立刻可见） */
export async function writeMood(deps: MoodStoreDeps, state: MoodState, signal?: AbortSignal): Promise<void> {
  const now = state.updatedAt ?? new Date().toISOString()
  const doc: Record<string, unknown> = {
    memory_id: MOOD_DOC_ID,
    user_id: deps.userId,
    // content 是模板必填的 text 字段；状态文档不该进检索，给个固定占位
    content: '情绪状态（内部文档，不参与检索）',
    memory_type: 'context',
    domain: 'system',
    privacy: 'private',
    importance: 'low',
    status: MOOD_STATUS,
    promote_state: 'none',
    distill_state: 'done',
    created_at: now,
    updated_at: now,
    mood_valence: state.valence,
    mood_arousal: state.arousal,
    mood_updated_at: state.updatedAt ?? now,
    mood_events: state.events,
  }
  try {
    await deps.writer.index(indexOf(deps), doc, { id: MOOD_DOC_ID, refresh: 'wait_for', signal })
  } catch (err) {
    deps.log?.({ tool: 'mood', user: deps.userId, event: 'write_failed', error: formatEsError(err) })
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  const record = err as { status?: unknown; kind?: unknown } | null | undefined
  if (record === null || record === undefined) return false
  return record.status === 404 || record.kind === 'not_found'
}
