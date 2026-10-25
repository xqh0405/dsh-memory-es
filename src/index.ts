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

import { Config, personalIndexName, validateConfig, type ConfigType } from './config.ts'
import { createEmbedder } from './embedding.ts'
import { createEsClient } from './es/http.ts'
import { defineSaveTool } from './memory/save.ts'
import { defineSearchTool } from './memory/search.ts'

export { Config }
export type { ConfigType }

type Context = CordisContext & {
  tools: ToolRegistry
}

export const name = 'dsh-memory-es'

/** 依赖的服务：tools（注册工具） */
export const inject = ['tools']

/** embedding 冷启动实测约 2.2 s（首次加载模型），默认 15 s 足够 */
const EMBEDDING_TIMEOUT_MS = 15_000

export function apply(ctx: Context, config: ConfigType): void {
  const problems = validateConfig(config)
  if (problems.length > 0) {
    throw new Error(`dsh-memory-es: 配置非法，插件不加载\n  - ${problems.join('\n  - ')}`)
  }

  const logger = ctx.logger('dsh-memory-es')

  // D2：读者身份只读、writer 唯一写入口。一个 client 一份凭证，不给按调用切换的口子。
  const reader = createEsClient({
    url: config.es.url,
    caCertPath: config.es.caCertPath,
    requestTimeoutMs: config.es.requestTimeoutMs,
    username: config.identity.readUsername,
    password: config.identity.readPassword,
  })
  const writer = createEsClient({
    url: config.es.url,
    caCertPath: config.es.caCertPath,
    requestTimeoutMs: config.es.requestTimeoutMs,
    username: config.identity.writerUsername,
    password: config.identity.writerPassword,
  })
  const embed = createEmbedder({
    url: config.embedding.url,
    model: config.embedding.model,
    dims: config.embedding.dims,
    timeoutMs: EMBEDDING_TIMEOUT_MS,
  })

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
          log: (event) => logger.info('search %o', event),
        }),
      ),
    'dsh-memory-es.search',
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
