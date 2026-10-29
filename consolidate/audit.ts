/**
 * 审计流水（文档 §10「支持这条知识哪来的/谁撤」）。
 *
 * 写进独立的 `memory_audit` 索引，不进团队库正文——审计是**只增不改**的流水，
 * 混进知识条目会让检索结果变脏、也让"审计与内容同生命周期"这种错误假设有可乘之机。
 *
 * 失败策略：**审计写失败不阻断主流程**，但必须打日志暴露。
 * 理由：审计是事后追溯，知识写入是主业务；为了记流水而让一次晋升失败，代价不对等。
 * 这个取舍写在这里，免得后人以为是漏了错误处理。
 *
 * @module dsh-memory-es/consolidate/audit
 */

import type { EsClient } from '../src/es/http.ts'
import { formatEsError } from '../src/es/http.ts'

export type AuditEvent =
  | 'promoted'
  | 'duplicate'
  | 'blocked'
  | 'pending_created'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  // 个人库独占的裁决（不写团队库）：也要留审计，否则事后答不了「为什么没晋升」
  | 'personal_only'

export interface AuditEntry {
  event: AuditEvent
  /** 谁做的：user id 或 'consolidate-cli' / 'review-cli' */
  actor: string
  at: Date
  subject_type: 'personal_memory' | 'team_doc'
  subject_id: string
  memory_id?: string
  team_doc_id?: string
  from_state?: string
  to_state?: string
  reason?: string
  note?: string
}

export interface AuditDeps {
  /** consolidator 身份（角色里已补 memory_audit 的 index/read） */
  client: Pick<EsClient, 'index'>
  index: string
  log?: (event: Record<string, unknown>) => void
}

/** 写一条审计；失败只记日志（见文件头说明） */
export async function writeAudit(deps: AuditDeps, entry: AuditEntry): Promise<boolean> {
  const doc: Record<string, unknown> = {
    event: entry.event,
    actor: entry.actor,
    at: entry.at.toISOString(),
    subject_type: entry.subject_type,
    subject_id: entry.subject_id,
  }
  if (entry.memory_id !== undefined) doc.memory_id = entry.memory_id
  if (entry.team_doc_id !== undefined) doc.team_doc_id = entry.team_doc_id
  if (entry.from_state !== undefined) doc.from_state = entry.from_state
  if (entry.to_state !== undefined) doc.to_state = entry.to_state
  if (entry.reason !== undefined) doc.reason = entry.reason
  if (entry.note !== undefined) doc.note = entry.note

  try {
    await deps.client.index(deps.index, doc, { refresh: 'wait_for' })
    return true
  } catch (err) {
    deps.log?.({ event: 'audit_write_failed', audit_event: entry.event, error: formatEsError(err) })
    return false
  }
}
