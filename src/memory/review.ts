/**
 * 阶段 7.3：采纳闸门——把提炼出的候选（`status=pending` 的 identity）变成生效条目。
 *
 * 为什么闸门必须在写侧之外：7.2 的提炼只产出候选，是因为**模型归纳自己**这件事
 * 最容易跑偏（把一次偶然行为写成"你一贯如此"）。人看过、点头了，才允许它进入
 * 提示词与检索。
 *
 * 三条纪律：
 *  1. **只动 `pending` + `identity`**。approve 一条普通记忆或已生效条目，一律拒绝并说明当前状态。
 *  2. **拒绝不删**。置 `archived`，内容留着——"为什么没采纳"本身是信息。
 *  3. **审计尽力而为**。状态改成功、审计写失败，返回里要如实说明（`audit: 'failed'`），
 *     不能因为审计挂了就把用户的操作回滚，也不能假装审计写成功了。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { EsClient } from '../es/http.ts'
import { formatEsError } from '../es/http.ts'
import { personalIndexFor } from './common.ts'
import { IDENTITY_MEMORY_TYPE } from './save.ts'
import { TRAIT_STATUS } from './traits.ts'

/** 采纳后的状态：检索只认 active，所以这一步才是"生效" */
export const APPROVED_STATUS = 'active' as const
/** 拒绝后的状态：保留内容但不生效 */
export const REJECTED_STATUS = 'archived' as const

export interface ReviewCandidate {
  memory_id: string
  content: string
  evidence_ids: string[]
  created_at: string | null
}

export interface ReviewDeps {
  userId: string
  personalPrefix: string
  /** 共享审计索引名（默认 memory_audit；只有 teamWrite 能写） */
  auditIndex: string
  /** 个人审计索引前缀（实际索引 = 前缀 + userId；每个用户都有写权限） */
  auditPrefix: string
  reader: Pick<EsClient, 'search' | 'get'>
  writer: Pick<EsClient, 'index' | 'update'>
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}

export type AuditResult = 'ok' | 'personal_only' | 'failed' | 'skipped'

export interface ReviewOutcome {
  memory_id: string
  /** 状态是否真的变了（重复采纳/状态不符时为 false） */
  changed: boolean
  /** 操作后的状态；找不到条目时为空串 */
  status: string
  /**
   * 审计落点：ok = 个人 + 共享都写了；personal_only = 只写进个人审计（没有 teamWrite）；
   * failed = 个人审计也写失败；skipped = 没走到审计（状态未变/找不到条目）
   */
  audit: AuditResult
  note: string
}

/** 列出待采纳的候选（只有 identity + pending） */
export async function listCandidates(deps: ReviewDeps, limit = 20): Promise<ReviewCandidate[]> {
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const res = await deps.reader.search(index, {
    size: Math.max(1, Math.min(100, limit)),
    _source: ['memory_id', 'content', 'evidence_ids', 'created_at'],
    sort: [{ created_at: 'desc' }],
    query: {
      bool: {
        filter: [
          { term: { status: TRAIT_STATUS } },
          { term: { memory_type: IDENTITY_MEMORY_TYPE } },
        ],
      },
    },
  })
  const out: ReviewCandidate[] = []
  for (const hit of res.hits) {
    const src = hit.source as Record<string, unknown>
    if (typeof src.memory_id !== 'string' || typeof src.content !== 'string') continue
    const evidence = Array.isArray(src.evidence_ids)
      ? src.evidence_ids.filter((v): v is string => typeof v === 'string')
      : []
    out.push({
      memory_id: src.memory_id,
      content: src.content,
      evidence_ids: evidence,
      created_at: typeof src.created_at === 'string' ? src.created_at : null,
    })
  }
  return out
}

/** 采纳：pending → active */
export async function approveCandidate(
  deps: ReviewDeps,
  memoryId: string,
  note?: string,
): Promise<ReviewOutcome> {
  return transition(deps, memoryId, APPROVED_STATUS, 'identity_approved', note, '已采纳，这条自述现在会参与检索。')
}

/** 拒绝：pending → archived（不删，留着"为什么没采纳"） */
export async function rejectCandidate(
  deps: ReviewDeps,
  memoryId: string,
  note?: string,
): Promise<ReviewOutcome> {
  return transition(deps, memoryId, REJECTED_STATUS, 'identity_rejected', note, '已拒绝，条目置 archived（内容保留，不再参与检索）。')
}

async function transition(
  deps: ReviewDeps,
  memoryId: string,
  target: string,
  event: string,
  note: string | undefined,
  successText: string,
): Promise<ReviewOutcome> {
  const log = deps.log ?? (() => {})
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const now = deps.now?.() ?? new Date()

  let source: Record<string, unknown>
  try {
    const doc = await deps.reader.get(index, memoryId)
    source = doc.source ?? {}
  } catch (err) {
    if (isNotFound(err)) {
      return { memory_id: memoryId, changed: false, status: '', audit: 'skipped', note: `找不到条目 ${memoryId}。` }
    }
    throw err
  }

  const currentStatus = typeof source.status === 'string' ? source.status : ''
  const type = typeof source.memory_type === 'string' ? source.memory_type : ''
  if (type !== IDENTITY_MEMORY_TYPE) {
    return {
      memory_id: memoryId, changed: false, status: currentStatus, audit: 'skipped',
      note: `这条的类型是 ${type || '未知'}，不是 identity，不能走采纳闸门。`,
    }
  }
  if (currentStatus !== TRAIT_STATUS) {
    return {
      memory_id: memoryId, changed: false, status: currentStatus, audit: 'skipped',
      note: `这条当前状态是 ${currentStatus}（只有 pending 能被采纳）。`,
    }
  }

  // 审核痕迹先落条目本身：个人索引一定有写权限，而 memory_audit 只有 teamWrite 身份能写。
  // 这样即使审计索引写不进去，「谁在什么时候采纳/拒绝了」也不会丢。
  await deps.writer.update(
    index,
    memoryId,
    {
      status: target,
      updated_at: now.toISOString(),
      reviewed_at: now.toISOString(),
      reviewed_by: deps.userId,
      ...(note === undefined || note === '' ? {} : { review_note: note }),
    },
    { refresh: 'wait_for' },
  )

  const audit = await writeAudit(deps, {
    event,
    memoryId,
    fromState: currentStatus,
    toState: target,
    note,
    at: now,
  })

  log({ tool: 'review', event, memory_id: memoryId, audit, note: note ?? '' })
  const suffix =
    audit === 'personal_only'
      ? '（共享审计索引写不进——该账号没有 teamWrite；已记在个人审计与条目上）'
      : audit === 'failed'
        ? '（审计写入失败；审核痕迹已记在条目上）'
        : ''
  return { memory_id: memoryId, changed: true, status: target, audit, note: `${successText}${suffix}` }
}

export interface AuditEntry {
  event: string
  memoryId: string
  fromState: string
  toState: string
  note?: string
  at: Date
}

/**
 * 写审计。两层：**个人审计必写**（每个用户对自己的索引有权限），共享审计尽力写。
 *
 * 顺序不能反：先写个人那份，即使共享那份 403，用户自己的流水也已经留下。
 * 任何一层失败都不抛——主操作已经生效，不能因为审计把它回滚。
 */
export async function writeAudit(deps: ReviewDeps, entry: AuditEntry): Promise<AuditResult> {
  const doc = {
    event: entry.event,
    actor: deps.userId,
    at: entry.at.toISOString(),
    subject_type: 'personal_memory',
    subject_id: entry.memoryId,
    memory_id: entry.memoryId,
    from_state: entry.fromState,
    to_state: entry.toState,
    reason: entry.event,
    ...(entry.note === undefined || entry.note === '' ? {} : { note: entry.note }),
  }

  let personal = false
  try {
    await deps.writer.index(`${deps.auditPrefix}${deps.userId}`, doc, { refresh: 'wait_for' })
    personal = true
  } catch (err) {
    deps.log?.({ tool: 'review', event: 'personal_audit_failed', error: formatEsError(err) })
  }

  let shared = false
  try {
    await deps.writer.index(deps.auditIndex, doc, { refresh: 'wait_for' })
    shared = true
  } catch (err) {
    deps.log?.({ tool: 'review', event: 'shared_audit_failed', error: formatEsError(err) })
  }

  if (!personal) return 'failed'
  return shared ? 'ok' : 'personal_only'
}

/** 读个人审计流水（新→旧）。共享审计不在个人账号权限范围，这里只查自己的。 */
export async function listAudit(deps: ReviewDeps, limit = 20): Promise<Array<Record<string, unknown>>> {
  const index = `${deps.auditPrefix}${deps.userId}`
  const res = await deps.reader.search(index, {
    size: Math.max(1, Math.min(100, limit)),
    sort: [{ at: 'desc' }],
  })
  return res.hits.map((hit) => hit.source as Record<string, unknown>)
}

function isNotFound(err: unknown): boolean {
  const record = err as { status?: unknown } | null | undefined
  return record?.status === 404
}

const REVIEW_DESCRIPTION = [
  '审核提炼出的 identity 候选：list 看待采纳、approve 采纳生效、reject 拒绝（保留内容置 archived）。',
  '只有 status=pending 的 identity 条目能被采纳；重复采纳会如实告诉你当前状态而不是假装成功。',
].join('')

export const REVIEW_ACTION_VALUES = ['list', 'approve', 'reject', 'history'] as const
export type ReviewAction = (typeof REVIEW_ACTION_VALUES)[number]

export function defineReviewTool(deps: ReviewDeps) {
  return defineTool({
    name: 'memory_review',
    description: REVIEW_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: [...REVIEW_ACTION_VALUES],
        required: true,
        description: 'list = 列出待采纳候选；approve = 采纳；reject = 拒绝；history = 查自己的审核流水。',
      },
      memory_id: { type: 'string', description: 'approve / reject 时必填：候选的 memory_id。' },
      limit: { type: 'number', description: 'list 时最多返回几条（默认 20，上限 100）。' },
      note: { type: 'string', description: '备注（写进审计流水，可选）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          count: { type: 'number', required: true },
          changed: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          audit: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 一次读 + 一次写 + 一次审计
    timeoutMs: 15_000,
    async execute(input) {
      const action = String(input.action ?? 'list') as ReviewAction
      const note = input.note === undefined ? undefined : String(input.note)

      if (action === 'list') {
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 20
        const items = await listCandidates(deps, limit)
        return {
          action, count: items.length, changed: false, status: '', audit: 'skipped',
          text: renderCandidates(items),
        }
      }

      if (action === 'history') {
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 20
        const rows = await listAudit(deps, limit)
        return { action, count: rows.length, changed: false, status: '', audit: 'skipped', text: renderAudit(rows) }
      }

      const memoryId = String(input.memory_id ?? '').trim()
      if (memoryId === '') throw new Error('memory_review: approve / reject 需要 memory_id')

      const outcome = action === 'approve'
        ? await approveCandidate(deps, memoryId, note)
        : await rejectCandidate(deps, memoryId, note)
      return {
        action, count: 0, changed: outcome.changed, status: outcome.status, audit: outcome.audit,
        text: outcome.note,
      }
    },
  })
}

function renderAudit(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '还没有审核记录。'
  const lines = [`最近 ${rows.length} 条审核记录（新→旧）：`, '']
  for (const row of rows) {
    const at = typeof row.at === 'string' ? row.at.replace('T', ' ').slice(0, 19) : '?'
    const event = typeof row.event === 'string' ? row.event : '?'
    const id = typeof row.memory_id === 'string' ? row.memory_id : '?'
    const note = typeof row.note === 'string' && row.note !== '' ? `｜${row.note}` : ''
    lines.push(`- ${at} ${event} ${id}${note}`)
  }
  return lines.join('\n')
}

function renderCandidates(items: readonly ReviewCandidate[]): string {
  if (items.length === 0) return '没有待采纳的候选（提炼还没产出，或者都已经审核过了）。'
  const lines = [`待采纳的候选 ${items.length} 条：`, '']
  for (const item of items) {
    const evidence = item.evidence_ids.length > 0 ? `（依据 ${item.evidence_ids.length} 条记忆）` : ''
    lines.push(`- ${item.memory_id}：${item.content}${evidence}`)
  }
  lines.push('', '用 action=approve / reject 加 memory_id 处理。')
  return lines.join('\n')
}
