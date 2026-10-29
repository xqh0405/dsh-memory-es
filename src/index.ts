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
import { MEMORY_PROMPT_SECTION } from './prompt.ts'
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

  ctx.effect(() => ctx.systemPrompt.section(MEMORY_PROMPT_SECTION), 'dsh-memory-es.prompt')

  logger.info(
    'ready: user=%s index=%s team=%s embed=%s@%s',
    config.identity.userId,
    personalIndexName(config),
    config.index.team,
    config.embedding.model,
    config.embedding.url,
  )
}
