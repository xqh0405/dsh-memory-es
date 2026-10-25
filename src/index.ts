/**
 * dsh-memory-es —— Elasticsearch 双层记忆库插件的 Node 端入口。
 *
 * S1 阶段只落骨架：Config + apply。工具（memory_save / memory_search /
 * memory_update_status / memory_promote）在 S3~S5 接入，系统提示片段在
 * 工具可用之后再挂（否则会诱导模型调用不存在的工具）。
 *
 * @module dsh-memory-es
 */

import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

type Context = CordisContext & {
  tools: ToolRegistry
  systemPrompt: SystemPrompt
}

export const name = 'dsh-memory-es'

/** 依赖的服务：tools（注册工具）、systemPrompt（注入用法约定） */
export const inject = ['tools', 'systemPrompt']

export interface Config {
  es: {
    url: string
    caCertPath: string
    requestTimeoutMs: number
  }
  index: {
    personalPrefix: string
    team: string
  }
  identity: {
    userId: string
    readUsername: string
    readPassword: string
    writerUsername: string
    writerPassword: string
  }
  embedding: {
    url: string
    model: string
    dims: number
  }
  retrieval: {
    topK: number
    rrfK: number
    marginFloor: number
    limit: number
  }
}

export const Config: z<Config> = z.object({
  es: z.object({
    url: z.string().default('https://127.0.0.1:9200')
      .description('ES 地址；只绑回环，不要对公网开 9200。'),
    caCertPath: z.string().default('deploy/es/certs/ca.crt')
      .description('自签 CA 证书路径（PEM），用于校验 ES 的 HTTPS 证书。'),
    requestTimeoutMs: z.number().step(1).min(500).default(8_000)
      .description('单次 ES 请求超时（毫秒）。'),
  }),
  index: z.object({
    personalPrefix: z.string().default('personal_memory_')
      .description('个人索引前缀；实际索引 = 前缀 + identity.userId（一人一索引）。'),
    team: z.string().default('team_knowledge')
      .description('团队知识库索引名。'),
  }),
  identity: z.object({
    userId: z.string()
      .description('必填：本次部署代表哪个用户（对应 personal_memory_<id> 索引名）。'),
    readUsername: z.string().default('mem-reader-xqh')
      .description('只读身份的用户名（DLS 替代方案：一人一索引 + 索引级 ACL）。'),
    readPassword: z.string().default('')
      .description('只读身份的密码；建议从环境变量注入，不要写进配置文件。'),
    writerUsername: z.string().default('mem-writer')
      .description('写身份的用户名（唯一写入口）。'),
    writerPassword: z.string().default('')
      .description('写身份的密码；同样建议用环境变量。'),
  }),
  embedding: z.object({
    url: z.string().default('http://127.0.0.1:11434')
      .description('embedding 服务地址（本机 Ollama）。'),
    model: z.string().default('bge-m3')
      .description('embedding 模型；换模型必须重建索引（dims 不可原地改）。'),
    dims: z.number().step(1).default(1024)
      .description('向量维度，必须与索引 mapping 一致。'),
  }),
  retrieval: z.object({
    topK: z.number().step(1).default(20)
      .description('每一路（BM25 / kNN）取的候选数。'),
    rrfK: z.number().step(1).default(60)
      .description('RRF 融合常数。'),
    marginFloor: z.number().default(0.05)
      .description('kNN 原始 cosine 分数的 top1-top2 差值下限，低于它判为“低置信”。'),
    limit: z.number().step(1).default(8)
      .description('返回给模型的最大条数。'),
  }),
})

export function apply(ctx: Context, config: Config): void {
  // S1：只做配置解析与 fail-fast。工具与系统提示在后续步骤接入（docs/开发文档.md §16）。
  // 配置缺失就在这里抛出——只会让本插件加载失败，不影响 dsh 其他插件（M2 判据）。
  if (!config.identity.userId) {
    throw new Error('dsh-memory-es: identity.userId 是必填项（本次部署代表哪个用户）')
  }
  if (config.identity.readPassword === '' || config.identity.writerPassword === '') {
    throw new Error('dsh-memory-es: identity.readPassword / writerPassword 未配置')
  }

  void ctx
}
