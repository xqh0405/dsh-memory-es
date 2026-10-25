/**
 * 候选扫描 + 触发策略（文档 §9.1）。
 *
 * 扫谁：`status=active`、`privacy != private`、`promote_state ∈ {none, candidate}` 的个人记忆，
 * 按 `created_at` 升序取一批（先处理老的，避免新条目不断插队饿死旧条目）。
 *
 * 触发策略三种取其一（§9.1）：手动 / 窗口内待整理数 ≥ N / 距上次 ≥ 7 天且有新增。
 * 判定逻辑是纯函数，CLI 只负责把数字喂进来。
 *
 * @module dsh-memory-es/consolidate/scan
 */

import type { SearchBody } from '../src/es/dsl.ts'

/** 扫一批候选的默认上限（§9.6：批大小默认 20） */
export const DEFAULT_BATCH_SIZE = 20
/** 触发阈值：窗口内待整理条数（§9.1） */
export const DEFAULT_TRIGGER_COUNT = 20
/** 触发阈值：距上次整理的天数（§9.1） */
export const DEFAULT_TRIGGER_DAYS = 7

export interface CandidateQueryOptions {
  batchSize?: number
  /** 只看这个时间点之后创建的（时间窗；不传则不限） */
  createdAfter?: Date | null
  /** 只看这些 promote_state（默认 none + candidate） */
  promoteStates?: string[]
}

/** 组装候选查询 body（纯函数，便于测试断言字段） */
export function buildCandidateQuery(options: CandidateQueryOptions = {}): SearchBody {
  const filter: Array<Record<string, unknown>> = [
    { term: { status: 'active' } },
    { terms: { promote_state: options.promoteStates ?? ['none', 'candidate'] } },
  ]
  if (options.createdAfter) {
    filter.push({ range: { created_at: { gte: options.createdAfter.toISOString() } } })
  }
  return {
    size: options.batchSize ?? DEFAULT_BATCH_SIZE,
    _source: { excludes: ['embedding'] },
    query: {
      bool: {
        filter,
        // privacy=private 的不参与整理（§3.3）
        must_not: [{ term: { privacy: 'private' } }],
      },
    },
    sort: [{ created_at: 'asc' }],
  }
}

export interface TriggerInput {
  /** 窗口内 promote_state=none 的条数 */
  pendingCount: number
  /** 距上次整理多少天（从未整理过传 null） */
  daysSinceLastRun: number | null
  /** 本次是否手动触发（CLI 显式调用） */
  manual?: boolean
  countThreshold?: number
  daysThreshold?: number
  /** 窗口内有新增（daysSinceLastRun 分支的附加条件） */
  hasNewSinceLast?: boolean
}

export interface TriggerDecision {
  run: boolean
  reason: string
  /** 哪个条件被满足：manual / count / days / none */
  by: 'manual' | 'count' | 'days' | 'none'
}

/** 纯函数：要不要跑这一轮（§9.1 三种条件取其一） */
export function shouldRun(input: TriggerInput): TriggerDecision {
  if (input.manual) return { run: true, reason: '手动触发', by: 'manual' }
  const countThreshold = input.countThreshold ?? DEFAULT_TRIGGER_COUNT
  const daysThreshold = input.daysThreshold ?? DEFAULT_TRIGGER_DAYS

  if (input.pendingCount >= countThreshold) {
    return { run: true, reason: `窗口内待整理 ${input.pendingCount} 条 ≥ ${countThreshold}`, by: 'count' }
  }
  if (input.daysSinceLastRun === null) {
    return { run: true, reason: '从未整理过', by: 'days' }
  }
  if (input.daysSinceLastRun >= daysThreshold && input.hasNewSinceLast !== false) {
    return {
      run: true,
      reason: `距上次整理 ${input.daysSinceLastRun.toFixed(1)} 天 ≥ ${daysThreshold} 且有新增`,
      by: 'days',
    }
  }
  return {
    run: false,
    reason: `未达阈值（待整理 ${input.pendingCount}/${countThreshold}，距上次 ${input.daysSinceLastRun?.toFixed(1) ?? '—'} 天）`,
    by: 'none',
  }
}

/** 把 ES 命中映射成扫描结果（只留需要的字段） */
export interface Candidate {
  memory_id: string
  content: string
  memory_type: string
  domain: string
  created_at: string
  privacy: string
  promote_state: string
}

export function toCandidate(source: Record<string, unknown>, fallbackId: string): Candidate {
  return {
    memory_id: typeof source.memory_id === 'string' ? source.memory_id : fallbackId,
    content: typeof source.content === 'string' ? source.content : '',
    memory_type: typeof source.memory_type === 'string' ? source.memory_type : 'fact',
    domain: typeof source.domain === 'string' ? source.domain : 'general',
    created_at: typeof source.created_at === 'string' ? source.created_at : '',
    privacy: typeof source.privacy === 'string' ? source.privacy : 'normal',
    promote_state: typeof source.promote_state === 'string' ? source.promote_state : 'none',
  }
}
