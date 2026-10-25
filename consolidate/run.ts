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
}

export interface StepResult {
  memory_id: string
  verdict: DedupeVerdict | 'blocked'
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
  const counts = { promoted: 0, duplicate: 0, mergeCandidate: 0, pending: 0, blocked: 0 }
  let state = options.state
  let skippedProcessed = 0
  let degraded = false

  const found = await deps.reader.search(deps.personalIndex, buildCandidateQuery({ batchSize: options.batchSize }))
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
          { promote_state: 'blocked', updated_at: now.toISOString() },
          { refresh: 'wait_for' },
        )
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
    const [item] = distillBatch([candidate])
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
        const knn = await deps.consolidator.search(
          deps.teamIndex,
          knnBody(vector, deps.dims, { status: 'active' }, 5),
        )
        neighbors = knn.hits.map((hit) => ({
          id: hit.id,
          score: hit.score,
          contentSha256: typeof hit.source.content_sha256 === 'string' ? hit.source.content_sha256 : undefined,
          topicKey: typeof hit.source.topic_key === 'string' ? hit.source.topic_key : undefined,
        }))
      } catch (err) {
        degraded = true
        log({ event: 'dedupe_degraded', memory_id: candidate.memory_id, error: String(err) })
      }
    } else if (shaHit === null) {
      degraded = true
    }

    const decision = decideDedupe({ shaHit, neighbors, topicKey: teamKey })

    // 4. 按结论行事（dry-run 到此为止，只记录）
    let teamDocId: string | undefined
    if (decision.verdict === 'new') {
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
          reason: decision.reason,
        })
      }
    } else if (decision.verdict === 'duplicate') {
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
          reason: decision.reason,
        })
      }
    } else if (decision.verdict === 'merge_candidate') {
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
          reason: decision.reason,
        })
      }
    } else {
      counts.pending += 1
      const pendingEntry = {
        memory_id: candidate.memory_id,
        at: now.toISOString(),
        reason: decision.reason,
        ...(decision.neighborId === undefined ? {} : { neighborId: decision.neighborId }),
      }
      if (options.apply) state = withPending(state, pendingEntry)
    }

    results.push({
      memory_id: candidate.memory_id,
      verdict: decision.verdict,
      reason: decision.reason,
      ...(teamDocId === undefined ? {} : { teamDocId }),
      ...(decision.neighborId === undefined ? {} : { neighborId: decision.neighborId }),
      topScore: decision.topScore,
      distilledBy: item.distilled_by,
      confidence: item.confidence,
    })
    log({
      event: 'candidate',
      memory_id: candidate.memory_id,
      verdict: decision.verdict,
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
