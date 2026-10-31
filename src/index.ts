/**
 * dsh-memory-es —— Elasticsearch 双层记忆库插件的 Node 端入口。
 *
 * 当前进度（S1~S3）：配置 fail-fast → 建读/写两个 ES 客户端 → 建 embedder →
 * 注册 `memory_save`。检索（S4）、状态变更（S5）、系统提示与文案打磨（S6）随后接。
 *
 * 失败边界：配置非法或客户端建不起来时，只让**本插件**加载失败（Cordis 隔离单个插件的
 * apply 异常），不影响 dsh 其他插件。
 *
 * @module dsh-memory-es
 */

import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt'

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Config, personalIndexName, validateConfig, type ConfigType } from './config.ts'
import { createEmbedder } from './embedding.ts'
import { createEsClient } from './es/http.ts'
import { defineSaveTool } from './memory/save.ts'
import {
  dateKey,
  defineJournalTool,
  maybeRunDailyJournal,
} from './journal.ts'
import { definePersonaTool, loadActivePersona, type PersonaDeps } from './memory/persona.ts'
import { buildPersonaSection, buildStickersSection, MEMORY_PROMPT_SECTION, MOOD_SECTION_NAME, MOOD_SECTION_ORDER, parseStickerPack, PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER, STICKERS_SECTION_NAME, STICKERS_SECTION_ORDER, type StickerPack } from './prompt.ts'
import { applyMoodEvent, NEUTRAL_MOOD, renderMoodLine, type MoodEventKind, type MoodState } from './mood.ts'
import { classifyUserMessage, extractUserText, MoodEventThrottle } from './mood-events.ts'
import { readMood, writeMood } from './memory/mood.ts'
import { defineTraitsTool, runTraitsJob, TRAITS_SYSTEM } from './memory/traits.ts'
import { defineReviewTool } from './memory/review.ts'
import { defineHistoryTool } from './memory/history.ts'
import { collectStream, pickRoute } from './memory/distillRunner.ts'
import { defineDistillTool } from './memory/distill.ts'
import { runDistillJob } from './memory/distillRunner.ts'
import { definePromoteTool } from './memory/promote.ts'
import { defineDocSearchTool } from './memory/doc-search.ts'
import { defineSearchTool } from './memory/search.ts'
import { defineStatusTool } from './memory/status.ts'
import { readVersion } from './version.ts'

export { Config }
export type { ConfigType }

/** 版本号唯一来源是 package.json（见 version.ts 的注释）；`ready` 日志会打出来 */
const PLUGIN_VERSION = readVersion(import.meta.url)

type Context = CordisContext & {
  tools: ToolRegistry
  systemPrompt: SystemPrompt
}

export const name = 'dsh-memory-es'

/**
 * 依赖的服务：tools（注册工具）、systemPrompt（注入用法约定）。
 *
 * 模型服务 `ctx.get('llm')` 在**运行时按需取**、不写进 inject：
 * cordis 的 inject 是"缺了就 pending"的硬依赖，把 llm 写进去等于"没有模型就不加载插件"，
 * 而蒸馏只是增强功能 —— 拿不到 llm 就该降级为 pending 条目不蒸馏，不能连记忆工具一起没了。
 * （inject 只认数组或 "服务名 → 配置" 的映射；写成 {required, optional} 会被当成两个服务名，
 *   实测会 pending：waiting for services: required, optional。）
 */
export const inject = ['tools', 'systemPrompt']

/** embedding 冷启动实测约 2.2 s（首次加载模型），默认 15 s 足够 */
const EMBEDDING_TIMEOUT_MS = 15_000

export function apply(ctx: Context, config: ConfigType): void {
  const problems = validateConfig(config)
  if (problems.length > 0) {
    throw new Error(`dsh-memory-es: 配置非法，插件不加载\n  - ${problems.join('\n  - ')}`)
  }

  const logger = ctx.logger('dsh-memory-es')

  // 身份两种模式（2026-10-26）：
  //  · 单账号（推荐）：一人一个 ES 账号，个人库读写都由它承担，团队库权限交给角色；
  //  · 旧的三账号：reader 只读、writer 唯一写入口。
  // 单账号优先，缺了才回落到旧的读/写两个身份。
  const singleAccount =
    config.identity.username !== '' && config.identity.password !== ''
      ? { username: config.identity.username, password: config.identity.password }
      : null
  const readerCredential = singleAccount ?? {
    username: config.identity.readUsername,
    password: config.identity.readPassword,
  }
  const writerCredential = singleAccount ?? {
    username: config.identity.writerUsername,
    password: config.identity.writerPassword,
  }

  const reader = createEsClient({
    url: config.es.url,
    caCertPath: config.es.caCertPath,
    requestTimeoutMs: config.es.requestTimeoutMs,
    username: readerCredential.username,
    password: readerCredential.password,
  })
  const writer = createEsClient({
    url: config.es.url,
    caCertPath: config.es.caCertPath,
    requestTimeoutMs: config.es.requestTimeoutMs,
    username: writerCredential.username,
    password: writerCredential.password,
  })
  const embed = createEmbedder({
    url: config.embedding.url,
    model: config.embedding.model,
    dims: config.embedding.dims,
    timeoutMs: EMBEDDING_TIMEOUT_MS,
  })

  const distillEnabled = config.distill.enabled
  // 运行时再取：llm 可能此刻还没就绪，也可能整套部署根本没配模型
  const getLlm = (): unknown => {
    try {
      return (ctx as unknown as { get?: (name: string) => unknown }).get?.('llm') ?? null
    } catch {
      return null
    }
  }
  const userId = config.identity.userId
  const personalPrefix = config.index.personalPrefix

  ctx.effect(
    () =>
      ctx.tools.register(
        defineSaveTool({
          userId,
          personalPrefix,
          defaultDomain: config.defaults.domain,
          reader,
          writer,
          embed,
          // 阶段 5.2：写入时建边（只写 related，不改检索；失败只记日志）
          edges: {
            enabled: config.edges.enabled,
            topK: config.edges.topK,
            minScore: config.edges.minScore,
            maxScore: config.edges.maxScore,
            dims: config.embedding.dims,
          },
          log: (event) => logger.info('save %o', event),
          // 入库后立刻返回，蒸馏在后台跑；失败只记日志，条目留在 distill_state=pending
          onSaved: ({ memoryId, content, domain, route }) => {
            if (!distillEnabled) return
            void runDistillJob(
              {
                userId,
                personalPrefix,
                reader,
                writer,
                embed,
                llm: getLlm() as never,
                provider: config.distill.provider,
                model: config.distill.model,
                timeoutMs: config.distill.timeoutMs,
                log: (event) => logger.info('distill-run %o', event),
              },
              { memoryId, content, domain, route },
            )
          },
        }),
      ),
    'dsh-memory-es.save',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineSearchTool({
          userId,
          personalPrefix,
          teamIndex: config.index.team,
          reader,
          embed,
          dims: config.embedding.dims,
          retrieval: config.retrieval,
          confidence: config.confidence,
          ranking: config.ranking,
          // 阶段 6.3：情绪一致召回读当前心情（同步读缓存，不额外打 ES）
          mood: () => mood.state,
          hitRecorder: writer,
          // 检索埋点（P1）：写 search_log_<uid>。权限没开时 index 会 403，
          // search.ts 内部降级为只打日志，检索结果不受影响。
          recorder: writer,
          searchLogIndex: `${config.index.searchLogPrefix}${userId}`,
          log: (event) => logger.info('search %o', event),
        }),
      ),
    'dsh-memory-es.search',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineDocSearchTool({
          userId,
          docPrefix: config.index.docPrefix,
          reader,
          embed,
          dims: config.embedding.dims,
          retrieval: config.retrieval,
          log: (event) => logger.info('doc_search %o', event),
        }),
      ),
    'dsh-memory-es.doc-search',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineStatusTool({
          userId,
          personalPrefix,
          reader,
          writer,
          log: (event) => logger.info('status %o', event),
        }),
      ),
    'dsh-memory-es.status',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        definePromoteTool({
          userId,
          personalPrefix,
          reader,
          writer,
          log: (event) => logger.info('promote %o', event),
        }),
      ),
    'dsh-memory-es.promote',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineDistillTool({
          userId,
          personalPrefix,
          reader,
          writer,
          embed,
          log: (event) => logger.info('distill %o', event),
        }),
      ),
    'dsh-memory-es.distill',
  )

  /**
   * 阶段 7.2：夜间提炼（手动触发）。
   *
   * 模型调用在这里组装而不是放进 traits.ts：那边不 import 宿主 llm 类型，便于单测；
   * 拿不到模型时 summarize 返回空串，提炼自然产出零候选（不报错、不写垃圾）。
   */
  const summarizeTraits = async (prompt: string, system: string = TRAITS_SYSTEM): Promise<string> => {
    const llm = getLlm() as {
      prepareCall?: (opts: unknown, signal: AbortSignal) => Promise<{ config: unknown; stream: (opts: unknown) => AsyncIterable<unknown> }>
      listModels?: (provider?: string) => unknown[]
    } | null
    if (llm === null || llm === undefined) return '[诊断] 拿不到 llm 服务（ctx.get("llm") 返回空）'
    if (typeof (llm as { prepareCall?: unknown }).prepareCall !== 'function') {
      return `[诊断] llm 没有 prepareCall（实际类型 ${typeof llm}，字段 ${Object.keys(llm as object).slice(0, 8).join(',') || '空'}）`
    }
    const route = await pickRoute(llm as never, config.distill.provider, config.distill.model, undefined)
    if (route === null) return '[诊断] 选不到模型路由（listModels 为空或 provider/model 字段不符合预期）'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      // 上面已确认是函数；这里显式取出来，避免 TS 的 possibly-undefined
      const prepareCall = (llm as { prepareCall: (cfg: unknown, sig: AbortSignal) => Promise<{ config: unknown; stream: (o: unknown) => AsyncIterable<unknown> }> }).prepareCall.bind(llm)
      // 8000：推理模型（mimo 这类）会先花大量 token 在 reasoning 上；
      // 1500 时正文为空，3000 时正文被截断（JSON 解析失败），实测都不够。
      const call = await prepareCall({ ...route, maxTokens: 8000 }, controller.signal)
      const stream = call.stream({
        ...(call.config as Record<string, unknown>),
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        purpose: 'memory-traits',
        signal: controller.signal,
      })
      // 推理模型（如 mimo-v2.6-flash）可能只发 reasoning-delta、正文为空，
      // 所以两路都收：正文优先，正文为空时回落到推理内容（答案常在推理末尾）。
      let text = ''
      let reasoning = ''
      const kinds = new Map<string, number>()
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        const rec = chunk as Record<string, unknown>
        const kind = typeof rec.type === 'string' ? rec.type : 'unknown'
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
        if (typeof rec.text !== 'string') continue
        if (kind === 'text-delta') text += rec.text
        else if (kind === 'reasoning-delta') reasoning += rec.text
      }
      if (text.trim() !== '') return text
      if (reasoning.trim() !== '') return reasoning
      const stat = [...kinds.entries()].map(([k, v]) => `${k}×${v}`).join(' ') || '(流为空)'
      return `[诊断] 正文与推理都为空｜${stat}`
    } catch (err) {
      logger.warn('traits: 模型调用失败 %s', String(err).slice(0, 160))
      return `[诊断] 模型调用抛错：${String(err).slice(0, 140)}`
    } finally {
      clearTimeout(timer)
    }
  }

  /** 阶段 7.4：版本链与回滚（沿 supersedes / superseded_by 双向走）。 */
  ctx.effect(
    () =>
      ctx.tools.register(
        defineHistoryTool({
          userId,
          personalPrefix,
          reader,
          writer,
          now: () => new Date(),
          log: (event) => logger.info('history %o', event),
        }),
      ),
    'dsh-memory-es.history',
  )

  /** 阶段 7.3：采纳闸门。pending 的 identity 只有过这里才会生效。 */
  ctx.effect(
    () =>
      ctx.tools.register(
        defineReviewTool({
          userId,
          personalPrefix,
          auditIndex: config.index.audit,
          auditPrefix: config.index.auditPrefix,
          reader,
          writer,
          now: () => new Date(),
          log: (event) => logger.info('review %o', event),
        }),
      ),
    'dsh-memory-es.review',
  )

  /** 提炼依赖：工具与「每天自动跑」共用一份，避免两处参数漂移 */
  const traitsDeps = {
    userId,
    personalPrefix,
    reader,
    writer,
    // 判重与候选向量都靠它；embedding 挂了只跳过判重，不影响提炼与写入
    embed,
    dims: config.embedding.dims,
    now: () => new Date(),
    summarize: summarizeTraits,
    log: (event: Record<string, unknown>) => logger.info('traits %o', event),
  }

  ctx.effect(() => ctx.tools.register(defineTraitsTool(traitsDeps)), 'dsh-memory-es.traits')

  /**
   * 阶段 9.6：每天自动提炼一次用户画像（等价于替你跑 `memory_traits dry_run=false`）。
   *
   * 产物仍是 pending 候选——自动做的只是"归纳"，"采纳"依然要人点，行为不会自己变。
   * 「今天跑过没」用进程内标记：重启当天可能重跑一次，代价是多一次判重（kNN 会跳过
   * 与已有自述同义的），换来的是不需要在 ES 里多维护一张状态表。
   */
  if (config.traits.enabled) {
    let lastRunDate = ''
    const runTraitsDaily = (): void => {
      const now = new Date()
      const today = dateKey(now)
      if (lastRunDate === today) return
      const [hh, mm] = config.traits.at.split(':').map((part) => Number.parseInt(part, 10))
      const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 2, mm || 30, 0, 0)
      if (now.getTime() < due.getTime()) return
      lastRunDate = today
      logger.info('traits: 到点自动提炼（回看 %d 天）', config.traits.days)
      runTraitsJob(traitsDeps, {
        days: config.traits.days,
        summarize: (prompt) => summarizeTraits(prompt),
      })
        .then((result) => {
          logger.info(
            'traits: 完成 sources=%d candidates=%d written=%d duplicates=%d skipped=%s',
            result.sources,
            result.candidates,
            result.written,
            result.duplicates,
            result.skipped ?? '',
          )
        })
        .catch((err: unknown) => {
          // 放开标记让下一个整点重试；不抛到定时器外面
          lastRunDate = ''
          logger.warn('traits: 自动提炼失败 %s', String(err).slice(0, 160))
        })
    }
    ctx.effect(() => {
      const timer = setInterval(runTraitsDaily, 60 * 60_000)
      timer.unref?.()
      const kick = setTimeout(runTraitsDaily, 90_000)
      kick.unref?.()
      return () => {
        clearInterval(timer)
        clearTimeout(kick)
      }
    }, 'dsh-memory-es.traits-daily')
  }

  ctx.effect(() => ctx.systemPrompt.section(MEMORY_PROMPT_SECTION), 'dsh-memory-es.prompt')

  /**
   * 阶段 9.1 + 9.3：人格段 = 内核 seed + 已生效的表层条目。
   *
   * `text` 必须是同步函数（宿主组装提示词时调用），而条子在 ES 里 → 用内存缓存：
   * 启动读一次、之后每 5 分钟刷新一次（approve 后最迟 5 分钟内进提示）。
   * 刷新失败只记日志，保留上一次的缓存——不能因为 ES 抖一下就把人格段清空。
   */
  const personaDeps: PersonaDeps = {
    userId,
    personalPrefix,
    reader,
    writer,
    embed,
    dims: config.embedding.dims,
    now: () => new Date(),
    log: (event) => logger.info('persona %o', event),
  }
  const personaCache: { entries: string[] } = { entries: [] }
  const refreshPersona = (): void => {
    loadActivePersona(personaDeps, 12)
      .then((list) => {
        personaCache.entries = list
      })
      .catch((err: unknown) => {
        logger.warn('persona: 读 active 条目失败，沿用上次缓存 %s', String(err).slice(0, 120))
      })
  }
  refreshPersona()
  ctx.effect(() => {
    const timer = setInterval(refreshPersona, 5 * 60_000)
    // 不让定时器吊住进程退出
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-memory-es.persona-refresh')

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_SECTION_NAME,
        order: PERSONA_SECTION_ORDER,
        text: () => buildPersonaSection(config.persona.seed, config.persona.enabled, personaCache.entries),
      }),
    'dsh-memory-es.persona',
  )

  /** 阶段 9.3：从会话记录里归纳「我自己的倾向」，默认干跑，写入 pending 等审核。 */
  ctx.effect(
    () =>
      ctx.tools.register(
        definePersonaTool({
          ...personaDeps,
          summarize: summarizeTraits,
        }),
      ),
    'dsh-memory-es.persona-tool',
  )

  /**
   * 阶段 9.5：每日回顾（「日记」里的回顾栏）。
   *
   * 每小时醒一次，判断「今天过点了没、写过没」——比精确 cron 简单且够用：
   * 日记晚几分钟出来没人在意，漏跑一天才在意。少于 JOURNAL_MIN_TURNS 轮对话直接跳过，
   * 免得为一个空白的日子白花一次模型调用。
   */
  if (config.journal.enabled) {
    const journalDeps = {
      userId,
      personalPrefix,
      reader,
      writer,
      now: () => new Date(),
      log: (event: Record<string, unknown>) => logger.info('journal %o', event),
      summarize: (prompt: string, system: string) => summarizeTraits(prompt, system),
      at: config.journal.at,
    }
    const runJournal = (): void => {
      maybeRunDailyJournal(journalDeps)
        .then((result) => {
          if (result.ran) {
            logger.info('journal: 已写入 %s（%d 字）', result.date, result.chars ?? 0)
          } else if (result.reason !== 'not-due' && result.reason !== 'already-done') {
            logger.info('journal: 跳过（%s）', result.reason)
          }
        })
        .catch((err: unknown) => logger.warn('journal: 失败 %s', String(err).slice(0, 160)))
    }
    ctx.effect(() => {
      // 检查粒度必须**细于「从 due 到下一次整点」这段窗口**：默认 due=23:30，
      // 下一个整点是 00:00——那天已经变了，`maybeRunDailyJournal` 只会去判断
      // 「新的一天 23:30 还没到」，于是**当天的回顾永远不写**（2026-10-31 巡检发现的死循环：
      // 进程 17:29 启动 → 23:29 差一分钟、00:29 已跨天）。
      // 5 分钟一次：不到点直接 return（零 ES 请求）；到点后最多晚 5 分钟写。
      const timer = setInterval(runJournal, 5 * 60_000)
      timer.unref?.()
      // 启动 1 分钟后先探一次：万一是跨天重启，别等到下一个检查点才补
      const kick = setTimeout(runJournal, 60_000)
      kick.unref?.()
      return () => {
        clearInterval(timer)
        clearTimeout(kick)
      }
    }, 'dsh-memory-es.journal-daily')

    ctx.effect(
      () => ctx.tools.register(defineJournalTool({ journal: () => journalDeps })),
      'dsh-memory-es.journal-tool',
    )
  }

  /**
   * 阶段 9.2：表情包。
   *
   * 只读**一次**（apply 时）：图片与定义都在包外，改完要重启/重载才生效。
   * 读不到就当作没有表情包——目录缺失是常态（图片不进仓库），不能因此报错或刷日志。
   */
  const stickerPack: StickerPack | null = readStickerPack(config.stickers.dir)
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: STICKERS_SECTION_NAME,
        order: STICKERS_SECTION_ORDER,
        text: () => buildStickersSection(stickerPack, config.stickers.maxPerTurn, config.stickers.enabled),
      }),
    'dsh-memory-es.stickers',
  )

  /**
   * 阶段 6.2：情绪状态。
   *
   * 段文本必须是**同步**函数（宿主组装提示词时调用），而状态存在 ES 里（异步），
   * 所以用一份内存缓存：启动读一次、每次写入后刷新。衰减在渲染时按纯函数算，
   * 不需要定时器。
   */
  const mood: { state: MoodState } = { state: { ...NEUTRAL_MOOD } }
  const moodStore = {
    userId: config.identity.userId,
    personalPrefix: config.index.personalPrefix,
    reader,
    writer,
    log: (event: Record<string, unknown>) => logger.info('mood %o', event),
  }
  // 放到下一个 tick：加载阶段一律零 ES 请求（apply 的既有契约），也避免测试里
  // 「apply 期间不应发请求」的断言变脆。
  setTimeout(() => {
    void readMood(moodStore)
      .then((state) => {
        mood.state = state
      })
      .catch((err: unknown) => {
        logger.warn('mood: 启动读取失败，先按中性态运行 %s', String(err).slice(0, 160))
      })
  }, 0)

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: MOOD_SECTION_NAME,
        order: MOOD_SECTION_ORDER,
        // 平静时返回空串：宿主会把空段丢掉，等于不注入
        text: () => renderMoodLine(mood.state, new Date()),
      }),
    'dsh-memory-es.mood',
  )

  /**
   * 阶段 6.4：事件驱动。
   *
   * 「只由事件改」的落点——模型说「我很高兴」不产生任何副作用，
   * 只有用户明确夸奖/批评、工具成功/失败才会推状态。
   * 写回串行化：并发事件读改写会丢更新，用一条 Promise 链排队。
   */
  const moodThrottle = new MoodEventThrottle()
  let moodChain: Promise<void> = Promise.resolve()
  // 自己这几个工具的结果不推动情绪：它们说的是「记忆库通不通」，不是「世界对我好不好」
  const IGNORED_TOOLS = new Set(['memory_save', 'memory_search', 'memory_update_status', 'memory_promote', 'memory_distill', 'doc_search'])

  const pushMoodEvent = (kind: MoodEventKind, note: string, key: string): void => {
    if (!moodThrottle.allow(key, Date.now())) return
    moodChain = moodChain
      .then(async () => {
        const next = applyMoodEvent(mood.state, kind, new Date(), note)
        mood.state = next
        try {
          await writeMood(moodStore, next)
        } catch (err) {
          logger.warn('mood: 写回失败 %s', String(err).slice(0, 160))
        }
      })
      .catch(() => {})
  }

  ctx.effect(
    () =>
      ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: { id: string }; message: unknown }) => {
        const signal = classifyUserMessage(extractUserText(message))
        if (signal === null) return
        pushMoodEvent(signal.kind, signal.note, `agent:${String(agent?.id ?? 'default')}`)
      }),
    'dsh-memory-es.mood-user',
  )

  ctx.effect(
    () =>
      ctx.on(
        'tools/result',
        (exec: { name: string; agent?: { id: string } }, result: { isError?: boolean }) => {
          if (IGNORED_TOOLS.has(exec.name)) return
          const key = `tool:${String(exec.agent?.id ?? 'root')}`
          pushMoodEvent(
            result.isError === true ? 'tool_error' : 'tool_ok',
            result.isError === true ? '工具失败' : '工具成功',
            key,
          )
        },
      ),
    'dsh-memory-es.mood-tool',
  )

  logger.info(
    'ready: v%s user=%s index=%s team=%s embed=%s@%s',
    PLUGIN_VERSION,
    config.identity.userId,
    personalIndexName(config),
    config.index.team,
    config.embedding.model,
    config.embedding.url,
  )
}

/** 把 `~` / `~/x` 展开成家目录（配置里写相对家目录比写绝对路径更可移植） */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * 读表情包定义（阶段 9.2）。读不到就返回 null——**不抛错、不刷日志**：
 * 图片不进仓库，多数部署一开始就没有这个目录，那是正常状态而不是故障。
 */
export function readStickerPack(dir: string): StickerPack | null {
  const resolved = expandHome(dir)
  try {
    const json = readFileSync(join(resolved, 'stickers.json'), 'utf8')
    return parseStickerPack(json, resolved)
  } catch {
    return null
  }
}
