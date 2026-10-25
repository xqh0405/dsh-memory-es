/**
 * 审核台（S9）：把团队库里的待裁决条目变成可操作的对象。
 *
 * 状态语义（配合 search.ts 的审核闸 `review_state ∈ {auto, approved}`）：
 *   · `pending`  —— 待人工裁决：**已落库但不进检索结果**（这样队列可查、可统计，又不污染召回）
 *   · `approved` —— 人工通过：进入检索
 *   · `rejected` —— 人工驳回：`status=rejected`（检索默认只取 active，所以天然不可见）
 *   · 撤回      —— `status=superseded`（文档 §10：不物理删）
 *
 * 这里所有写操作都用 `mem-consolidator` 身份（它对 team_knowledge 有 index 权限，
 * 而 `index` 在 ES 里覆盖 index/update/delete 文档）。
 *
 * @module dsh-memory-es/consolidate/review
 */

import { writeAudit, type AuditDeps } from './audit.ts'
import type { EsClient } from '../src/es/http.ts'

export interface ReviewDepsBase {
  teamIndex: string
  /** 对团队库有写权限的客户端（consolidator） */
  client: Pick<EsClient, 'search' | 'update'>
  audit: AuditDeps
  now?: () => Date
}

export interface PendingDoc {
  doc_id: string
  content: string
  domain: string
  topic_key: string
  conflict_with?: string
  source_user?: string
  source_memory_id?: string
  promoted_at?: string
}

/** 列出待裁决条目（按晋升时间升序：先来的先处理） */
export async function listPending(
  deps: ReviewDepsBase,
  options: { limit?: number } = {},
): Promise<PendingDoc[]> {
  const result = await deps.client.search(deps.teamIndex, {
    size: options.limit ?? 20,
    _source: { excludes: ['embedding'] },
    query: { bool: { filter: [{ term: { review_state: 'pending' } }, { term: { status: 'active' } }] } },
    sort: [{ promoted_at: 'asc' }],
  })
  return result.hits.map((hit) => toPendingDoc(hit.id, hit.source))
}

function toPendingDoc(id: string, source: Record<string, unknown>): PendingDoc {
  const str = (key: string): string | undefined => (typeof source[key] === 'string' ? (source[key] as string) : undefined)
  return {
    doc_id: str('doc_id') ?? id,
    content: str('content') ?? '',
    domain: str('domain') ?? '',
    topic_key: str('topic_key') ?? '',
    ...(str('conflict_with') === undefined ? {} : { conflict_with: str('conflict_with') }),
    ...(str('source_user') === undefined ? {} : { source_user: str('source_user') }),
    ...(str('source_memory_id') === undefined ? {} : { source_memory_id: str('source_memory_id') }),
    ...(str('promoted_at') === undefined ? {} : { promoted_at: str('promoted_at') }),
  }
}

/** 通过：进入检索 */
export async function approve(
  deps: ReviewDepsBase,
  docId: string,
  reviewer: string,
): Promise<{ changed: boolean }> {
  const now = deps.now?.() ?? new Date()
  const result = await deps.client.update(
    deps.teamIndex,
    docId,
    {
      review_state: 'approved',
      reviewed_at: now.toISOString(),
      reviewed_by: reviewer,
      updated_at: now.toISOString(),
    },
    { refresh: 'wait_for' },
  )
  await writeAudit(deps.audit, {
    event: 'approved',
    actor: reviewer,
    at: now,
    subject_type: 'team_doc',
    subject_id: docId,
    team_doc_id: docId,
    from_state: 'pending',
    to_state: 'approved',
  })
  return { changed: result.result !== 'noop' }
}

/** 驳回：`status=rejected`，检索默认只取 active → 自然不可见 */
export async function reject(
  deps: ReviewDepsBase,
  docId: string,
  reviewer: string,
  reason: string,
): Promise<{ changed: boolean }> {
  const now = deps.now?.() ?? new Date()
  const result = await deps.client.update(
    deps.teamIndex,
    docId,
    {
      review_state: 'rejected',
      status: 'rejected',
      reject_reason: reason,
      reviewed_at: now.toISOString(),
      reviewed_by: reviewer,
      updated_at: now.toISOString(),
    },
    { refresh: 'wait_for' },
  )
  await writeAudit(deps.audit, {
    event: 'rejected',
    actor: reviewer,
    at: now,
    subject_type: 'team_doc',
    subject_id: docId,
    team_doc_id: docId,
    from_state: 'pending',
    to_state: 'rejected',
    reason,
  })
  return { changed: result.result !== 'noop' }
}

/**
 * 撤回（文档 §10）：`status=superseded`，**不物理删**。
 * 用于「这条知识是错的 / 不该在团队库里」的纠错路径。
 */
export async function withdraw(
  deps: ReviewDepsBase,
  docId: string,
  reviewer: string,
  reason: string,
): Promise<{ changed: boolean }> {
  const now = deps.now?.() ?? new Date()
  const result = await deps.client.update(
    deps.teamIndex,
    docId,
    {
      status: 'superseded',
      reviewed_at: now.toISOString(),
      reviewed_by: reviewer,
      updated_at: now.toISOString(),
    },
    { refresh: 'wait_for' },
  )
  await writeAudit(deps.audit, {
    event: 'withdrawn',
    actor: reviewer,
    at: now,
    subject_type: 'team_doc',
    subject_id: docId,
    team_doc_id: docId,
    to_state: 'superseded',
    reason,
  })
  return { changed: result.result !== 'noop' }
}
