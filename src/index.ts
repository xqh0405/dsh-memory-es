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

import { Config, personalIndexName, validateConfig, type ConfigType } from './config.ts'
import { createEmbedder } from './embedding.ts'
import { createEsClient } from './es/http.ts'
import { defineSaveTool } from './memory/save.ts'
import { MEMORY_PROMPT_SECTION, MOOD_SECTION_NAME, MOOD_SECTION_ORDER } from './prompt.ts'
import { applyMoodEvent, NEUTRAL_MOOD, renderMoodLine, type MoodEventKind, type MoodState } from './mood.ts'
import { classifyUserMessage, extractUserText, MoodEventThrottle } from './mood-events.ts'
import { readMood, writeMood } from './memory/mood.ts'
import { defineTraitsTool, TRAITS_SYSTEM } from './memory/traits.ts'
import { defineReviewTool } from './memory/review.ts'
import { collectStream, pickRoute } from './memory/distillRunner.ts'
import { defineDistillTool } from './memory/distill.ts'
import { runDistillJob } from './memory/distillRunner.ts'
import { definePromoteTool } from './memory/promote.ts'
import { defineDocSearchTool } from './memory/doc-search.ts'
import { defineSearchTool } from './memory/search.ts'
import { defineStatusTool } from './memory/status.ts'

export { Config }
export type { ConfigType }

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
  const summarizeTraits = async (prompt: string): Promise<string> => {
    const llm = getLlm() as {
      prepareCall?: (opts: unknown, signal: AbortSignal) => Promise<{ config: unknown; stream: (opts: unknown) => AsyncIterable<unknown> }>
      listModels?: (provider?: string) => unknown[]
    } | null
    if (llm === null || llm === undefined || typeof llm.prepareCall !== 'function') return ''
    const route = pickRoute(llm as never, config.distill.provider, config.distill.model, undefined)
    if (route === null) return ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const call = await llm.prepareCall({ ...route, maxTokens: 1500 }, controller.signal)
      const stream = call.stream({
        ...(call.config as Record<string, unknown>),
        system: TRAITS_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        purpose: 'memory-traits',
        signal: controller.signal,
      })
      return await collectStream(stream)
    } catch (err) {
      logger.warn('traits: 模型调用失败 %s', String(err).slice(0, 160))
      return ''
    } finally {
      clearTimeout(timer)
    }
  }

  /** 阶段 7.3：采纳闸门。pending 的 identity 只有过这里才会生效。 */
  ctx.effect(
    () =>
      ctx.tools.register(
        defineReviewTool({
          userId,
          personalPrefix,
          auditIndex: config.index.audit,
          reader,
          writer,
          now: () => new Date(),
          log: (event) => logger.info('review %o', event),
        }),
      ),
    'dsh-memory-es.review',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTraitsTool({
          userId,
          personalPrefix,
          reader,
          writer,
          now: () => new Date(),
          summarize: summarizeTraits,
          log: (event) => logger.info('traits %o', event),
        }),
      ),
    'dsh-memory-es.traits',
  )

  ctx.effect(() => ctx.systemPrompt.section(MEMORY_PROMPT_SECTION), 'dsh-memory-es.prompt')

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
    'ready: user=%s index=%s team=%s embed=%s@%s',
    config.identity.userId,
    personalIndexName(config),
    config.index.team,
    config.embedding.model,
    config.embedding.url,
  )
}
