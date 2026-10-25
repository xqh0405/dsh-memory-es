/**
 * `memory_promote` —— 把一条个人记忆标成「值得进团队库」的候选。
 *
 * **只置 `promote_state=candidate`，绝不直写团队库**（§6.3）。真正的晋升由整理任务
 * 做（§9：去重/冲突/敏感扫描都在那条链上），这里只是闸门——为了“方便”改成直写，
 * 团队库两周就会被噪声淹掉。
 *
 * `reason` 只进日志/审计：mapping 是 `dynamic: strict` 且没有 promote_reason 字段，
 * 硬写会 400。要落库得先改 mapping（属于部署动作，不在本步范围）。
 *
 * @module dsh-memory-es/memory/promote
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MemoryStoreDeps } from './common.ts'
import { loadOwnedDoc, nowIso, personalIndexFor } from './common.ts'

export const PROMOTE_STATES = ['none', 'candidate', 'promoted', 'rejected', 'blocked'] as const
export type PromoteState = (typeof PROMOTE_STATES)[number]

export interface PromoteInput {
  memory_id: string
  reason?: string
}

export interface PromoteResult {
  memory_id: string
  /** 变更后的 promote_state（正常是 candidate） */
  promote_state: string
  changed: boolean
  text: string
}

export interface PromoteDeps extends MemoryStoreDeps {
  now?: () => Date
}

/** 编排：读（reader）→ 校验归属 → 置 candidate（writer）。失败一律抛。 */
export async function promoteMemory(deps: PromoteDeps, input: PromoteInput): Promise<PromoteResult> {
  const startedAt = Date.now()
  const log = deps.log ?? (() => {})
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const current = await loadOwnedDoc(deps, input.memory_id)

  const already = current.source.promote_state
  if (already === 'promoted') {
    // 已经在团队库里了，再标 candidate 会让整理任务重复处理
    log({ tool: 'promote', user: deps.userId, memory_id: current.id, skipped: 'already_promoted' })
    return {
      memory_id: current.id,
      promote_state: 'promoted',
      changed: false,
      text: '这条已经晋升过（promote_state=promoted），无需再标',
    }
  }

  const written = await deps.writer.update(
    index,
    current.id,
    { promote_state: 'candidate', updated_at: nowIso(deps.now?.() ?? new Date()) },
    { refresh: 'wait_for' },
  )

  log({
    tool: 'promote',
    user: deps.userId,
    memory_id: current.id,
    reason: input.reason ?? '',
    ms: Date.now() - startedAt,
    changed: written.result !== 'noop',
    previous_state: typeof already === 'string' ? already : '',
  })

  return {
    memory_id: current.id,
    promote_state: 'candidate',
    changed: written.result !== 'noop',
    text: '已标记为团队候选（不会直接进团队库；整理任务会再做去重与敏感扫描）',
  }
}

const DESCRIPTION = [
  '把一条个人记忆标成「值得进团队知识库」的候选。',
  '何时用：这条经验对别人也有用（接口契约、踩过的坑、口径约定），且不含个人隐私与凭证。',
  '只置候选标记，不直接写团队库——去重与敏感扫描由整理任务负责。',
  '同一条只需标一次；已经是 promoted 的会被跳过。',
].join(' ')

export function definePromoteTool(deps: PromoteDeps) {
  return defineTool({
    name: 'memory_promote',
    description: DESCRIPTION,
    parameters: {
      memory_id: {
        type: 'string',
        required: true,
        description: '要标为候选的 memory_id（检索结果里就是它）。',
      },
      reason: {
        type: 'string',
        description: '为什么值得团队复用（审计用，只进日志）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          promote_state: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      return await promoteMemory(deps, args)
    },
  })
}
