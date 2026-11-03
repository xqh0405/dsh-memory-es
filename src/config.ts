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

import { readFileSync } from 'node:fs'

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
    /** 共享审计索引（团队库操作；只有 teamWrite 能写） */
    audit: string
    /** 个人审计索引前缀（实际索引 = 前缀 + userId） */
    auditPrefix: string
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
  prompt: {
    /** 阶段 12：引用格式要求（默认关） */
    citation: boolean
  }
  retrieval: {
    topK: number
    rrfK: number
    limit: number
    /** 阶段 12：同一 domain 最多几条（0 = 关闭） */
    maxPerDomain: number
    /** 阶段 12：缺省详略（full / summary） */
    defaultDetail: string
  }
  /** 排序乘子（阶段 2） */
  ranking: {
    /** 阶段 12：效用信号强度（0 = 关闭） */
    utilityWeight: number
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
  /** 阶段 9：写入准入屏障（凭据 / 检索原文再摄取 → 隔离待审） */
  admission: {
    enabled: boolean
    similarEnabled: boolean
    similarScore: number
    recentMax: number
    recentTtlMinutes: number
  }
  /** 阶段 9.1：人格内核（部署者写，模型不改） */
  persona: {
    enabled: boolean
    /** 基础人格文本；空串 = 不注入 */
    seed: string
  }
  /** 阶段 9.6：每日自动提炼用户画像（等价于每天替你跑一次 memory_traits dry_run=false） */
  traits: {
    enabled: boolean
    /** 每天几点之后跑（HH:MM，按 timeZone 解释） */
    at: string
    /** 解释 at 的时区；容器常跑在 UTC，靠它才能让 02:30 真的是北京时间 */
    timeZone: string
    /** 回看多少天的记忆 */
    days: number
    /** 每天最多写几条新候选（跨多次运行累计，按 created_at 算当天） */
    maxPerDay: number
    /**
     * 待审存量上限（用户 2026-11-03 定：超过 20 条就不再增长）。
     * 与 maxPerDay 的区别：那是「今天写了几条」的增量闸，这是「一共攒了几条」的存量闸。
     * 只有增量闸时，连写三天照样攒一堆没人审的候选。
     */
    maxPending: number
    /** 单次模型返回的候选上限（再多也只是排队等人工审） */
    maxOutput: number
    /** 同义判定的 kNN 余弦阈值，越高越严 */
    dedupMinScore: number
    /** 锚定条目的判重阈值（更严） */
    dedupMinScoreAnchored: number
  }
  /** 阶段 9.5：每日回顾（把一天的对话压成一段，写进「日记」的回顾栏） */
  journal: {
    enabled: boolean
    /** 每天几点之后跑（HH:MM，按 timeZone 解释）；过了点补跑也认 */
    at: string
    /** 解释 at 的时区；容器常跑在 UTC，靠它才能让 23:30 真的是北京时间 */
    timeZone: string
  }
  /** 阶段 9.2：表情包（图片在包外，按目录配置） */
  stickers: {
    enabled: boolean
    /** 表情包目录：需含 stickers.json 与图片；支持 ~ 展开 */
    dir: string
    /** 单次回复最多贴几张 */
    maxPerTurn: number
  }
  /** 阶段 16 P0：影子召回（只观测、不注入；用来拿「该不该开自动注入」的数据） */
  recallShadow: {
    enabled: boolean
    maxItems: number
    maxChars: number
    timeoutMs: number
    minIntervalMs: number
    queryMaxChars: number
    path: string
  }
}

/**
 * 内置人格：包根的 `persona/seed.md`（随发行包一起装）。
 *
 * 为什么做成默认值而不是「安装时写进配置」：
 *  · 配置优先于默认值 → 用户改过的人格不会被升级覆盖（这正是「更新不要覆盖已有」）；
 *  · 内置人格能随版本更新（改 seed.md 就更新），而写进配置后就永远停在装的那一刻；
 *  · 读不到（例如有人只拷了 lib/）就当空串，不注入，也不阻断启动。
 */
function defaultPersonaSeed(): string {
  try {
    return readFileSync(new URL('../persona/seed.md', import.meta.url), 'utf8').trim()
  } catch {
    return ''
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
    audit: z.string().default('memory_audit')
      .description('共享审计索引（团队库操作；只有 teamWrite 身份能写）。'),
    auditPrefix: z.string().default('personal_audit_')
      .description('个人审计索引前缀；实际索引 = 前缀 + identity.userId。个人审核操作先写这里，写不进共享审计也行。'),
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
  prompt: z.object({
    citation: z.boolean().default(false)
      .description('阶段 12「命中后供给」：要求模型引用记忆时标明出处（默认关；会改变回答风格，未做生成侧 A/B 前不默认开）。'),
  }),
  retrieval: z.object({
    topK: z.number().step(1).default(20)
      .description('每一路（BM25 / kNN）取的候选数。'),
    maxPerDomain: z.number().step(1).default(0)
      .description('阶段 12 结果多样化：同一 domain 最多保留几条（0 = 关闭，默认关）。'),
    defaultDetail: z.string().default('full')
      .description('阶段 12 缺省详略：full（正文 500 字）或 summary（摘要 + 120 字，省 70%+ token，需要时用 memory_get 展开）。实测 30 条查询正文从 107k 降到 29k 字符。'),
    rrfK: z.number().step(1).default(60)
      .description('RRF 融合常数。'),
    limit: z.number().step(1).default(8)
      .description('返回给模型的最大条数。'),
    abstainOnLowConfidence: z.boolean().default(false)
      .description('召回质量：候选区分度不足时拒答（返回空），而不是「照给几条 + 一句提示」。默认关；2026-11-02 A/B 实测开它后 43 条契约 should 失败 10 → 3，零误伤。'),
    synonyms: z.dict(z.string(), z.string()).default({})
      .description('查询扩展表（口语/中文 → 书面/英文），BM25 与向量两路都用。默认空；A/B 实测单独开 should 失败 10 → 8，与拒答同开 10 → 1。'),
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
      .description('阶段 5.3 扩散激活强度：score += alpha × Σ(邻居分 × 边权 × 邻居强度)。0 = 关闭（默认）；邻居只算本次结果集内的，强度来自命中回写的 activation 并按 30 天半衰期衰减。'),
    moodWeight: z.number().default(DEFAULT_RANKING.moodWeight)
      .description('阶段 6.3 情绪一致召回：score × (1 + moodWeight × 相似度)。0 = 关闭；只提权不降权，未标 valence 的条目不参与。'),
    utilityWeight: z.number().default(DEFAULT_RANKING.utilityWeight)
      .description('阶段 12 效用信号：score × (1 + utilityWeight × log1p(confirmed_use − corrections))。0 = 关闭（默认）；负效用不惩罚。与 hitWeight（流行度）语义不同，替换与否由评测决定。'),
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
  /**
   * 阶段 9：写入准入屏障。
   *
   * 默认开——它防的是真实发生过的事（巡检把明文口令蒸馏进了记忆库）。
   * 三条规则各自可关，便于排查「为什么这条存不进去」；
   * 关掉 `enabled` 等于退回「什么都不拦」的旧行为。
   */
  admission: z.object({
    enabled: z.boolean().default(true)
      .description('准入屏障总开关：凭据形态 + 「检索原文再摄取」命中即写 status=quarantine（不丢弃）。'),
    similarEnabled: z.boolean().default(true)
      .description('近似去重提示：库里有 cos ≥ similarScore 的条目时回 similar_to，不阻塞写入。'),
    similarScore: z.number().default(0.85)
      .description('近似去重的余弦阈值；与建边的 maxScore 同源但语义不同（那边是「不连边」，这边是「提示一句」）。'),
    recentMax: z.number().step(1).default(20)
      .description('召回缓存每个用户保留几条最近命中（供「原样再摄取」判定）。'),
    recentTtlMinutes: z.number().step(1).default(30)
      .description('召回缓存有效期（分钟）：只活在一轮对话的跨度里，过期不是错误。'),
  }),
  /**
   * 阶段 9.1：人格内核。
   *
   * 为什么是「配置」而不是「记忆条目」：人格是**部署者的设定**，不该由模型归纳改写；
   * 放配置里意味着它跟代码一起版本化、改完重启即生效，不存在「被学歪」的路径。
   * 可演化的表层（阶段 9.3）另走 memory_type=persona + 人工审核。
   */
  persona: z.object({
    enabled: z.boolean().default(true)
      .description('是否注入人格段。关掉等于这个插件不提供人格（行为与未安装此插件一致）。'),
    seed: z.string().default(defaultPersonaSeed())
      .description('基础人格（部署者写）：我是谁、什么口吻、守什么边界。默认取包内 persona/seed.md；写成空串 = 不注入。'),
  }),
  // 阶段 9.6：每日自动提炼。产物是 pending 候选，仍要人工审核才生效
  traits: z.object({
    enabled: z.boolean().default(true),
    at: z.string().default('02:30')
      .description('每天几点之后跑（HH:MM）；按 timeZone 解释，不是容器的本地时区。'),
    timeZone: z.string().default('Asia/Shanghai')
      .description('解释 at 的时区。容器通常跑在 UTC，默认按北京时间算，否则 02:30 会变成 10:30。'),
    days: z.number().step(1).min(1).max(90).default(14),
    /**
     * 每天最多写几条候选。
     *
     * 为什么要这个：定时任务每天跑一次、单次能吐 8 条，可是**手动调一次也算一轮**——
     * 2026-11-01 一天攒了 22 条待审，人工审不过来，候选堆着反而没人看。
     * 5 条是「一天认真看一遍能看完」的量。
     */
    maxPerDay: z.number().step(1).min(1).max(50).default(5)
      .description('每天最多写几条新候选（跨多次运行累计）。默认 5。'),
    /**
     * 待审存量上限（用户 2026-11-03 定：待审核不能超过 20 条，超过不继续增长）。
     *
     * 与 maxPerDay 是两个方向的闸：每日闸管增量、这个管总量。
     * 只靠每日闸，「一天 5 条 × 没人审三天」照样攒 15 条；2026-11-01 实测一天就到 22 条。
     * 满了连模型调用都跳过（省 LLM），审掉几条低于上限后自动恢复。
     */
    maxPending: z.number().step(1).min(1).max(200).default(20)
      .description('待审自述候选的存量上限；pending 达到它就不再提炼。默认 20。'),
    maxOutput: z.number().step(1).min(1).max(20).default(5)
      .description('单次模型返回的候选上限，超出部分丢弃。默认 5。'),
    dedupMinScore: z.number().min(0.7).max(0.99).default(0.88)
      .description('同义判定阈值（kNN 余弦），越高越严。默认 0.88。'),
    dedupMinScoreAnchored: z.number().min(0.6).max(0.99).default(0.82)
      .description('锚定条目的判重阈值（更严，锚点=已定稿）。默认 0.82。'),
  }),
  // 阶段 9.5：每日回顾。默认开，但只在有足够对话时才真的调模型（少于 3 轮直接跳过）
  journal: z.object({
    enabled: z.boolean().default(true),
    at: z.string().default('23:30')
      .description('每天几点之后跑（HH:MM）；按 timeZone 解释，不是容器的本地时区。'),
    timeZone: z.string().default('Asia/Shanghai')
      .description('解释 at 的时区。容器通常跑在 UTC，默认按北京时间算，否则 23:30 会变成次日 07:30。'),
  }),
  /**
   * 阶段 9.2：表情包。
   *
   * **图片不进仓库**（11 张约 2.9 MB，会把包撑大）：只要求配置目录里有 `stickers.json`。
   * 目录不存在、文件缺失、JSON 坏了都只是「不注入」，不能影响插件启动——
   * 表情包是装饰能力，不该成为启动前置条件。
   */
  stickers: z.object({
    enabled: z.boolean().default(true)
      .description('是否注入表情包说明段。关掉后模型不会再贴图。'),
    dir: z.string().default('~/.dsh/stickers')
      .description('表情包目录：需要包含 stickers.json 与图片文件。支持 ~ 展开。'),
    maxPerTurn: z.number().step(1).min(1).max(5).default(1)
      .description('单次回复最多贴几张（默认 1，防止刷屏）。'),
  }),
  /*
   * 阶段 16 P0 影子召回。
   *
   * **默认开**：影子不注入、不碰历史、不计费，开着才有数据。真注入是另一个开关，
   * 等这批数据说话再决定（默认关的通用护栏适用于「改检索行为」的开关，不适用于旁路观测）。
   */
  recallShadow: z.object({
    enabled: z.boolean().default(true)
      .description('影子召回：每轮用户消息后跑一次「假如注入会注入什么」，只记本地 JSONL，不注入。默认开。'),
    maxItems: z.number().step(1).min(1).max(10).default(3)
      .description('「会注入」的条数上限；与真注入的预算保持一致，否则影子会高估。'),
    maxChars: z.number().step(1).min(100).default(600)
      .description('「会注入」的字符预算（按检索顺序累加）。估算 token ≈ 字符 / 2。'),
    timeoutMs: z.number().step(1).min(100).max(10_000).default(3_000)
      .description('单次影子检索超时（毫秒）。超时只记 outcome=timeout，不影响消息主流程。'
        + '默认 3000 而不是 800：实测 Ollama bge-m3 冷启动要 1.87s、热调用 0.08s，'
        + '800ms 只够热路径，进程刚重启那一次必然 timeout（2026-11-03 实测）。'),
    minIntervalMs: z.number().step(1).min(0).default(0)
      .description('两次观测的最小间隔（毫秒）；0 = 每条用户消息都观察。'),
    queryMaxChars: z.number().step(1).min(10).max(2_000).default(400)
      .description('拿消息前多少个字符当检索 query。'),
    path: z.string().default('')
      .description('JSONL 输出路径；留空 = $DSH_HOME/memory-es/recall-shadow.jsonl。'),
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
  // 阶段 12：非法值不静默回落——那会让「配了 summary 却一直给全文」变成看不见的问题。
  // 但「没配」（undefined）是合法的：schema 会填默认值，手写配置对象则可能没有这个键。
  const defaultDetail = config.retrieval?.defaultDetail ?? 'full'
  if (defaultDetail !== 'full' && defaultDetail !== 'summary') {
    problems.push(`retrieval.defaultDetail 只能是 full 或 summary（当前「${String(defaultDetail)}」）`)
  }
  return problems
}
