/**
 * `memory_update_status` —— 改记忆的状态，不物理删除（§3.4 模式 A / D4）。
 *
 * 三个动作：
 *  · `supersede`：旧文档置 `status=superseded` + `superseded_by`，**并回填新文档的 `supersedes`**
 *    （§3.4 要求「新文档 supersedes = 旧 memory_id」，不双写就没有可追溯的链）；
 *  · `expire`：置 `status=expired`；
 *  · `mark_private`：置 `privacy=private`（不参与整理任务）。
 *
 * 写顺序是有讲究的：**先置旧文档 superseded，再回填新文档的 supersedes**。
 * 反过来若第二步失败，检索会同时返回新旧两版（错的结果）；这个顺序失败时只是「链缺一格」，
 * 检索仍然正确，事后可补。ES 没有事务，只能挑错得轻的那个。
 *
 * @module dsh-memory-es/memory/status
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MemoryStoreDeps } from './common.ts'
import { loadOwnedDoc, nowIso, personalIndexFor } from './common.ts'

export const STATUS_ACTIONS = ['supersede', 'expire', 'mark_private'] as const
export type StatusAction = (typeof STATUS_ACTIONS)[number]

export const MEMORY_STATUSES = ['active', 'superseded', 'expired'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export interface UpdateStatusInput {
  memory_id: string
  action: StatusAction
  reason?: string
  /** supersede 时必填：指向新版本 */
  replacement_memory_id?: string
}

export interface UpdateStatusResult {
  memory_id: string
  action: StatusAction
  /** 变更后的状态（mark_private 时是原状态） */
  status: string
  privacy: string
  superseded_by: string
  /** false = ES 返回 noop（字段本来就是目标值） */
  changed: boolean
  text: string
}

export interface UpdateStatusDeps extends MemoryStoreDeps {
  now?: () => Date
}

function describe(action: StatusAction, status: string, replacement: string): string {
  if (action === 'supersede') {
    return replacement === ''
      ? `已标记为 superseded（未指定替代版本，链上留空）`
      : `已标记为 superseded，替代版本 ${replacement}`
  }
  if (action === 'expire') return '已标记为 expired（不再参与检索，但历史仍在）'
  return `已标记为 private（不参与整理任务），状态仍为 ${status}`
}

/**
 * 编排。所有写都走 writer 凭证；读走 reader。
 * 失败一律抛（不吞）：改状态失败却回报成功，会让模型以为旧记忆已经下架。
 */
export async function updateStatus(
  deps: UpdateStatusDeps,
  input: UpdateStatusInput,
): Promise<UpdateStatusResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const action = input.action
  if (!STATUS_ACTIONS.includes(action)) {
    throw new Error(`memory_update_status: 未知 action「${String(action)}」（只支持 ${STATUS_ACTIONS.join(' / ')}）`)
  }
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const now = nowIso(deps.now?.() ?? new Date())

  const current = await loadOwnedDoc(deps, input.memory_id)
  const replacementId = (input.replacement_memory_id ?? '').trim()

  if (action === 'supersede') {
    if (replacementId === '') {
      throw new Error('memory_update_status: action=supersede 必须给 replacement_memory_id（指向新版本）')
    }
    if (replacementId === current.id) {
      throw new Error('memory_update_status: replacement_memory_id 不能是自己')
    }
    // 先确认替代版本真实存在（否则会留下指向空气的链）
    await loadOwnedDoc(deps, replacementId)

    // ① 旧文档下架：先做这一步，保证检索立刻正确
    const oldWrite = await deps.writer.update(
      index,
      current.id,
      { status: 'superseded', superseded_by: replacementId, updated_at: now },
      { refresh: 'wait_for' },
    )
    // ② 新文档回填 supersedes（可追溯的那一格）
    await deps.writer.update(index, replacementId, { supersedes: current.id, updated_at: now }, { refresh: 'wait_for' })

    log({
      tool: 'status',
      user: deps.userId,
      memory_id: current.id,
      action,
      replacement: replacementId,
      reason: input.reason ?? '',
      ms: Date.now() - startedAt,
      changed: oldWrite.result !== 'noop',
    })
    return {
      memory_id: current.id,
      action,
      status: 'superseded',
      privacy: typeof current.source.privacy === 'string' ? current.source.privacy : 'normal',
      superseded_by: replacementId,
      changed: oldWrite.result !== 'noop',
      text: describe(action, 'superseded', replacementId),
    }
  }

  const patch: Record<string, unknown> =
    action === 'expire' ? { status: 'expired', updated_at: now } : { privacy: 'private', updated_at: now }
  const written = await deps.writer.update(index, current.id, patch, { refresh: 'wait_for' })

  const status = action === 'expire' ? 'expired' : (typeof current.source.status === 'string' ? current.source.status : 'active')
  const privacy = action === 'mark_private' ? 'private' : (typeof current.source.privacy === 'string' ? current.source.privacy : 'normal')

  log({
    tool: 'status',
    user: deps.userId,
    memory_id: current.id,
    action,
    reason: input.reason ?? '',
    ms: Date.now() - startedAt,
    changed: written.result !== 'noop',
  })

  return {
    memory_id: current.id,
    action,
    status,
    privacy,
    superseded_by: '',
    changed: written.result !== 'noop',
    text: describe(action, status, ''),
  }
}

const DESCRIPTION = [
  '把一条记忆标成「过时」或「私有」，不物理删除（历史仍可审计，检索只取 active）。',
  'supersede：被新版本取代，必须给 replacement_memory_id，会在新旧两条之间双向连线。',
  'expire：直接作废。mark_private：涉及隐私、不再参与整理任务（状态不变）。',
  '什么时候用：记忆过时了、被新决定覆盖了、或用户说「这条别用了」。不要靠重复写同内容来覆盖。',
].join(' ')

export function defineStatusTool(deps: UpdateStatusDeps) {
  return defineTool({
    name: 'memory_update_status',
    description: DESCRIPTION,
    parameters: {
      memory_id: {
        type: 'string',
        required: true,
        description: '目标记忆的 memory_id（检索结果里就是它）。',
      },
      action: {
        type: 'string',
        required: true,
        enum: [...STATUS_ACTIONS],
        description: 'supersede=被新版本取代；expire=过期；mark_private=标记私有（不参与整理）。',
      },
      replacement_memory_id: {
        type: 'string',
        description: 'action=supersede 时必填：新版本那条记忆的 memory_id。',
      },
      reason: {
        type: 'string',
        description: '为什么改（审计用，只进日志，不写入文档）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          action: { type: 'string', required: true },
          status: { type: 'string', required: true },
          privacy: { type: 'string', required: true },
          superseded_by: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      return await updateStatus(deps, args)
    },
  })
}
