/**
 * 插件配置（schemastery）。S3 从 `index.ts` 拆出来单独成文件：
 * 配置是一份契约，索引名与身份派生都从这里出发，别在调用点各拼一遍。
 *
 * 两条硬规则：
 *  · `identity.userId` 必填——F2 的注入源，缺失就**拒绝写入**，不写匿名（D3 一机一身份）；
 *  · 密码只从环境变量注入，配置里留空字符串，`validateConfig` 会拦。
 *
 * @module dsh-memory-es/config
 */

import z from '@deepseek-ai/schemastery'

// 置信阈值的唯一来源在 search.ts（实现与默认值放在一起，避免两处漂移）
import { DEFAULT_CONFIDENCE } from './memory/search.ts'
import { DEFAULT_RANKING } from './fragment.ts'

export interface ConfigType {
  es: {
    url: string
    caCertPath: string
    requestTimeoutMs: number
  }
  index: {
    personalPrefix: string
    /** 文档索引前缀；实际索引 = 前缀 + identity.userId（与记忆分开，见 README 文档入库方案） */
    docPrefix: string
    team: string
    /** 检索埋点前缀；实际索引 = 前缀 + identity.userId（只记查了什么/召回几条/耗时） */
    searchLogPrefix: string
  }
  identity: {
    userId: string
    /**
     * 单账号模式（推荐）：一个人的 ES 账号，个人库读写 + 团队库按 tier 授权。
     * 有它就优先使用，readUsername/writerUsername 等旧字段仅作兼容回落。
     */
    username: string
    password: string
    /** 该账号是否有团队库写权限（= 能不能审核）。false 时面板隐藏审核台 */
    teamWrite: boolean
    readUsername: string
    readPassword: string
    writerUsername: string
    writerPassword: string
    /** 整理/审核身份（对 team_knowledge 与 memory_audit 有写权限）；面板的审核动作要用 */
    consolidatorUsername: string
    consolidatorPassword: string
  }
  embedding: {
    url: string
    model: string
    dims: number
  }
  retrieval: {
    topK: number
    rrfK: number
    limit: number
  }
  /** 排序乘子（阶段 2） */
  ranking: {
    importanceWeight: number
    hitWeight: number
    recencyWeight: number
    recencyHalfLifeDays: number
    reinforcementPerHit: number
    reinforcementCap: number
    agreementBonus: number
    activationAlpha: number
    moodWeight: number
  }
  /** 置信判定：分层阈值，见 schema 处注释 */
  confidence: {
    floorTop1: number
    autoPassTop1: number
    minMargin: number
    minBm25: number
  }
  defaults: {
    domain: string
  }
  /** 写入时建边（阶段 5.2） */
  edges: {
    enabled: boolean
    topK: number
    minScore: number
    maxScore: number
  }
  distill: {
    /** 保存后是否后台蒸馏（不阻塞入库） */
    enabled: boolean
    /** 模型路由；留空 = 用宿主第一个可用模型 */
    provider: string
    model: string
    timeoutMs: number
  }
}

export const Config: z<ConfigType> = z.object({
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
    docPrefix: z.string().default('personal_doc_')
      .description('个人文档索引前缀；实际索引 = 前缀 + identity.userId。与记忆索引分开：文档是长文切片，记忆是一句事实。'),
    team: z.string().default('team_knowledge')
      .description('团队知识库索引名。'),
    searchLogPrefix: z.string().default('search_log_')
      .description('检索埋点索引前缀；实际索引 = 前缀 + identity.userId。只存"查了什么、召回几条、耗时多少"，用于每日巡检的空结果率与 P95；写失败静默降级，绝不影响检索。'),
  }),
  identity: z.object({
    userId: z.string()
      .description('必填：本次部署代表哪个用户（对应 personal_memory_<id> 索引名）。'),
    readUsername: z.string().default('mem-reader-xqh')
      .description('只读身份的用户名（D5：一人一索引 + 索引级 ACL）。'),
    readPassword: z.string().default('')
      .description('只读身份的密码；从环境变量注入，不要写进配置文件。'),
    writerUsername: z.string().default('mem-writer')
      .description('写身份的用户名（唯一写入口）。'),
    writerPassword: z.string().default('')
      .description('写身份的密码；同样用环境变量。'),
    consolidatorUsername: z.string().default('mem-consolidator')
      .description('整理/审核身份的用户名；面板的批准/驳回/撤回要用它（对团队库与审计库有写权限）。'),
    consolidatorPassword: z.string().default('')
      .description('整理身份的密码；留空则面板只提供只读功能（审核动作会提示未配置）。'),
    // 单账号模式：一人一个 ES 账号（mem-user-<uid>），个人库读写 + 团队库按 teamWrite 决定
    username: z.string().default(''),
    password: z.string().default(''),
    teamWrite: z.boolean().default(false),
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
    limit: z.number().step(1).default(8)
      .description('返回给模型的最大条数。'),
  }),
  /**
   * 置信判定（阶段 0.5）：分层规则，替代原来单一的 marginFloor。
   *
   * 为什么改：单一 margin 门槛在库变大后必然失效——候选池越大，top2 越贴近 top1。
   * 实测 268 条时 margin 中位数 0.0208，而旧门槛 0.05 让 30/30 查询全部返回空。
   *
   * 而且「低置信」不再等于「不返回」：返回结果 + 标注，让模型自己判断，
   * 比直接丢信息更好（丢信息的代价是模型以为没记过、转而凭印象编）。
   */
  confidence: z.object({
    floorTop1: z.number().default(DEFAULT_CONFIDENCE.floorTop1)
      .description('kNN 第一名 cosine 低于它 → 明显无关，判低置信。'),
    autoPassTop1: z.number().default(DEFAULT_CONFIDENCE.autoPassTop1)
      .description('kNN 第一名 cosine 达到它 → 直接放行，不再看 margin（绝对相似度已经够高）。'),
    minMargin: z.number().default(DEFAULT_CONFIDENCE.minMargin)
      .description('中间区：top1-top2 差值达到它 → 放行。'),
    minBm25: z.number().default(DEFAULT_CONFIDENCE.minBm25)
      .description('中间区：BM25 首条分数达到它 → 放行（关键词精确命中救回向量区分度不足的情况）。注意该阈值与语料规模相关，扩库后需重标定。'),
  }),
  /**
   * 排序乘子（阶段 2）：作用在跨库合并之后，三项都可归零关闭。
   * 默认值刻意温和（±10% 量级），importance 只是微调、不主导排序。
   */
  ranking: z.object({
    importanceWeight: z.number().default(DEFAULT_RANKING.importanceWeight)
      .description('importance 强度：0=关；1 表示 critical ×1.1 / low ×0.9。'),
    hitWeight: z.number().default(DEFAULT_RANKING.hitWeight)
      .description('命中次数强度：hitWeight × log1p(hit_count)/10。'),
    recencyWeight: z.number().default(DEFAULT_RANKING.recencyWeight)
      .description('时间新鲜度强度：recencyWeight × exp(-ageDays / halfLife)。'),
    recencyHalfLifeDays: z.number().default(DEFAULT_RANKING.recencyHalfLifeDays)
      .description('时间衰减半衰期（天）：memory_type 不在内置类型表里时的兜底。'),
    reinforcementPerHit: z.number().default(DEFAULT_RANKING.reinforcementPerHit)
      .description('每命中一次延长多少寿命比例（0 = 关闭）。内置类型表的半衰期会乘 (1 + min(cap, hit_count × 本值))。'),
    reinforcementCap: z.number().default(DEFAULT_RANKING.reinforcementCap)
      .description('强化封顶比例，避免老条目越用越不朽。'),
    agreementBonus: z.number().default(DEFAULT_RANKING.agreementBonus)
      .description('两路名次一致时的乘性加成（0.1 = 最多 +10%；0 = 关闭）。KK 融合只看名次，这个 bonus 补上「两路一致」这个信号。'),
    activationAlpha: z.number().default(DEFAULT_RANKING.activationAlpha)
      .description('阶段 5.3 扩散激活强度：score += alpha × Σ(邻居分 × 边权)。0 = 关闭；邻居只算本次结果集内的。'),
    moodWeight: z.number().default(DEFAULT_RANKING.moodWeight)
      .description('阶段 6.3 情绪一致召回：score × (1 + moodWeight × 相似度)。0 = 关闭；只提权不降权，未标 valence 的条目不参与。'),
  }),
  defaults: z.object({
    domain: z.string().default('general')
      .description('memory_save 未显式给 domain 时的缺省值；建议按项目填（如 lottery-cloud）。'),
  }),
  /**
   * 阶段 5.2：写入时给记忆建边。
   * 只写 `related` 字段、不改检索，所以默认开；`edges_failed` 只记日志，不影响保存。
   */
  edges: z.object({
    enabled: z.boolean().default(true)
      .description('写入时建边（只写 related，不改检索；失败不影响保存）。'),
    topK: z.number().default(5)
      .description('每条记忆最多保留几条边（邻接表上界）。'),
    minScore: z.number().default(0.55)
      .description('低于该相似度不建边（kNN 永远会返回 topK，低频段基本是噪声）。'),
    maxScore: z.number().default(0.85)
      .description('大于等于该相似度视为重复（判重带），不建边。'),
  }),
  distill: z.object({
    // 默认关闭：蒸馏要花 token，等用户在看板上明确打开（2026-10-26 用户定的）
    enabled: z.boolean().default(false),
    provider: z.string().default(''),
    model: z.string().default(''),
    timeoutMs: z.number().default(30_000),
  }),
})

/** 个人索引名的唯一派生点（一人一索引，D5） */
export function personalIndexName(config: Pick<ConfigType, 'index' | 'identity'>): string {
  return `${config.index.personalPrefix}${config.identity.userId}`
}

/**
 * 配置自检。返回**问题列表**而不是抛错：调用方（apply）拼成一条消息抛出，
 * 测试可以直接断言列表内容。空数组 = 通过。
 */
export function validateConfig(config: ConfigType): string[] {
  const problems: string[] = []
  if (!config.identity.userId || config.identity.userId.trim() === '') {
    problems.push('identity.userId 是必填项（本次部署代表哪个用户）')
  }
  // 两种身份模式：单账号（推荐，一人一个 ES 账号）或旧的三账号。
  const single = config.identity.username !== '' && config.identity.password !== ''
  if (!single) {
    if (config.identity.readPassword === '') {
      problems.push(
        'identity.readPassword 未配置；或改用单账号模式（identity.username + identity.password）',
      )
    }
    if (config.identity.writerPassword === '') {
      problems.push('identity.writerPassword 未配置（同上）')
    }
    if (config.identity.readUsername === config.identity.writerUsername) {
      problems.push('读/写身份不能是同一个用户（D2：读者只读、writer 唯一写入口）')
    }
  } else if (config.identity.teamWrite && config.identity.userId === '') {
    problems.push('teamWrite=true 需要 identity.userId（审计要记人）')
  }
  if (!Number.isInteger(config.embedding.dims) || config.embedding.dims < 1) {
    problems.push(`embedding.dims 必须是正整数（当前 ${String(config.embedding.dims)}）`)
  }
  return problems
}
