/**
 * 影子召回（阶段 16 P0）：每轮用户消息之后跑一次「假如自动注入，会注入什么」，
 * **只记录、不注入**。
 *
 * 为什么先做影子而不是直接注入：
 *  · 注入会写进 session 历史，可回放、按 token 计费——做错了不是「这次没搜到」，
 *    而是「这段对话里永久多了一段错误上下文」，撤不回来；
 *  · 现在没有任何数据能说明「自动召回能命中真实问题」（评审里 89% 条目从未被命中），
 *    拿真实对话当试验田不划算。
 * 影子模式零风险：不碰历史、不计费、不影响模型，一周后用数据决定要不要真注入。
 *
 * 两个**故意不做**的事：
 *  · 不写 hit 记录（`hitRecorder`）——影子不是真实使用，不能把热度信号抬高，
 *    否则「被影子看过」会变成「真的有人用过」，污染后续排序；
 *  · 不写 search_log 索引——`search_log_*` 是 `dynamic: strict`，加字段必须
 *    先对全量索引跑迁移再上代码；为一份观测数据动 mapping 不值得，落本地 JSONL。
 *
 * @module dsh-memory-es/recall-shadow
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshMemoryDataDir } from './sessions.ts'

/** 影子召回的配置（默认值在 config.ts，这里只声明形状） */
export interface RecallShadowConfig {
  /** 默认开：影子本身零风险，关着就永远拿不到「该不该开」的数据 */
  enabled: boolean
  /** 最多记几条「会注入」的候选 */
  maxItems: number
  /** 「会注入」的字符预算：按顺序累加，超了就不再算进注入集 */
  maxChars: number
  /** 单次检索超时（毫秒）；超时记 outcome=timeout，不影响任何东西 */
  timeoutMs: number
  /** 两次观测之间的最小间隔（毫秒）；0 = 每条用户消息都观察 */
  minIntervalMs: number
  /** 拿消息前多少个字符当检索 query */
  queryMaxChars: number
  /** JSONL 输出路径；空字符串 = `$DSH_HOME/memory-es/recall-shadow.jsonl` */
  path: string
}

/** 一次观测的结果分类（统计脚本按这个分组） */
export type ShadowOutcome = 'ok' | 'no_match' | 'low_confidence' | 'timeout' | 'error' | 'throttled' | 'empty'

/** 会注入的一条候选 */
export interface ShadowInjection {
  memory_id: string
  chars: number
  score: number
}

/** 落盘的一行观测 */
export interface ShadowRecord {
  ts: string
  agent: string
  query: string
  outcome: ShadowOutcome
  ms: number
  /** 检索一共召回几条 */
  hits: number
  /** 按预算裁剪后「如果注入会注入」的候选 */
  wouldInject: ShadowInjection[]
  /** 注入集的总字符数（估算 token ≈ chars / 2） */
  chars: number
  note?: string
}

/** 检索结果的形状（只取用到的字段，避免把 search.ts 的实现拖进来） */
export interface ShadowHit {
  memory_id?: string
  content?: string
  score?: number
}

/**
 * 节流判定（纯函数，可单测）。
 * `lastAt = 0` 表示还没观察过；`minIntervalMs = 0` 表示不节流。
 */
export function shouldThrottle(lastAt: number, now: number, minIntervalMs: number): boolean {
  if (minIntervalMs <= 0) return false
  if (lastAt <= 0) return false
  // 时钟回拨（now < lastAt）不当作节流：宁可多观察一次，也不要永久卡死
  if (now < lastAt) return false
  return now - lastAt < minIntervalMs
}

/**
 * 挑出「如果注入会注入哪几条」（纯函数，可单测）。
 *
 * 两条预算同时生效：条数上限 + 字符上限，按检索顺序累加——和真注入时的逻辑一致，
 * 否则影子数据会高估注入体积。
 */
export function pickInjection(hits: readonly ShadowHit[], maxItems: number, maxChars: number): ShadowInjection[] {
  const picked: ShadowInjection[] = []
  let used = 0
  for (const hit of hits) {
    if (picked.length >= maxItems) break
    const id = hit.memory_id ?? ''
    if (id === '') continue
    const chars = (hit.content ?? '').length
    // 单条就超预算时仍保留：否则长记忆永远进不了注入集，影子会失真
    if (used > 0 && used + chars > maxChars) break
    picked.push({ memory_id: id, chars, score: typeof hit.score === 'number' ? hit.score : 0 })
    used += chars
  }
  return picked
}

/** 把消息文本裁成检索 query：折叠空白后截前 N 字 */
export function toQuery(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars)
}

/** 影子记录的输出路径：配置为空时落到插件私有数据目录 */
export function resolveShadowPath(configured: string): string {
  if (configured.trim() !== '') return configured
  return join(dshMemoryDataDir(), 'recall-shadow.jsonl')
}

/**
 * 追加一行 JSONL。
 *
 * 写失败只吞掉、不抛：影子是旁路观测，**不能因为磁盘/权限问题影响消息主流程**。
 * 但要把失败次数记下来（`failures`），避免「一直没数据还以为是没命中」。
 */
export function createShadowWriter(path: string): {
  write: (record: ShadowRecord) => void
  failures: () => number
} {
  let failed = 0
  let ready = false
  return {
    write(record) {
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true })
          ready = true
        }
        appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        failed += 1
      }
    },
    failures: () => failed,
  }
}

/** 观测器需要的检索能力（注入真实 searchMemories 或测试替身） */
export interface ObserverDeps {
  /** 返回该用的检索结果；实现方负责把 detail 定成 summary（影子只估体积，不要全文） */
  search: (query: string, signal: AbortSignal) => Promise<{ hits: readonly ShadowHit[]; note: string }>
  writer: ReturnType<typeof createShadowWriter>
  config: RecallShadowConfig
  /** 可注入的时钟（测试用） */
  now?: () => number
}

/**
 * 建一个观测器：`observe({text, agent})` 是**即发即忘**的旁路。
 *
 * 三条不变式（被单测钉住）：
 *  1. 永不抛出——任何异常都收敛成 outcome=error 的观测记录；
 *  2. 永不改写会话——这个模块没有能力碰 messages，也不该有；
 *  3. 超时就放弃——`timeoutMs` 到了直接 abort 并记 timeout，
 *     不让一次慢检索拖住后面的消息。
 */
export function createRecallObserver(deps: ObserverDeps) {
  const cfg = deps.config
  const now = deps.now ?? Date.now
  let lastAt = 0

  return async function observe(input: { text: string; agent: string }): Promise<void> {
    if (!cfg.enabled) return
    const startedAt = now()
    const query = toQuery(input.text, cfg.queryMaxChars)
    if (query === '') {
      deps.writer.write({
        ts: new Date(startedAt).toISOString(),
        agent: input.agent,
        query: '',
        outcome: 'empty',
        ms: 0,
        hits: 0,
        wouldInject: [],
        chars: 0,
      })
      return
    }
    if (shouldThrottle(lastAt, startedAt, cfg.minIntervalMs)) {
      deps.writer.write({
        ts: new Date(startedAt).toISOString(),
        agent: input.agent,
        query,
        outcome: 'throttled',
        ms: 0,
        hits: 0,
        wouldInject: [],
        chars: 0,
      })
      return
    }
    lastAt = startedAt

    const controller = new AbortController()
    // 超时必须由观察器自己保证：检索层万一不理会 signal，await 会永远挂着，
    // 后面每条消息的观测就全废了。所以用 race 主动放弃（同时仍 abort，让下游能提前收工）。
    const TIMEOUT = Symbol('shadow-timeout')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(TIMEOUT)
      }, cfg.timeoutMs)
    })
    let result: { hits: readonly ShadowHit[]; note: string } | typeof TIMEOUT
    try {
      result = await Promise.race([deps.search(query, controller.signal), timeout])
    } catch (error) {
      deps.writer.write({
        ts: new Date(startedAt).toISOString(),
        agent: input.agent,
        query,
        outcome: 'error',
        ms: now() - startedAt,
        hits: 0,
        wouldInject: [],
        chars: 0,
        note: String(error instanceof Error ? error.message : error).slice(0, 120),
      })
      return
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (result === TIMEOUT) {
      deps.writer.write({
        ts: new Date(startedAt).toISOString(),
        agent: input.agent,
        query,
        outcome: 'timeout',
        ms: now() - startedAt,
        hits: 0,
        wouldInject: [],
        chars: 0,
      })
      return
    }

    const wouldInject = pickInjection(result.hits, cfg.maxItems, cfg.maxChars)
    const chars = wouldInject.reduce((sum, item) => sum + item.chars, 0)
    const outcome: ShadowOutcome =
      result.hits.length === 0 ? 'no_match' : result.note === 'low_confidence' ? 'low_confidence' : 'ok'
    deps.writer.write({
      ts: new Date(startedAt).toISOString(),
      agent: input.agent,
      query,
      outcome,
      ms: now() - startedAt,
      hits: result.hits.length,
      wouldInject,
      chars,
    })
  }
}
