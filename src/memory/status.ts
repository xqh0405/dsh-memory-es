/**
 * `memory_update_status` —— 改记忆的状态，不物理删除（§3.4 模式 A / D4）。
 *
 * 五个动作：
 *  · `supersede`：旧文档置 `status=superseded` + `superseded_by`，**并回填新文档的 `supersedes`**
 *    （§3.4 要求「新文档 supersedes = 旧 memory_id」，不双写就没有可追溯的链）；
 *  · `expire`：置 `status=expired`（时间到了，自然失效）；
 *
 * 阶段 13：`supersede` / `expire` 会把**原因**写进 `forget_reason`。
 * 只打日志不留痕的话，半年后看到一条 superseded 的记忆，没人知道它为什么被换掉——
 * 「删除/失效必须可解释」是这一层的底线。`archive` 不写：它是可 restore 的暂存，不是终态失效。
 *  · `archive`：置 `status=archived`（人工判定不再需要，但保留可查）；
 *  · `restore`：置回 `status=active`，并清除 `superseded_by`（撤回取代 / 恢复归档）；
 *  · `mark_private`：置 `privacy=private`（不参与整理任务）。
 *
 * **永不物理删除**：本模块只改状态，任何一条记忆都能按 id 查回来。
 * 归档与过期都只是「移出检索」，不是销毁——审计要能回答「当时为什么这么定」。
 *
 * 写顺序是有讲究的：**先置旧文档 superseded，再回填新文档的 supersedes**。
 * 反过来若第二步失败，检索会同时返回新旧两版（错的结果）；这个顺序失败时只是「链缺一格」，
 * 检索仍然正确，事后可补。ES 没有事务，只能挑错得轻的那个。
 *
 * @module dsh-memory-es/memory/status
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MemoryStoreDeps } from './common.ts'
import { assertWriteAllowed, loadOwnedDoc, NON_FACT_MEMORY_TYPES, nowIso, personalIndexFor } from './common.ts'
import { PINNED_ITEM_MAX_CHARS, PINNED_MAX_ITEMS } from '../recall-inject.ts'

export const STATUS_ACTIONS = ['supersede', 'expire', 'archive', 'restore', 'mark_private', 'pin', 'unpin'] as const
export type StatusAction = (typeof STATUS_ACTIONS)[number]

/**
 * 记忆状态机：`active` 参与检索，其余都只是「移出检索」的不同理由。
 *
 * `mood` 不是记忆状态，而是**心情文档的专用标记**（`__mood__`，见 memory/mood.ts）：
 * 情绪状态存在同一个个人索引里，靠一个永不等于 `active` 的 status 让它天然不进检索、
 * 不进提炼素材。2026-11-01 之前它不在这个枚举里，面板会把它当未知值原样显示成 `mood`，
 * 统计与清理脚本也没有依据判断「这不是一条记忆」。**在这里显式承认它，并钉住它不属于记忆**。
 */
export const MEMORY_STATUSES = ['active', 'superseded', 'expired', 'archived', 'mood'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** `status=mood` 的文档不是记忆（心情状态），任何记忆口径的统计都要排除它 */
export const NON_MEMORY_STATUS = 'mood' as const

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
  if (action === 'archive') return '已归档（不再参与检索，仍可按 id 查回；没有删除）'
  if (action === 'restore') return '已恢复为 active（重新参与检索）'
  if (action === 'pin') {
    return status === 'active'
      ? '已置为常驻：每轮注入都会带上它（与当前问题无关也在）'
      : `已置为常驻，但它当前状态是 ${status}，不会注入——需要先 restore 成 active`
  }
  if (action === 'unpin') return '已取消常驻（不再每轮注入，但仍可被检索命中）'
  return `已标记为 private（不参与整理任务），状态仍为 ${status}`
}

/**
 * 数一下当前有多少条「可注入的常驻」，供 pin 回执报上限用。
 *
 * 口径与 `pinnedSearchBody` 完全一致（pinned + active，且排除非事实三类）——
 * 报出来的数字必须等于「真正会进注入段的条数」，否则回执又变成另一种过度承诺。
 * `reader.search` 是可选能力（有的测试只给 get），数不出来返回 null 走降级文案；
 * 查询失败同理：**数不清不该让 pin 这个动作失败**。
 */
async function countPinned(deps: UpdateStatusDeps, index: string): Promise<number | null> {
  if (typeof deps.reader.search !== 'function') return null
  try {
    const res = await deps.reader.search(
      index,
      {
        size: 0,
        query: {
          bool: {
            filter: [{ term: { pinned: true } }, { term: { status: 'active' } }],
            must_not: [{ terms: { memory_type: [...NON_FACT_MEMORY_TYPES] } }],
          },
        },
      },
      { signal: deps.signal },
    )
    return res.total
  } catch {
    return null
  }
}

/**
 * 编排。所有写都走 writer 凭证；读走 reader。
 * 失败一律抛（不吞）：改状态失败却回报成功，会让模型以为旧记忆已经下架。
 */
export async function updateStatus(
  deps: UpdateStatusDeps,
  input: UpdateStatusInput,
): Promise<UpdateStatusResult> {
  // 写闸（2026-11-10 下沉，用户拍板「全拦」）：pin/unpin、归档、supersede、过期、恢复隔离
  // 全走这一个入口，一道闸就够。旧版这里零检查 —— 24.3 只堵了 memory_save，
  // governance.write=off 时仍能置顶并每轮注入（审查 A2 里最像后门的一条）。
  assertWriteAllowed(deps, `memory_update_status action=${String(input.action)}`)
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
  // 阶段 13：没给原因就用动作名兜底，保证 `forget_reason` 永远有值可查
  // （「没写原因」和「原因是 superseded」在语义上是一回事：都是被新版本取代）
  const reason = (input.reason ?? '').trim()

  if (action === 'supersede') {
    if (replacementId === '') {
      throw new Error('memory_update_status: action=supersede 必须给 replacement_memory_id（指向新版本）')
    }
    if (replacementId === current.id) {
      throw new Error('memory_update_status: replacement_memory_id 不能是自己')
    }
    // 先确认替代版本真实存在（否则会留下指向空气的链）
    await loadOwnedDoc(deps, replacementId)

    // ① 旧文档下架：先做这一步，保证检索立刻正确。
    // signal 必须两步都带：只带第二步的话，调用方已取消时第一步照样会写下去。
    const signal = deps.signal
    const oldWrite = await deps.writer.update(
      index,
      current.id,
      { status: 'superseded', superseded_by: replacementId, forget_reason: reason === '' ? 'superseded' : reason, updated_at: now },
      { refresh: 'wait_for', signal },
    )
    // ② 新文档回填 supersedes（可追溯的那一格）
    await deps.writer.update(
      index,
      replacementId,
      { supersedes: current.id, updated_at: now },
      { refresh: 'wait_for', signal },
    )

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

  if (action === 'archive') {
    await deps.writer.update(index, current.id, { status: 'archived', updated_at: now }, { refresh: 'wait_for' })
    return {
      memory_id: current.id,
      action,
      status: 'archived',
      privacy: typeof current.source.privacy === 'string' ? current.source.privacy : 'normal',
      superseded_by: typeof current.source.superseded_by === 'string' ? current.source.superseded_by : '',
      changed: true,
      text: describe(action, 'archived', ''),
    }
  }

  if (action === 'restore') {
    // 必须清掉 superseded_by：否则检索的 `must_not exists superseded_by` 仍会挡住它。
    // 置 null 而不是删字段——ES 的 `exists` 对 null 返回 false，效果等价且不需要脚本权限。
    //
    // 同时清 `quarantine_reason`：恢复一条被隔离（status=quarantine）的记忆时，
    // 只把 status 改回 active 会让原因残留，面板详情看起来像「已生效但还挂着隔离理由」，
    // 审的人分不清它到底恢复干净了没有。（面板的 /memories/restore 早就清了，工具侧漏了。）
    // 其它状态被误写这个字段时也一并无害——它只在 status=quarantine 时有语义。
    //
    // `distill_state` 要跟着重置（2026-11-10 审查 #16）：隔离与归档期间它可能被标成 `skipped`
    // （save.ts 隔离时、distillRunner 对非 active 时），恢复成 active 后若不改回来，
    // 清扫只查 `distill_state=pending` —— 这条**永远不会再蒸馏**，而隔离来的那批
    // **按设计还没有向量**（隔离不写向量），恢复后只能关键词检索。
    //
    // 但 `skipped` 不等于「有病」——线上实测 status=active 且 distill_state=skipped 共 93 条，
    // 其中 91 条是 `origin=import`（阶段 33 下沉的短规则，向量已补齐、本就是人工收紧过的），
    // 另 1 条 `origin=tool` 是人工写的种子规则。无脑重置会把它们重新扔进蒸馏队列、
    // 让 LLM 再改写一遍。所以分三种：
    //  · `prevStatus=quarantine` → **一定重排**（skipped 是「隔离期间跑不了」写的，且没有向量）；
    //  · `origin=import` → 不动（脚本下沉时**有意**标 skip）；
    //  · 已有 `summary` → 不动（蒸馏的产物就是 summary，有它说明已经蒸馏过）；
    //  · 其余（归档前还是 pending、从没蒸馏过）→ 重排。
    //
    // 注：面板 `/memories/restore` 与 `scripts/restore-quarantine.ts` 只处理 `status=quarantine`，
    // 那里 skipped 无歧义、直接重置即可；只有工具侧 restore 是多状态入口才要分。
    const prevStatus = typeof current.source.status === 'string' ? current.source.status : ''
    const origin = typeof current.source.origin === 'string' ? current.source.origin : ''
    const condensed = typeof current.source.summary === 'string' && current.source.summary.trim() !== ''
    const requeued = current.source.distill_state === 'skipped'
      && (prevStatus === 'quarantine' || (origin !== 'import' && !condensed))
    await deps.writer.update(
      index,
      current.id,
      {
        status: 'active',
        superseded_by: null,
        quarantine_reason: null,
        forget_reason: null,
        ...(requeued ? { distill_state: 'pending' } : {}),
        updated_at: now,
      },
      { refresh: 'wait_for', signal: deps.signal },
    )
    const base = describe(action, 'active', '')
    return {
      memory_id: current.id,
      action,
      status: 'active',
      privacy: typeof current.source.privacy === 'string' ? current.source.privacy : 'normal',
      superseded_by: '',
      changed: true,
      text: requeued
        ? `${base}；已重新排队蒸馏（distill_state pending → 下一轮清扫会改写正文并补向量）`
        : base,
    }
  }

  if (action === 'pin' || action === 'unpin') {
    // 阶段 33：只改 pinned 一位。不改 status —— 置顶与「在不在检索里」是两条正交的轴：
    // 把 archived 的条目 pin 起来不该让它复活，pin 一条 active 的也不该改它的可见性。
    const written = await deps.writer.update(
      index,
      current.id,
      { pinned: action === 'pin', updated_at: now },
      { refresh: 'wait_for', signal: deps.signal },
    )
    const status = typeof current.source.status === 'string' ? current.source.status : 'active'
    log({
      tool: 'status',
      user: deps.userId,
      memory_id: current.id,
      action,
      reason: input.reason ?? '',
      ms: Date.now() - startedAt,
      changed: written.result !== 'noop',
    })
    let text = describe(action, status, '')
    // 回执必须把上限说清楚（2026-11-10 审查 #14）：旧版只承诺「每轮注入都会带上它」，
    // 但常驻段实际有 8 条上限、单条截断到 200 字 —— 第 9 条被挤掉时用户毫无察觉，
    // 于是「记住了」变成「以为记住了」。数不出来也不该让 pin 失败，退化成只报静态上限。
    if (action === 'pin' && status === 'active') {
      const total = await countPinned(deps, index)
      const cap = `常驻段每轮只注入前 ${PINNED_MAX_ITEMS} 条、单条截断到 ${PINNED_ITEM_MAX_CHARS} 字`
      text = total === null
        ? `${text}（${cap}）`
        : `${text}（当前常驻共 ${total} 条；${cap}——超出的按重要度与更新时间取舍）`
    }
    return {
      memory_id: current.id,
      action,
      status,
      privacy: typeof current.source.privacy === 'string' ? current.source.privacy : 'normal',
      superseded_by: typeof current.source.superseded_by === 'string' ? current.source.superseded_by : '',
      changed: written.result !== 'noop',
      text,
    }
  }

  const patch: Record<string, unknown> =
    action === 'expire'
      ? { status: 'expired', forget_reason: reason === '' ? 'expired' : reason, updated_at: now }
      : { privacy: 'private', updated_at: now }
  const written = await deps.writer.update(index, current.id, patch, {
    refresh: 'wait_for',
    signal: deps.signal,
  })

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
  'pin：置为常驻，之后每一轮注入都会带上它（不看当前问题）；unpin：取消常驻。用户说「记住这条、以后都要」时用 pin。',
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
        description: 'supersede=被新版本取代；expire=过期；archive=归档；restore=恢复；mark_private=标记私有；pin=置为常驻（每轮注入）；unpin=取消常驻。',
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
    // supersede 是双写（旧→superseded 再新→supersedes）+ 一次读，给 15 s
    timeoutMs: 15_000,
    async execute(args, exec) {
      return await updateStatus({ ...deps, signal: exec.signal }, args)
    },
  })
}
