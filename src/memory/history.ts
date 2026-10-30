/**
 * 阶段 7.4：版本链与回滚。
 *
 * 现有的取代关系是**双向**的：旧版 `superseded_by` 指向新版，新版 `supersedes` 指回旧版
 * （`status.ts` 里 `supersede` 会两边都写，否则链不完整）。这里只做两件事：
 *  · 把一个 id 前后走完整条链，给人和模型看"这条自述被改过几次"；
 *  · 回滚到链上某一版。
 *
 * 回滚的语义刻意**不是删除**：新版置 `archived`（"被撤回的版本"），旧版置回 `active`。
 * 谁都不想有一天要问"上一版写了什么"，而它已经被删了。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { personalIndexFor } from './common.ts'

/** 一条链最多走这么多跳（防脏数据成环） */
export const CHAIN_MAX_HOPS = 10

export interface ChainVersion {
  memory_id: string
  status: string
  content: string
  memory_type: string
  created_at: string | null
  /** 相对起点：-N = 更旧，0 = 起点，+N = 更新 */
  offset: number
}

export interface HistoryDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'search' | 'get'>
  writer: Pick<EsClient, 'update'>
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}

export interface RollbackOutcome {
  memory_id: string
  changed: boolean
  restored: string
  retired: string
  note: string
}

async function readDoc(deps: HistoryDeps, id: string): Promise<Record<string, unknown> | null> {
  try {
    const doc = await deps.reader.get(personalIndexFor(deps.personalPrefix, deps.userId), id)
    return (doc.source ?? {}) as Record<string, unknown>
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) return null
    throw err
  }
}

function toVersion(source: Record<string, unknown>, offset: number): ChainVersion {
  return {
    memory_id: typeof source.memory_id === 'string' ? source.memory_id : '',
    status: typeof source.status === 'string' ? source.status : '',
    content: typeof source.content === 'string' ? source.content : '',
    memory_type: typeof source.memory_type === 'string' ? source.memory_type : '',
    created_at: typeof source.created_at === 'string' ? source.created_at : null,
    offset,
  }
}

/**
 * 走完整条链。起点不存在时返回空数组（调用方给提示，不抛错）。
 *
 * 不去重环：用 hop 上限兜住，比"检测环"更简单且够用——脏数据只可能来自手工改库。
 */
export async function collectChain(deps: HistoryDeps, memoryId: string): Promise<ChainVersion[]> {
  const start = await readDoc(deps, memoryId)
  if (start === null) return []

  const forward: ChainVersion[] = [toVersion(start, 0)]
  const seen = new Set([memoryId])

  // 向旧走：沿 supersedes
  let cursor = start
  for (let hop = 0; hop < CHAIN_MAX_HOPS; hop += 1) {
    const prevId = typeof cursor.supersedes === 'string' ? cursor.supersedes : ''
    if (prevId === '' || seen.has(prevId)) break
    const prev = await readDoc(deps, prevId)
    if (prev === null) break
    seen.add(prevId)
    forward.unshift(toVersion(prev, -(hop + 1)))
    cursor = prev
  }

  // 向新走：沿 superseded_by
  cursor = start
  for (let hop = 0; hop < CHAIN_MAX_HOPS; hop += 1) {
    const nextId = typeof cursor.superseded_by === 'string' ? cursor.superseded_by : ''
    if (nextId === '' || seen.has(nextId)) break
    const next = await readDoc(deps, nextId)
    if (next === null) break
    seen.add(nextId)
    forward.push(toVersion(next, hop + 1))
    cursor = next
  }

  return forward
}

/**
 * 把 `targetId` 恢复成生效版本，并把它链上的后继置 `archived`。
 *
 * 拒绝的条件写清楚：只有 `superseded` 状态能回滚（`active` 已经是生效版本、`archived`
 * 是撤回过的，回滚它们没有意义）。
 */
export async function rollbackTo(deps: HistoryDeps, targetId: string): Promise<RollbackOutcome> {
  const log = deps.log ?? (() => {})
  const now = deps.now?.() ?? new Date()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)

  const target = await readDoc(deps, targetId)
  if (target === null) {
    return { memory_id: targetId, changed: false, restored: '', retired: '', note: `找不到条目 ${targetId}。` }
  }
  const status = typeof target.status === 'string' ? target.status : ''
  if (status !== 'superseded') {
    return {
      memory_id: targetId, changed: false, restored: '', retired: '',
      note: `这条当前状态是 ${status}（只有 superseded 的旧版本能回滚）。`,
    }
  }

  const successorId = typeof target.superseded_by === 'string' ? target.superseded_by : ''

  // 先撤后继、再恢复旧版：反过来的话中间态会出现"两个 active"的瞬间
  if (successorId !== '') {
    await deps.writer.update(
      index,
      successorId,
      { status: 'archived', updated_at: now.toISOString() },
      { refresh: 'wait_for' },
    )
  }
  await deps.writer.update(
    index,
    targetId,
    { status: 'active', superseded_by: null, updated_at: now.toISOString() },
    { refresh: 'wait_for' },
  )

  log({ tool: 'history', event: 'rollback', restored: targetId, retired: successorId })
  return {
    memory_id: targetId,
    changed: true,
    restored: targetId,
    retired: successorId,
    note: successorId === ''
      ? '已恢复为生效版本（这条没有后继版本）。'
      : `已恢复到 ${targetId}，原生效版本 ${successorId} 置 archived（内容保留，可再查历史）。`,
  }
}

const HISTORY_DESCRIPTION = [
  '看一条记忆的版本链（前后各走几跳），或回滚到其中某一版。',
  '回滚不会删除：新版置 archived，旧版恢复 active，历史随时能再查。',
].join('')

export const HISTORY_ACTION_VALUES = ['versions', 'rollback'] as const

export function defineHistoryTool(deps: HistoryDeps) {
  return defineTool({
    name: 'memory_history',
    description: HISTORY_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: [...HISTORY_ACTION_VALUES],
        required: true,
        description: 'versions = 看版本链；rollback = 回滚到 target_id 那一版。',
      },
      memory_id: { type: 'string', required: true, description: '任意一版的 memory_id（链上一点即可）。' },
      target_id: { type: 'string', description: 'rollback 时必填：要恢复成生效版本的那一版。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          count: { type: 'number', required: true },
          changed: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 20_000,
    async execute(input) {
      const action = String(input.action ?? 'versions')
      const memoryId = String(input.memory_id ?? '').trim()
      if (memoryId === '') throw new Error('memory_history: 需要 memory_id')

      if (action === 'rollback') {
        const targetId = String(input.target_id ?? '').trim()
        if (targetId === '') throw new Error('memory_history: rollback 需要 target_id')
        const out = await rollbackTo(deps, targetId)
        return { action, count: 1, changed: out.changed, text: out.note }
      }

      const chain = await collectChain(deps, memoryId)
      return { action, count: chain.length, changed: false, text: renderChain(chain) }
    },
  })
}

function renderChain(chain: readonly ChainVersion[]): string {
  if (chain.length === 0) return '找不到这条记忆。'
  if (chain.length === 1) return `这条没有版本历史（只有当前一版，状态 ${chain[0]?.status}）。`
  const lines = [`共 ${chain.length} 个版本（旧 → 新）：`, '']
  for (const v of chain) {
    const mark = v.offset === 0 ? ' ← 起点' : ''
    const when = v.created_at === null ? '' : ` ${v.created_at.slice(0, 10)}`
    lines.push(`- ${v.memory_id} [${v.status}]${when}${mark}`)
    lines.push(`  ${v.content.length > 120 ? `${v.content.slice(0, 120)}…` : v.content}`)
  }
  lines.push('', '要回到某一版：action=rollback 加 target_id。')
  return lines.join('\n')
}
