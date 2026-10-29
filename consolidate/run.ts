/**
 * 整理任务的编排层（个人记忆 → 团队库）。CLI 只负责解析参数与装配依赖，逻辑都在这里，
 * 这样集成测试可以直接调 `runConsolidation`，不用起子进程。
 *
 * 一轮的决策顺序（与文档一致，顺序有讲究）：
 *   1. **敏感扫描优先**——命中就 blocked，后面所有步骤都不做（成本最低的闸放最前）；
 *   2. 规则蒸馏 → 拿到改写文本；
 *   3. 精确 sha 去重 + kNN 邻居 → `decideDedupe` 出结论；
 *   4. 只有 `new` 才写团队库；其余按结论回写个人库的状态。
 *
 * dry-run 与 apply 走**同一套判定**，唯一区别是「要不要写」。这样 dry-run 报告就真的
 * 是 apply 会发生的事，而不是另一套近似逻辑。
 *
 * @module dsh-memory-es/consolidate/run
 */

import type { Embedder } from '../src/embedding.ts'
import { dedupeBody, knnBody } from '../src/es/dsl.ts'
import type { EsClient } from '../src/es/http.ts'
import { normalizeContent, sha256Hex } from '../src/fragment.ts'
import type { AuditDeps } from './audit.ts'
import { writeAudit } from './audit.ts'
import { detectContradiction } from './conflict.ts'
import type { DedupeVerdict, NeighborHit } from './dedupe.ts'
import { decideDedupe } from './dedupe.ts'
import { distillBatch, toTeamDoc, topicKey } from './distill.ts'
import type { Candidate } from './scan.ts'
import { buildCandidateQuery, toCandidate } from './scan.ts'
import { scanSensitive, summarizeHits } from './sensitive.ts'
import type { ConsolidateState } from './state.ts'
import { alreadyProcessed, withPending, withProcessed } from './state.ts'

export interface ConsolidateDeps {
  userId: string
  personalIndex: string
  teamIndex: string
  /** 读个人库（mem-reader 身份，只读） */
  reader: Pick<EsClient, 'search'>
  /** 回写个人库状态（mem-writer 身份） */
  writer: Pick<EsClient, 'update'>
  /** 读团队库 + 写团队库（mem-consolidator 身份，团队库只有它能写） */
  consolidator: Pick<EsClient, 'search' | 'index'>
  embed: Pick<Embedder, 'embed'> | null
  dims: number
  /** 审计通道（S9）。不传 = 不记流水（测试里可省，生产 CLI 必传） */
  audit?: AuditDeps
  now?: () => Date
  newId?: () => string
  log?: (event: Record<string, unknown>) => void
}

export interface RunOptions {
  /** false = dry-run（默认）：判定照做、一条不写 */
  apply: boolean
  batchSize: number
  state: ConsolidateState
  /** 只跑这一批、不理会触发阈值（CLI 手动模式） */
  manual?: boolean
  /** 只看该时间之后创建的记忆（CLI `--since`）；不传则不限 */
  createdAfter?: Date | null
}

export interface StepResult {
  memory_id: string
  verdict: DedupeVerdict | 'blocked' | 'personal_only'
  reason: string
  /** 写进团队库的 doc_id（仅 verdict=new 且 apply 时） */
  teamDocId?: string
  neighborId?: string
  topScore?: number | null
  /** 蒸馏方式与置信度，方便 dry-run 报告判断可信度（S8 只有 rule；S9 接 LLM 后会是 'llm'） */
  distilledBy: 'rule' | 'llm'
  confidence: number
  sensitiveKinds?: string
}

export interface RunReport {
  applied: boolean
  candidates: number
  skippedProcessed: number
  results: StepResult[]
  counts: { promoted: number; duplicate: number; mergeCandidate: number; pending: number; blocked: number }
  /** 模糊输入（embedding 不可用 → 该条没做 kNN 去重，只做了 sha 精确判定） */
  degraded: boolean
  state: ConsolidateState
}

/** 一轮整理。默认 dry-run：`apply=false` 时**只读不写**。 */
export async function runConsolidation(deps: ConsolidateDeps, options: RunOptions): Promise<RunReport> {
  const now = deps.now?.() ?? new Date()
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const log = deps.log ?? (() => {})
  const results: StepResult[] = []
  const counts = { promoted: 0, duplicate: 0, mergeCandidate: 0, pending: 0, blocked: 0, personalOnly: 0 }
  let state = options.state
  let skippedProcessed = 0
  let degraded = false

  const found = await deps.reader.search(
    deps.personalIndex,
    buildCandidateQuery({
      batchSize: options.batchSize,
      createdAfter: options.createdAfter ?? null,
    }),
  )
  const candidates = found.hits.map((hit) => toCandidate(hit.source, hit.id))

  for (const candidate of candidates) {
    if (!options.manual && alreadyProcessed(state, candidate.memory_id)) {
      skippedProcessed += 1
      continue
    }

    // 1. 敏感扫描（最便宜的闸放最前）
    const hits = scanSensitive(candidate.content)
    if (hits.length > 0) {
      const kinds = summarizeHits(hits)
      counts.blocked += 1
      results.push({
        memory_id: candidate.memory_id,
        verdict: 'blocked',
        reason: `敏感信息命中：${kinds}（${hits.length} 处，未打印原文）`,
        distilledBy: 'rule',
        confidence: 0,
        sensitiveKinds: kinds,
      })
      if (options.apply) {
        await deps.writer.update(
          deps.personalIndex,
          candidate.memory_id,
          { promote_state: 'blocked', blocked_reason: kinds, updated_at: now.toISOString() },
          { refresh: 'wait_for' },
        )
        if (deps.audit) {
          await writeAudit(deps.audit, {
            event: 'blocked',
            actor: `consolidate:${deps.userId}`,
            at: now,
            subject_type: 'personal_memory',
            subject_id: candidate.memory_id,
            memory_id: candidate.memory_id,
            from_state: 'none',
            to_state: 'blocked',
            reason: kinds,
          })
        }
        state = withProcessed(state, candidate.memory_id, {
          at: now.toISOString(),
          verdict: 'blocked',
          reason: `sensitive:${kinds}`,
        })
      }
      log({ event: 'blocked', memory_id: candidate.memory_id, kinds })
      continue
    }

    // 2. 规则蒸馏
    // homeUser：把 `/home/<该用户>` 相对化成 `~`（团队库里不该出现别人的家目录）
    const [item] = distillBatch([candidate], { homeUser: deps.userId })

    // 2.5 纯环境配置（「项目 X 克隆在 /home/…」「Maven 已装好于 /opt/…」）不进团队库。
    //     这类内容对别人零价值，灌进去只能事后人工删（2026-10-29 实测 39/244 是这种）。
    //     判 personal_only 后回写个人库；scan 的 promoteStates 不含它 → 以后不再被扫。
    if (item.verdict === 'personal_only') {
      counts.personalOnly += 1
      results.push({
        memory_id: candidate.memory_id,
        verdict: 'personal_only',
        reason: item.reason,
        distilledBy: item.distilled_by,
        confidence: item.confidence,
      })
      if (options.apply) {
        await deps.writer.update(
          deps.personalIndex,
          candidate.memory_id,
          {
            promote_state: 'personal_only',
            personal_only_reason: item.reason,
            updated_at: now.toISOString(),
          },
          { refresh: 'wait_for' },
        )
        if (deps.audit) {
          await writeAudit(deps.audit, {
            event: 'personal_only',
            actor: `consolidate:${deps.userId}`,
            at: now,
            subject_type: 'personal_memory',
            subject_id: candidate.memory_id,
            memory_id: candidate.memory_id,
            from_state: 'none',
            to_state: 'personal_only',
            reason: item.reason,
          })
        }
        state = withProcessed(state, candidate.memory_id, {
          at: now.toISOString(),
          verdict: 'personal_only',
          reason: item.reason,
        })
      }
      log({ event: 'personal_only', memory_id: candidate.memory_id, reason: item.reason })
      continue
    }

    const rewritten = item.rewritten_content
    const teamKey = topicKey(item.domain, rewritten)

    // 3. 去重：精确 sha 优先，其次 kNN 邻居
    const sha = sha256Hex(normalizeContent(rewritten))
    const exact = await deps.consolidator.search(deps.teamIndex, dedupeBody(sha))
    const shaHit = exact.hits[0]?.id ?? null

    let neighbors: NeighborHit[] = []
    if (shaHit === null && deps.embed) {
      try {
        const vector = await deps.embed.embed(rewritten)
        // 只在**同一个 domain** 内找邻居：跨域内容语义不同（「分支只认 main」在 CI 与在发布流程里
        // 是两件事），混着比既会误判重复，也会让冲突判定比错了对手（S9 实测踩到）。
        const knn = await deps.consolidator.search(
          deps.teamIndex,
          knnBody(vector, deps.dims, { status: 'active', domain: item.domain }, 5),
        )
        neighbors = knn.hits.map((hit) => ({
          id: hit.id,
          score: hit.score,
          topicKey: typeof hit.source.topic_key === 'string' ? hit.source.topic_key : undefined,
          content: typeof hit.source.content === 'string' ? hit.source.content : undefined,
        }))
      } catch (err) {
        degraded = true
        log({ event: 'dedupe_degraded', memory_id: candidate.memory_id, error: String(err) })
      }
    } else if (shaHit === null) {
      degraded = true
    }

    const decision = decideDedupe({ shaHit, neighbors, topicKey: teamKey })

    // 3.5 冲突优先于合并（§9.4 最后一条）：高相似但结论相反 → 一律 pending。
    // 判不了的语义冲突不硬判——detectContradiction 只对明确词对返回 true。
    let verdict: StepResult['verdict'] = decision.verdict
    let reason = decision.reason
    let conflictWith: string | undefined
    if (decision.verdict === 'merge_candidate' && decision.neighborId !== undefined) {
      const neighborContent = neighbors.find((n) => n.id === decision.neighborId)?.content ?? ''
      const contradiction = detectContradiction(rewritten, neighborContent)
      if (contradiction.contradiction) {
        verdict = 'pending'
        reason = contradiction.reason
        conflictWith = decision.neighborId
      }
    }

    // 4. 按结论行事（dry-run 到此为止，只记录）
    let teamDocId: string | undefined
    if (verdict === 'new') {
      counts.promoted += 1
      if (options.apply) {
        const docId = newId()
        let embedding: number[] | null = null
        if (deps.embed) {
          try {
            embedding = await deps.embed.embed(rewritten)
          } catch (err) {
            degraded = true
            log({ event: 'team_embedding_degraded', memory_id: candidate.memory_id, error: String(err) })
          }
        }
        await deps.consolidator.index(
          deps.teamIndex,
          toTeamDoc(item, candidate, {
            docId,
            sourceUser: deps.userId,
            now,
            embedding,
            status: 'active',
            reviewState: 'auto',
          }),
          { id: docId, refresh: 'wait_for' },
        )
        await deps.writer.update(
          deps.personalIndex,
          candidate.memory_id,
          { promote_state: 'promoted', updated_at: now.toISOString() },
          { refresh: 'wait_for' },
        )
        teamDocId = docId
        state = withProcessed(state, candidate.memory_id, {
          at: now.toISOString(),
          verdict: 'promoted',
          teamDocId,
          reason,
        })
        if (deps.audit) {
          await writeAudit(deps.audit, {
            event: 'promoted',
            actor: `consolidate:${deps.userId}`,
            at: now,
            subject_type: 'team_doc',
            subject_id: docId,
            memory_id: candidate.memory_id,
            team_doc_id: docId,
            from_state: 'none',
            to_state: 'auto',
            reason,
          })
        }
      }
    } else if (verdict === 'duplicate') {
      counts.duplicate += 1
      if (options.apply) {
        // 团队库已有同文：个人这条的“已晋升”是事实，直接置 promoted（幂等）
        await deps.writer.update(
          deps.personalIndex,
          candidate.memory_id,
          { promote_state: 'promoted', updated_at: now.toISOString() },
          { refresh: 'wait_for' },
        )
        state = withProcessed(state, candidate.memory_id, {
          at: now.toISOString(),
          verdict: 'duplicate',
          reason,
        })
      }
    } else if (verdict === 'merge_candidate') {
      counts.mergeCandidate += 1
      if (options.apply) {
        // S8 不做自动合并：标成 candidate 表示“评估过、待人工合并”，不改团队库
        await deps.writer.update(
          deps.personalIndex,
          candidate.memory_id,
          { promote_state: 'candidate', updated_at: now.toISOString() },
          { refresh: 'wait_for' },
        )
        state = withProcessed(state, candidate.memory_id, {
          at: now.toISOString(),
          verdict: 'merge_candidate',
          reason,
        })
      }
    } else {
      // pending：S9 起**落库**（S8 只记本地文件，因为检索挡不住 review_state）。
      // 现在 search 侧已加审核闸（review_state ∈ {auto,approved}），所以落库也不会污染召回，
      // 队列才可查、可统计、可审批。
      counts.pending += 1
      if (options.apply) {
        const docId = newId()
        let embedding: number[] | null = null
        if (deps.embed) {
          try {
            embedding = await deps.embed.embed(rewritten)
          } catch (err) {
            degraded = true
            log({ event: 'pending_embedding_degraded', memory_id: candidate.memory_id, error: String(err) })
          }
        }
        const pendingDoc = toTeamDoc(item, candidate, {
          docId,
          sourceUser: deps.userId,
          now,
          embedding,
          status: 'active',
          reviewState: 'pending',
        })
        if (conflictWith !== undefined) pendingDoc.conflict_with = conflictWith
        await deps.consolidator.index(deps.teamIndex, pendingDoc, { id: docId, refresh: 'wait_for' })
        // 个人这条留 candidate：还没定论，不能标 promoted
        await deps.writer.update(
          deps.personalIndex,
          candidate.memory_id,
          { promote_state: 'candidate', updated_at: now.toISOString() },
          { refresh: 'wait_for' },
        )
        teamDocId = docId
        state = withPending(state, {
          memory_id: candidate.memory_id,
          at: now.toISOString(),
          reason,
          ...(conflictWith === undefined ? {} : { neighborId: conflictWith }),
        })
        state = withProcessed(state, candidate.memory_id, {
          at: now.toISOString(),
          verdict: 'pending',
          teamDocId: docId,
          reason,
        })
        if (deps.audit) {
          await writeAudit(deps.audit, {
            event: 'pending_created',
            actor: `consolidate:${deps.userId}`,
            at: now,
            subject_type: 'team_doc',
            subject_id: docId,
            memory_id: candidate.memory_id,
            team_doc_id: docId,
            to_state: 'pending',
            reason,
            ...(conflictWith === undefined ? {} : { note: `conflict_with=${conflictWith}` }),
          })
        }
      }
    }

    results.push({
      memory_id: candidate.memory_id,
      verdict,
      reason,
      ...(teamDocId === undefined ? {} : { teamDocId }),
      ...(decision.neighborId === undefined ? {} : { neighborId: decision.neighborId }),
      topScore: decision.topScore,
      distilledBy: item.distilled_by,
      confidence: item.confidence,
    })
    log({
      event: 'candidate',
      memory_id: candidate.memory_id,
      verdict,
      applied: options.apply,
      top_score: decision.topScore,
    })
  }

  if (options.apply) state = { ...state, lastRunAt: now.toISOString() }

  return {
    applied: options.apply,
    candidates: candidates.length,
    skippedProcessed,
    results,
    counts,
    degraded,
    state,
  }
}
