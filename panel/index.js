/**
 * 宿主半边：给面板开一个只读 HTTP API（P1：概览 + 记忆浏览）。
 *
 * 三个决定：
 *  1. **走 `webServer.register` 的 prefix 路由**，不用 typert remote：官方 remote 需要
 *     `dsh-typert-generator` 生成的描述符，本机没装那个包。路由前缀 `/memory-es/api`。
 *  2. **不开新的安全口子**：这台实例的登录门禁是全局且先于路由的（实测连不存在的路径也 302 到
 *     `/auth/`），所以自定义路由同样要登录态。
 *  3. **配置只有一份**：从 `configEditor` 按 entry id 读 `dsh-memory-es` 这一行的合并配置，
 *     不在面板里重复维护 ES 地址与身份。凭证只在宿主进程内存里用，绝不回传浏览器。
 *
 * P1 只读：`GET /memory-es/api/overview` 与 `GET /memory-es/api/memories`。
 * 审计索引不在插件配置里（名字硬编码 `memory_audit`），且 reader 身份没有它的读权限，
 * 所以概览里的审计计数先留空（null），等 P3 用整理身份补。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { cliAvailable, runCli, summarize } from './cliRunner.js'
import { createReadClient } from './es.js'

const ROUTE = '/memory-es/api'
const ENTRY_ID = 'dsh-memory-es'
const AUDIT_INDEX = 'memory_audit'

/**
 * 面板版本：读包根的 `package.json`（合并成一个包后版本号只有一处）。
 * 浏览器读不到文件系统，所以由 `/overview` 把版本回传给前端显示——
 * 页面上的版本号因此一定是「服务端真正加载的那份」，而不是 bundle 里过期的字符串。
 */
const PANEL_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version.trim() : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** 配置默认值与 `src/config.ts` 保持一致（只用于面板兜底，不替代插件校验） */
const DEFAULTS = {
  es: { url: 'https://127.0.0.1:9200', caCertPath: 'deploy/es/certs/ca.crt', requestTimeoutMs: 8000 },
  index: { personalPrefix: 'personal_memory_', docPrefix: 'personal_doc_', team: 'team_knowledge' },
  identity: {
    userId: '',
    // 单账号模式（推荐）
    username: '',
    password: '',
    teamWrite: false,
    readUsername: '',
    readPassword: '',
    consolidatorUsername: 'mem-consolidator',
    consolidatorPassword: '',
  },
  embedding: { url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024 },
  defaults: { domain: 'general' },
  // 入库后的自动蒸馏（默认关：要花 token，用户在看板上自己打开）
  distill: { enabled: false, provider: '', model: '', timeoutMs: 30000 },
  // 阶段 9：人格内核与表情包（9.4 面板会读这两组）
  persona: { enabled: true, seed: '' },
  stickers: { enabled: true, dir: '~/.dsh/stickers', maxPerTurn: 1 },
  // 阶段 9.5 / 9.6：每日回顾与每日自动提炼
  journal: { enabled: true, at: '23:30' },
  traits: { enabled: true, at: '02:30', days: 14 },
}

/**
 * 合并继承层与 override 层。
 *
 * ⚠️ 不能只遍历 `DEFAULTS` 的键：那样**配置里有、DEFAULTS 里没有**的组会被静默丢弃。
 * 2026-10-31 就因此踩过：`persona.seed` 明明写在配置里、插件也读到了（提示词里有种子），
 * 面板却显示「seed 为空」——因为它在这一层被扔掉了。现在改成两边的键取并集。
 */
function mergeConfig(inherited, override) {
  const merged = {}
  const groups = new Set([
    ...Object.keys(DEFAULTS),
    ...Object.keys(inherited ?? {}),
    ...Object.keys(override ?? {}),
  ])
  for (const group of groups) {
    const defaults = DEFAULTS[group] ?? {}
    const base = typeof defaults === 'object' && defaults !== null ? defaults : {}
    merged[group] = { ...base, ...(inherited?.[group] ?? {}), ...(override?.[group] ?? {}) }
  }
  return merged
}

function entryLabels(item) {
  const entry = item.entry ?? {}
  return [entry.id, entry.name].filter((value) => typeof value === 'string' && value !== '')
}

/**
 * 找 `dsh-memory-es` 的配置行。
 *
 * 实测这台实例里 `configuration()` 的条目是 **bundle include 层**（id 形如
 * `include:dsh-memory-es`，`name` 为空），所以按「精确 → 后缀 → 包含」逐级匹配，
 * 并优先选真带 `es.url` 的那条（空条目会命中但没配置）。
 */
function findEntryRow(ctx) {
  const editor = ctx.get('configEditor')
  if (!editor) return { ok: false, error: 'configEditor 服务不可用（无法读取插件配置）' }
  const rows = editor.configuration()
  const matches = (item, mode) => {
    const labels = entryLabels(item)
    return labels.some((label) => {
      if (mode === 'exact') return label === ENTRY_ID
      if (mode === 'suffix') return label.endsWith(`:${ENTRY_ID}`)
      return label.includes(ENTRY_ID) && !label.includes('panel')
    })
  }

  const candidates = [
    ...rows.filter((item) => matches(item, 'exact')),
    ...rows.filter((item) => matches(item, 'suffix')),
    ...rows.filter((item) => matches(item, 'contains')),
  ]
  if (candidates.length === 0) {
    return { ok: false, error: `没有找到 ${ENTRY_ID} 的配置行（共 ${rows.length} 条）` }
  }
  // 挑第一个真的带 es.url 的（同 id 可能出现空条目）
  for (const row of candidates) {
    const merged = mergeConfig(row.inherited, row.override)
    if (merged.es.url !== '' && merged.identity.userId !== '') {
      return { ok: true, value: merged, label: entryLabels(row).join('|') }
    }
  }
  return {
    ok: false,
    error: `找到 ${candidates.length} 条候选但没有一条含完整配置（es.url/userId）；label=${entryLabels(candidates[0]).join('|')}`,
  }
}

/**
 * 读身份的选择：单账号优先，缺了才回落到旧的 reader（readUsername/readPassword）。
 *
 * ⚠️ 只允许这一处实现。2026-10-31 的 bug 就是「面板用单账号、探活却读 readUsername」：
 * 单账号部署下 readUsername 为空 → 探活 401 → 改 ES 地址被自己拦住，还报「连不上 ES」。
 */
function readCredentialOf(identity) {
  if (identity?.username && identity?.password) {
    return { username: identity.username, password: identity.password }
  }
  if (identity?.readUsername && identity?.readPassword) {
    return { username: identity.readUsername, password: identity.readPassword }
  }
  return null
}

/** 每次请求现读配置 → 配置改了面板不用重启 */
function resolveClientConfig(ctx, role = 'reader') {
  const config = findEntryRow(ctx)
  if (!config.ok) return config
  const value = config.value
  // 单账号模式：一个人一个 ES 账号，个人库读写 + 团队库按 teamWrite 授权
  const single = value.identity.username && value.identity.password ? value.identity : null

  // 个人库写身份：采纳/拒绝自己的 identity 候选只需要写自己的索引，不需要 teamWrite。
  if (role === 'personal-writer') {
    if (single) {
      return {
        ok: true,
        value: {
          url: value.es.url,
          caCertPath: value.es.caCertPath,
          timeoutMs: value.es.requestTimeoutMs,
          auth: { username: single.username, password: single.password },
        },
      }
    }
    return {
      ok: false,
      error: '个人审核需要单账号身份（identity.username / password）；当前是读写分离部署，面板不能替你采纳。',
    }
  }

  if (role === 'consolidator') {
    // 有单账号且声明了 teamWrite，就用它自己（它自带 mem_team_write 角色）
    if (single && value.identity.teamWrite) {
      return {
        ok: true,
        value: {
          url: value.es.url,
          caCertPath: value.es.caCertPath,
          timeoutMs: value.es.requestTimeoutMs,
          auth: { username: single.username, password: single.password },
        },
      }
    }
    const username = value.identity.consolidatorUsername
    const password = value.identity.consolidatorPassword
    if (!username || !password) {
      return {
        ok: false,
        error: '未配置整理身份（identity.consolidatorUsername / consolidatorPassword），审核动作不可用',
      }
    }
    return {
      ok: true,
      value: {
        url: value.es.url,
        caCertPath: value.es.caCertPath,
        timeoutMs: value.es.requestTimeoutMs,
        auth: { username, password },
      },
    }
  }
  if (single) {
    return {
      ok: true,
      value: {
        url: value.es.url,
        caCertPath: value.es.caCertPath,
        timeoutMs: value.es.requestTimeoutMs,
        auth: { username: single.username, password: single.password },
      },
    }
  }
  const credential = readCredentialOf(value.identity)
  if (!credential) {
    return { ok: false, error: '插件配置缺少身份：要么给 identity.username/password（推荐），要么给 readUsername/readPassword' }
  }
  return {
    ok: true,
    value: {
      url: value.es.url,
      caCertPath: value.es.caCertPath,
      timeoutMs: value.es.requestTimeoutMs,
      auth: credential,
    },
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const num = (value) => (typeof value === 'number' ? value : 0)
const str = (value) => (typeof value === 'string' ? value : '')

function indexNames(config) {
  return {
    personal: `${config.index.personalPrefix}${config.identity.userId}`,
    docs: `${config.index.docPrefix ?? 'personal_doc_'}${config.identity.userId}`,
    team: config.index.team,
    audit: AUDIT_INDEX,
    personalAudit: `${config.index.auditPrefix ?? 'personal_audit_'}${config.identity.userId}`,
    // ⚠️ 面板拿到的是「配置行里显式写了什么」，不是 schema 合并后的默认值：
    // 没写的键一律 undefined（2026-11-01 自检因此拼出 `undefinedxqh`，ES 直接 403）。
    // 每个可选前缀都必须带兜底，别指望默认值在这里存在。
    searchLog: `${config.index.searchLogPrefix ?? 'search_log_'}${config.identity.userId}`,
  }
}

/**
 * 复用 dsh 自己的鉴权闸（ctx.connection.admit）。
 *
 * 为什么必须有：dsh 的原生路由（/api/*）是逐路由调用 `connection.admit(req)` 才 401 的，
 * 不是全局中间件 —— 我们自己注册的 prefix 路由**不会自动被拦**。2026-10-26 实测：
 * 不带 token 从本机之外的地址打 `http://<宿主 IP>:3080/memory-es/api/memories` 返回 200 和全部记忆，
 * 而同主机的 `/api/health` 返回 401。等于把整个记忆库开给了同一网段的任何人。
 *
 * 取不到 connection 服务时**失败关闭**（503）：宁可面板不可用，也不能裸奔。
 * 返回 null = 放行；返回数字 = 该用这个 HTTP 状态拒绝。
 */
function admitRequest(ctx, req) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  } catch {
    connection = undefined
  }
  if (!connection || typeof connection.admit !== 'function') return 503
  try {
    const admission = connection.admit(req)
    if (admission && typeof admission === 'object' && 'rejection' in admission) {
      return Number(admission.rejection) || 401
    }
    return null
  } catch {
    return 401
  }
}

/**
 * 把改动写进 configEditor 要求的"完整 raw config"里：两层浅拷贝，只覆盖白名单路径。
 * `resolved` 是校验阶段算好的值（类型已按字段定义转换），这里**绝不再次 String()**——
 * 2026-10-26 的线上报错就是这么来的：写盘处 String(true) → "true" → schemastery 拒。
 */
function applyConfigChanges(current, changes, resolved) {
  const next = {}
  for (const [group, groupValue] of Object.entries(current ?? {})) {
    next[group] = groupValue && typeof groupValue === 'object' ? { ...groupValue } : groupValue
  }
  for (const change of changes) {
    const [group, key] = change.key.split('.')
    if (next[group] === undefined || next[group] === null) next[group] = {}
    next[group][key] = resolved.get(change.key)
  }
  return next
}

/**
 * 字段定义（EDITABLE）是类型的唯一权威：客户端可能缓存了旧 JS，把复选框当文本框发字符串过来，
 * 也可能干脆不传 type。按「服务端声明」转换，旧客户端就不会把布尔写成 "true"。
 */
function fieldTypeOf(key) {
  const field = EDITABLE.find((item) => item.path.join('.') === key)
  return field ? field.type : undefined
}

/**
 * 把面板提交的字符串/布尔统一成配置里该有的类型。
 * 前端复选框传 true/false，输入框传字符串——这里一次收敛，别在写路径上散落类型判断。
 */
function coerceFieldValue(change) {
  const type = fieldTypeOf(change.key) ?? change.type
  if (type === 'number') return Number(change.value)
  if (type === 'boolean') {
    const v = change.value
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
  }
  return String(change.value)
}

/** 能否审核 = 有团队库写权限：单账号 + teamWrite，或旧的整理身份 */
function canReviewTeam(identity) {
  if (identity?.username && identity?.password && identity?.teamWrite) return true
  return Boolean(identity?.consolidatorUsername && identity?.consolidatorPassword)
}

/**
 * 维护类接口的统一门禁（2026-10-29 收拢）：整理任务、导出镜像、镜像预览只有管理员能用。
 *
 * 为什么必须在后端做：前端只是把按钮置灰，接口一直是裸的——普通成员绕过 UI 直接 POST，
 * 整理会真的跑一轮（读自己的个人库、算 embedding，写团队库时靠 ES 403 才失败）。
 * 判据与审核台一致（canReviewTeam）；失败直接写 403 并返回 null。
 */
function requireAdmin(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) {
    json(res, 503, { ok: false, error: configRow.error })
    return null
  }
  if (!canReviewTeam(configRow.value.identity)) {
    json(res, 403, { ok: false, error: '只有团队管理员可以使用维护功能（账号需要 mem_admin 角色）' })
    return null
  }
  return configRow.value
}

/**
 * 用户 id 白名单。索引名由 `personal_memory_<uid>` 拼出来，必须挡住 `*` `?` `../`
 * 这类会改变搜索范围的字符——否则管理员传 `user=*` 就等价于跨所有索引扫一遍。
 */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
function normalizeUserId(value) {
  const userId = str(value).trim()
  if (userId === '') return null
  return USER_ID_PATTERN.test(userId) ? userId : null
}

/** 待裁决口径（概览计数与审核台队列共用，防止两处漂移） */
function pendingQuery() {
  return { bool: { filter: [{ term: { review_state: 'pending' } }, { term: { status: 'active' } }] } }
}

/** 团队库的审核过滤：默认只列可检索的；`includePending=1` 才把待裁决也列出来 */
function teamReviewFilter(includePending) {
  return includePending
    ? { terms: { review_state: ['auto', 'approved', 'pending'] } }
    : { terms: { review_state: ['auto', 'approved'] } }
}

function projectHit(hit, scope) {
  const source = hit._source ?? {}
  return {
    scope,
    // id 给人看（memory_id/doc_id），esId 是真正的 ES 主键：写操作必须用后者。
    // 两者可能不一致（例如同 doc_id 的两条不同文档），2026-10-25 写自检就因此打错过文档。
    esId: hit._id,
    id: str(source.memory_id) || str(source.doc_id) || hit._id,
    content: str(source.content),
    domain: str(source.domain),
    memoryType: str(source.memory_type),
    status: str(source.status),
    reviewState: scope === 'team' ? str(source.review_state) : '',
    updatedAt: str(source.updated_at),
    createdAt: str(source.created_at || source.promoted_at),
    topicKey: str(source.topic_key),
    sourceUser: str(source.source_user),
    sourceMemoryId: str(source.source_memory_id),
    promoteState: str(source.promote_state),
    // 阶段 9：写入来源戳与隔离原因（隔离条目靠这两格在面板上审）
    origin: str(source.origin),
    quarantineReason: str(source.quarantine_reason),
    // 阶段 11 批 B：👍/👎 计数（缺失按 0；0 是真实值，不是「没数据」）
    confirmedUse: num(source.confirmed_use),
    corrections: num(source.corrections),
    feedbackAt: str(source.feedback_at),
    // 命中理由：`score` 是 BM25 分（只在搜索时有），`highlights` 是「哪几个字段、命中了什么」
    score: typeof hit._score === 'number' ? Math.round(hit._score * 100) / 100 : undefined,
    highlights: projectHighlights(hit.highlight),
  }
}

/**
 * 把 ES 的 highlight 压成前端能直接渲染的形状。
 *
 * 片段里命中的词用 \u0001/\u0002 包着（不用 <mark>）——这样前端可以自己切分、
 * 用自己的元素渲染，避免把记忆内容当 HTML 塞进页面（记忆正文里可能出现任何字符）。
 */
function projectHighlights(highlight) {
  if (highlight === null || typeof highlight !== 'object') return []
  const out = []
  for (const [field, fragments] of Object.entries(highlight)) {
    if (!Array.isArray(fragments) || fragments.length === 0) continue
    const text = String(fragments[0])
    if (text === '') continue
    out.push({ field, text })
  }
  return out
}

/**
 * 读 `related`：`[{id, weight}]`，容忍脏数据（和 src/edges.ts 的 readEdges 同口径）。
 *
 * ⚠️ `related` 的 mapping 是 `{"type":"object","enabled":false}` —— **不参与索引**，
 * 只能用 `_source` 读回来。`exists: {field:'related'}` 这类查询永远返回 0，
 * 2026-11-01 就因此误判过「全库没有边」，实际个人库 296/310 条都有。
 */
function readRelated(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = str(item.id).trim()
    const weight = typeof item.weight === 'number' ? item.weight : Number.NaN
    if (id === '' || !Number.isFinite(weight)) continue
    out.push({ id, weight })
  }
  return out
}

/**
 * 星图构图（纯函数，便于单测）。
 *
 * 输入是「已取到的原始节点 + 单向边」，输出可直接交给前端画：
 *  1. 边去重：A→B 与 B→A 是同一条，权重取大；
 *  2. **度数上限**：每个节点只留权重最高的 maxDegree 条。不加这个上限，
 *     库一大就成了毛球（文档 8.4 的「防毛球天花板」）；
 *  3. 节点上限：按「度数 → 新鲜度」排序取前 limit，孤立点自然沉底；
 *  4. 成边时两端必须都在保留集合里，否则丢弃；
 *  5. 分团按 `domain`：P0 用现成领域标签，不做聚类（留到 P1）。
 */
function buildGraph(nodeList, edgeList, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 300
  const maxDegree = Number.isInteger(options.maxDegree) ? options.maxDegree : 10

  const byId = new Map()
  for (const node of nodeList) if (!byId.has(node.id)) byId.set(node.id, node)

  // 每个节点的候选边（单向边归属到 source 一侧；无向图的两端都要有候选）
  const candidates = new Map()
  const unresolved = new Set()
  const addCandidate = (id, other, weight) => {
    const list = candidates.get(id)
    if (list === undefined) candidates.set(id, [{ other, weight }])
    else list.push({ other, weight })
  }
  for (const edge of edgeList) {
    if (!byId.has(edge.source)) continue
    if (!byId.has(edge.target)) {
      // 源在、目标不在：取数范围内找不到端点（可能是真断链，也可能只是没取到）
      unresolved.add(`${edge.source}|${edge.target}`)
      continue
    }
    if (edge.source === edge.target) continue // 自环没有信息量
    addCandidate(edge.source, edge.target, edge.weight)
    addCandidate(edge.target, edge.source, edge.weight)
  }

  // 度数上限：每个节点只留权重最高的若干条
  for (const list of candidates.values()) {
    list.sort((a, b) => b.weight - a.weight)
    if (list.length > maxDegree) list.length = maxDegree
  }

  // 节点上限：度数高的优先，同度数按更新时间新的优先
  const ranked = [...byId.values()]
    .map((node) => ({ ...node, degree: (candidates.get(node.id) ?? []).length }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree
      return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
    })
    .slice(0, limit)
  const kept = new Set(ranked.map((node) => node.id))

  // 成边：两端都在保留集合里，无向去重，权重取大
  const byPair = new Map()
  for (const node of ranked) {
    for (const item of candidates.get(node.id) ?? []) {
      if (item.other === node.id) continue
      if (!kept.has(item.other)) continue
      // 度数上限是**每个节点自己的**约束：hub 裁掉的那条边，不能因为叶子那边还留着就复活
      const backKept = (candidates.get(item.other) ?? []).some((entry) => entry.other === node.id)
      if (!backKept) continue
      const key = node.id < item.other ? `${node.id}|${item.other}` : `${item.other}|${node.id}`
      const prev = byPair.get(key)
      if (prev === undefined || item.weight > prev.weight) {
        byPair.set(key, { source: node.id, target: item.other, weight: item.weight })
      }
    }
  }
  const edges = [...byPair.values()].map((edge) => ({
    source: edge.source,
    target: edge.target,
    // 保留 3 位，前端当强弱用
    weight: Math.round(edge.weight * 1000) / 1000,
  }))

  // 最终度数（按成图后的边重算——裁剪和节点上限都会让度数变小）
  const degree = new Map()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  const nodes = ranked.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }))

  // 分团：按 domain 计数，前端据此分区布局
  const clusters = new Map()
  for (const node of nodes) {
    const entry = clusters.get(node.domain)
    if (entry === undefined) clusters.set(node.domain, { domain: node.domain, count: 1 })
    else entry.count += 1
  }

  return {
    nodes,
    edges,
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count),
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      orphans: nodes.filter((node) => node.degree === 0).length,
      unresolved: unresolved.size,
    },
  }
}

/** 星图默认与上限（文档 8.4：节点封顶 400、单点度数 10） */
const GRAPH_DEFAULT_NODES = 300
const GRAPH_MAX_NODES = 400
const GRAPH_MAX_DEGREE = 10

/**
 * 星图数据（阶段 8 第六个页签）。
 *
 * 只读：把两个索引的 active 记忆与 `related` 拉回来，交给 buildGraph 裁成可画的图。
 * 取数按「更新时间倒序」多取一倍——孤立点会在裁剪里沉底，只取 limit 条会让图比预期稀。
 */
async function handleGraph(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  const rawLimit = Number(url.searchParams.get('limit') ?? GRAPH_DEFAULT_NODES)
  const limit = Number.isFinite(rawLimit)
    ? Math.max(20, Math.min(GRAPH_MAX_NODES, Math.trunc(rawLimit)))
    : GRAPH_DEFAULT_NODES
  const scope = str(url.searchParams.get('scope') ?? 'both')
  const targets =
    scope === 'team'
      ? [['team', names.team]]
      : scope === 'personal'
        ? [['personal', names.personal]]
        : [['personal', names.personal], ['team', names.team]]

  const fetchSize = Math.min(GRAPH_MAX_NODES * 2, Math.max(limit * 2, 200))
  const nodes = []
  const edges = []

  for (const [scopeName, index] of targets) {
    let result
    try {
      result = await client.search(index, {
        size: fetchSize,
        sort: [{ updated_at: 'desc' }],
        query: { term: { status: 'active' } },
        _source: ['memory_id', 'summary', 'content', 'domain', 'memory_type', 'updated_at', 'status', 'related'],
      })
    } catch (error) {
      return json(res, 503, { ok: false, error: String(error?.message ?? error) })
    }
    // 面板的 search 返回 ES 原始响应（`{ hits: { hits: [...] } }`），不是数组
    for (const hit of result.hits?.hits ?? []) {
      const source = hit._source ?? {}
      const id = str(source.memory_id) || str(hit._id)
      if (id === '') continue
      nodes.push({
        id,
        scope: scopeName,
        // 详情面板只需要一句可读的摘要，全文由「记忆浏览」负责
        label: str(source.summary) || str(source.content).slice(0, 80),
        type: str(source.memory_type) || 'fact',
        domain: str(source.domain) || 'general',
        updatedAt: str(source.updated_at),
        status: str(source.status) || 'active',
      })
      for (const edge of readRelated(source.related)) {
        edges.push({ source: id, target: edge.id, weight: edge.weight })
      }
    }
  }

  const graph = buildGraph(nodes, edges, { limit, maxDegree: GRAPH_MAX_DEGREE })
  return json(res, 200, {
    ok: true,
    value: {
      generatedAt: new Date().toISOString(),
      scope,
      limit,
      maxDegree: GRAPH_MAX_DEGREE,
      ...graph,
    },
  })
}

async function handleOverview(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  // 审计计数：memory_audit 只给整理身份读（reader 无权限），没配整理身份时降级为 null
  const auditClient = createReadClient(() => resolveClientConfig(ctx, 'consolidator'))
  const auditStat = await auditClient
    .search(AUDIT_INDEX, {
      size: 0,
      track_total_hits: true,
      query: { match_all: {} },
      aggs: { last7d: { filter: { range: { at: { gte: 'now-7d' } } } } },
    })
    .then((result) => ({
      total: num(result.hits?.total?.value),
      last7d: num(result.aggregations?.last7d?.doc_count),
    }))
    .catch(() => null)

  const [health, personalCount, teamCount, pendingCount, personalRecent, teamRecent, docStat] = await Promise.all([
    // 用「读一次个人库」当可达性探测：reader 角色没有 cluster:monitor/health 权限，
    // 直接打 /_cluster/health 会 403，把健康的库误判成 down（2026-10-25 踩过）。
    client
      .count(names.personal)
      .then(() => ({ ok: true }))
      .catch((error) => ({ error: String(error.message ?? error) })),
    client
      .search(names.personal, { size: 0, query: { term: { status: 'active' } }, track_total_hits: true })
      .then((r) => num(r.hits?.total?.value))
      .catch(() => -1),
    // 团队口径必须带 status=active：否则已撤回(superseded)/已驳回(rejected)的文档只要
    // review_state 还是 auto/approved 就会被算进"团队知识"（2026-10-25 实测多算了一条自检残留）
    client
      .search(names.team, {
        size: 0,
        query: { bool: { filter: [teamReviewFilter(false), { term: { status: 'active' } }] } },
        track_total_hits: true,
      })
      .then((r) => num(r.hits?.total?.value))
      .catch(() => -1),
    // 待裁决口径与审核台完全一致：review_state=pending **且** status=active
    client
      .search(names.team, { size: 0, query: pendingQuery(), track_total_hits: true })
      .then((r) => num(r.hits?.total?.value))
      .catch(() => -1),
    client
      .search(names.personal, {
        size: 5,
        _source: { excludes: ['embedding'] },
        query: { term: { status: 'active' } },
        sort: [{ updated_at: 'desc' }],
      })
      .then((r) => (r.hits?.hits ?? []).map((hit) => projectHit(hit, 'personal')))
      .catch(() => []),
    client
      .search(names.team, {
        size: 5,
        _source: { excludes: ['embedding'] },
        query: teamReviewFilter(true),
        sort: [{ updated_at: 'desc' }],
      })
      .then((r) => (r.hits?.hits ?? []).map((hit) => projectHit(hit, 'team')))
      .catch(() => []),
    // 文档库：一次查询同时拿 chunk 总数与文档篇数（cardinality 去重 doc_id）。
    // 索引不存在时（还没入库）返回 -1，与 personal/team 的"查不到"口径一致。
    client
      .search(names.docs, {
        size: 0,
        aggs: { docs: { cardinality: { field: 'doc_id' } } },
        track_total_hits: true,
      })
      .then((r) => ({
        chunks: num(r.hits?.total?.value),
        docs: num(r.aggregations?.docs?.value),
      }))
      .catch(() => ({ chunks: -1, docs: -1 })),
  ])

  const recent = [...personalRecent, ...teamRecent]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, 5)

  json(res, 200, {
    ok: true,
    value: {
      // 前端页脚显示它：部署后一眼能看出页面连的是哪一版服务端
      version: PANEL_VERSION,
      es: {
        reachable: !health.error,
        // 读不到集群健康（权限不足），这里不编造状态；可达性由上面的索引读探测给出
        status: '',
        error: health.error ? String(health.error) : '',
      },
      counts: {
        personal: personalCount,
        team: teamCount,
        docs: docStat ? docStat.docs : -1,
        docChunks: docStat ? docStat.chunks : -1,
        pending: pendingCount,
        audit: auditStat ? auditStat.total : null,
        auditLast7d: auditStat ? auditStat.last7d : null,
      },
      recent,
      config: {
        url: config.es.url,
        indexes: names,
        userId: config.identity.userId,
        defaultDomain: config.defaults.domain,
        embedding: { model: config.embedding.model, dims: config.embedding.dims, url: config.embedding.url },
        hasCredentials: Boolean(config.identity.readUsername && config.identity.readPassword),
        entryLabel: configRow.label ?? '',
      },
    },
  })
}

/**
 * 把查询簇归类（阶段 11 的覆盖率口径）。
 *
 * 三档不是拍脑袋，对应三种「没答上」的不同原因：
 *  · `miss`   —— **一次都没命中**：真正的内容缺口，最值钱的那张清单；
 *  · `mixed`  —— 答上过也漏过：可能是问法更具体、也可能是库在长大（同一条 query 前后两次结果不同）；
 *  · `low`    —— 答上了但低置信：候选区分度不足，通常是「库里没有精确答案，只有近邻」；
 *  · `hit`    —— 正常命中。
 *
 * 判据刻意用 max(hits) 而不是「最新一次」：一次 no_match 不代表这个问题一直没人答得出来，
 * 反过来一次命中也不代表缺口填上了——两种都记下来，让人自己看。
 */
export function classifyCluster(input) {
  const maxHits = num(input.maxHits)
  const notes = input.notes ?? {}
  const noMatch = num(notes.no_match)
  const low = num(notes.low_confidence)
  const status = maxHits <= 0 ? 'miss' : noMatch > 0 ? 'mixed' : low > 0 ? 'low' : 'hit'
  return { ...input, maxHits, status }
}

/** GET /search-log：最近检索记录 + 按查询归一化键聚类的覆盖率（阶段 11） */
async function handleSearchLog(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const client = createReadClient(() => resolveClientConfig(ctx))
  const index = indexNames(config).searchLog

  const daysRaw = Number.parseInt(url.searchParams.get('days') ?? '7', 10)
  const days = Math.min(90, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 7))
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50))
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const range = { range: { at: { gte: since } } }

  let recent = []
  let total = 0
  let clusters = []
  /** 「被用得最多」的原始排行（hit_ids terms 聚合的结果） */
  let topHitRank = []
  try {
    const [rows, agg] = await Promise.all([
      client.search(index, {
        size: limit,
        sort: [{ at: 'desc' }],
        query: range,
        _source: ['at', 'query', 'scope', 'hits', 'note', 'degraded', 'ms'],
      }),
      client.search(index, {
        size: 0,
        track_total_hits: true,
        query: range,
        aggs: {
          clusters: {
            terms: { field: 'query_norm', size: 200, order: { last: 'desc' } },
            aggs: {
              // 带 format 才会返回 value_as_string；不带的话拿到的是 epoch millis
              last: { max: { field: 'at', format: 'strict_date_optional_time' } },
              max_hits: { max: { field: 'hits' } },
              notes: { terms: { field: 'note', size: 5 } },
              sample: { top_hits: { size: 1, sort: [{ at: 'desc' }], _source: ['query'] } },
            },
          },
          // 阶段 11：「哪条记忆被用得最多」——hit_ids 是 keyword 数组，terms 会按元素展开
          hit_rank: { terms: { field: 'hit_ids', size: 10 } },
        },
      }),
    ])

    recent = (rows.hits?.hits ?? []).map((hit) => {
      const src = hit._source ?? {}
      return {
        at: str(src.at),
        query: str(src.query),
        scope: str(src.scope),
        hits: num(src.hits),
        note: str(src.note),
        ms: num(src.ms),
        degraded: src.degraded === true,
      }
    })

    total = num(agg.hits?.total?.value)
    topHitRank = (agg.aggregations?.hit_rank?.buckets ?? []).map((bucket) => ({
      memory_id: str(bucket.key),
      count: num(bucket.doc_count),
    }))
    clusters = (agg.aggregations?.clusters?.buckets ?? []).map((bucket) =>
      classifyCluster({
        key: bucket.key,
        query: str(bucket.sample?.hits?.hits?.[0]?._source?.query),
        count: num(bucket.doc_count),
        lastAt: bucket.last?.value_as_string ?? '',
        maxHits: bucket.max_hits?.value,
        notes: Object.fromEntries((bucket.notes?.buckets ?? []).map((item) => [item.key, item.doc_count])),
      }),
    )
  } catch (error) {
    // 索引不存在 = 这个用户还没检索过。那不是错误，返回空集合（面板会显示「—」）。
    if (error?.status !== 404) throw error
  }

  // 「被用得最多」的正文预览：拿到 id 排行后回个人库补第一条正文（只取前 60 字）
  let topMemories = []
  if (topHitRank.length > 0) {
    try {
      const found = await client.search(indexNames(config).personal, {
        size: topHitRank.length,
        query: { ids: { values: topHitRank.map((item) => item.memory_id) } },
        _source: ['memory_id', 'content'],
      })
      const preview = new Map(
        (found.hits?.hits ?? []).map((hit) => [str(hit._source?.memory_id) || hit._id, str(hit._source?.content)]),
      )
      topMemories = topHitRank.map((item) => ({
        ...item,
        preview: (preview.get(item.memory_id) ?? '').slice(0, 60),
      }))
    } catch {
      // 补正文失败不影响排行本身：id 与次数照给
      topMemories = topHitRank.map((item) => ({ ...item, preview: '' }))
    }
  }

  const summary = {
    total,
    clusters: clusters.length,
    miss: clusters.filter((item) => item.status === 'miss').length,
    mixed: clusters.filter((item) => item.status === 'mixed').length,
    low: clusters.filter((item) => item.status === 'low').length,
    hit: clusters.filter((item) => item.status === 'hit').length,
    /** 存量记录没有 query_norm（阶段 11 之前），面板要如实说明统计范围 */
    since,
  }
  const missing = clusters
    .filter((item) => item.status === 'miss')
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)
  const low = clusters
    .filter((item) => item.status === 'low' || item.status === 'mixed')
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)

  json(res, 200, {
    ok: true,
    value: {
      days,
      limit,
      summary,
      recent,
      missing,
      low,
      topMemories,
      clusters: clusters.slice(0, 50),
    },
  })
}

/** GET /search-log/used-in：反查「这条记忆被哪些问题命中过」（阶段 11） */
async function handleSearchLogUsedIn(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const memoryId = str(url.searchParams.get('memory_id')).trim()
  if (memoryId === '') return json(res, 400, { ok: false, error: '缺少 memory_id' })

  const daysRaw = Number.parseInt(url.searchParams.get('days') ?? '90', 10)
  const days = Math.min(365, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 90))
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const client = createReadClient(() => resolveClientConfig(ctx))
  const index = indexNames(config).searchLog
  try {
    const result = await client.search(index, {
      size: 50,
      sort: [{ at: 'desc' }],
      query: {
        bool: {
          filter: [{ range: { at: { gte: since } } }, { term: { hit_ids: memoryId } }],
        },
      },
      _source: ['at', 'query', 'hits', 'note'],
    })
    const rows = (result.hits?.hits ?? []).map((hit) => {
      const src = hit._source ?? {}
      return { at: str(src.at), query: str(src.query), hits: num(src.hits), note: str(src.note) }
    })
    json(res, 200, { ok: true, value: { days, memoryId, total: rows.length, rows } })
  } catch (error) {
    if (error?.status !== 404) throw error
    json(res, 200, { ok: true, value: { days, memoryId, total: 0, rows: [] } })
  }
}

async function handleMemories(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  const params = url.searchParams
  const scopeParam = params.get('scope')
  const scope = scopeParam === 'personal' || scopeParam === 'team' ? scopeParam : 'both'
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '0', 10) || 0)
  const size = Math.min(100, Math.max(1, Number.parseInt(params.get('size') ?? '20', 10) || 20))
  const query = (params.get('q') ?? '').trim()
  // 前端按逗号拼（省参数），也兼容多次传参
  const domains = params.getAll('domain').flatMap((value) => value.split(',')).map((v) => v.trim()).filter(Boolean)
  const types = params.getAll('type').flatMap((value) => value.split(',')).map((v) => v.trim()).filter(Boolean)
  const status = (params.get('status') ?? 'active').trim()
  const includePending = params.get('includePending') === '1'

  // 管理员可以看**别人**的个人库（mem_admin 的 personal_memory_* 通配读）；
  // 普通账号传了 user 也不生效，永远只看自己。
  const canAdmin = canReviewTeam(config.identity)
  const wantUser = (params.get('user') ?? '').trim()
  if (canAdmin && wantUser !== '' && normalizeUserId(wantUser) === null) {
    return json(res, 400, { ok: false, error: 'user 参数不合法（只允许字母、数字、_ 和 -）' })
  }
  const targetUser = canAdmin && wantUser !== '' ? wantUser : config.identity.userId
  const personalIndex =
    targetUser === config.identity.userId ? names.personal : `${config.index.personalPrefix}${targetUser}`

  // 跨两库分页：from/size 对每个库各算一次再合并排序 → 翻页会重复或漏条。
  // 改成「每个库都从头取到第 page 页末尾，合并排序后再切片」，代价是深页取数多，故设窗口上限。
  const WINDOW_MAX = 500
  const wanted = (page + 1) * size
  const windowSize = Math.min(wanted, WINDOW_MAX)
  const truncated = wanted > WINDOW_MAX

  const buildBody = (isTeam) => {
    const filter = []
    if (status !== 'all') filter.push({ term: { status } })
    if (domains.length > 0) filter.push({ terms: { domain: domains } })
    if (types.length > 0) filter.push({ terms: { memory_type: types } })
    if (isTeam) filter.push(teamReviewFilter(includePending))
    const must =
      query === ''
        ? [{ match_all: {} }]
        : [
            {
              multi_match: {
                query,
                // topic_key 是"这条记忆属于哪个主题"，最贴近人写的问题，权重给高一点
                fields: ['content^3', 'topic_key^2', 'domain'],
                type: 'best_fields',
              },
            },
          ]
    return {
      from: 0,
      size: windowSize,
      track_total_hits: true,
      _source: { excludes: ['embedding'] },
      query: { bool: { must, filter } },
      // 搜索时去掉按时间的排序，让 ES 按相关性返回（否则命中理由就没意义了）
      ...(query === ''
        ? { sort: [{ updated_at: 'desc' }] }
        : {
            highlight: {
              // 用哨兵字符而不是 <mark>：前端自己切分渲染，避免把正文当 HTML
              pre_tags: ['\u0001'],
              post_tags: ['\u0002'],
              fields: {
                content: { fragment_size: 140, number_of_fragments: 1 },
                topic_key: { number_of_fragments: 0 },
              },
            },
          }),
    }
  }

  const emptyPage = { hits: { total: { value: 0 }, hits: [] } }
  const [personal, team] = await Promise.all([
    scope !== 'team' ? client.search(personalIndex, buildBody(false)) : Promise.resolve(emptyPage),
    scope !== 'personal' ? client.search(names.team, buildBody(true)) : Promise.resolve(emptyPage),
  ])

  const merged = [
    ...(personal.hits?.hits ?? []).map((hit) => projectHit(hit, 'personal')),
    ...(team.hits?.hits ?? []).map((hit) => projectHit(hit, 'team')),
  ].sort((a, b) => {
    // 搜索时按相关性：两个库的 _score 直接可比（同一套 BM25，字段权重也一致）
    if (query !== '') return (b.score ?? 0) - (a.score ?? 0)
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
  })
  const rows = merged.slice(page * size, page * size + size)

  json(res, 200, {
    ok: true,
    value: {
      total: num(personal.hits?.total?.value) + num(team.hits?.total?.value),
      totals: {
        personal: num(personal.hits?.total?.value),
        team: num(team.hits?.total?.value),
      },
      // 告诉前端当前看的是谁的个人库，避免"看的是别人的记忆却以为是自己"
      userId: targetUser,
      viewingOther: targetUser !== config.identity.userId,
      page,
      size,
      rows,
      // 深页超过窗口上限时，页尾可能不全 —— 明确告诉前端，别让人以为"没有更多了"
      truncated,
      windowSize,
    },
  })
}

/** 读请求体（限制 64 KB，够放驳回原因） */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve({ ok: false, error: '请求体过大' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({ ok: true, value: {} })
      try {
        resolve({ ok: true, value: JSON.parse(text) })
      } catch {
        resolve({ ok: false, error: '请求体不是合法 JSON' })
      }
    })
    req.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
  })
}

/**
 * GET /users：管理员用——列出"有个人记忆的用户"，供浏览页/维护页切换目标用户。
 *
 * 做法：对 `personal_memory_*` 做 size:0 的 `_index` 聚合。能这么干的前提是管理员持有
 * mem_admin 的通配读；普通账号即使调到这里也会被 requireAdmin 挡住（不靠 ES 兜底）。
 * 返回按条数降序，前端只展示 userId + 条数。
 */
async function handleUsers(ctx, res) {
  const config = requireAdmin(ctx, res)
  if (!config) return
  const client = createReadClient(() => resolveClientConfig(ctx))
  const prefix = config.index.personalPrefix
  const result = await client.search(`${prefix}*`, {
    size: 0,
    aggs: { by_user: { terms: { field: '_index', size: 100 } } },
  })
  const users = (result.aggregations?.by_user?.buckets ?? [])
    .map((bucket) => ({ userId: String(bucket.key).slice(prefix.length), count: num(bucket.doc_count) }))
    .filter((entry) => entry.userId !== '')
    .sort((a, b) => b.count - a.count)
  json(res, 200, { ok: true, value: { self: config.identity.userId, users } })
}

/**
 * POST /memories/delete：物理删除一条记忆（不可恢复）。
 *
 * 两种 scope 的权限模型不同：
 *  · personal —— 本人的账号就能删自己的库（一人一账号，索引级 ACL）；
 *  · team     —— 必须真的持有 team_knowledge 的 delete，用 `_has_privileges` 现问，不认配置声明。
 *
 * 团队删除要求填原因并写 `memory_audit`；个人删除写不了审计（个人账号没有 memory_audit 的写权限），
 * 响应里如实返回 auditWritten=false + 原因，不假装留痕。
 */
async function handleDeleteMemory(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const input = body.value ?? {}
  const esId = str(input.esId).trim()
  const scope = str(input.scope).trim()
  const reason = str(input.reason).trim()

  if (esId === '') return json(res, 400, { ok: false, error: '缺少 esId（要用 ES 主键，不是给人看的 memory_id）' })
  if (scope !== 'personal' && scope !== 'team') {
    return json(res, 400, { ok: false, error: 'scope 只能是 personal 或 team' })
  }
  // 物理删除不可恢复：必须显式确认，且不做「下次不再提示」
  if (input.confirm !== true) {
    return json(res, 400, { ok: false, error: '缺少 confirm:true（删除不可恢复，要显式确认）' })
  }
  if (scope === 'team' && reason === '') {
    return json(res, 400, { ok: false, error: '删除团队记忆必须填写原因（会写进 memory_audit）' })
  }

  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const target = scope === 'team' ? names.team : names.personal

  // 权限前置：个人也问一次。理由同上——配置说能不算数，ES 说能才算
  const rights = await probeDeleteRights(ctx)
  const allowed = scope === 'team' ? rights.team : rights.personal
  if (!allowed) {
    return json(res, 403, {
      ok: false,
      error:
        scope === 'team'
          ? '没有团队删除权限（team_knowledge 的 delete 不在你的角色里）'
          : `没有个人库删除权限${rights.note === '' ? '' : `：${rights.note}`}`,
    })
  }

  const now = new Date().toISOString()
  const actor = `panel:${str(config.identity?.userId) || 'unknown'}`
  let deleted = true
  try {
    await client.del(target, esId, { refresh: 'wait_for' })
  } catch (error) {
    if (error?.status === 404) {
      // 本来就不存在 = 目标状态已达成，按幂等成功算（重复点两次不该报错）
      deleted = false
    } else {
      throw error
    }
  }

  let auditWritten = false
  let auditError = ''
  if (scope === 'team') {
    try {
      await client.index(names.audit, {
        event: 'deleted',
        actor,
        at: now,
        subject_type: 'team_doc',
        subject_id: esId,
        team_doc_id: esId,
        reason,
      }, { refresh: 'wait_for' })
      auditWritten = true
    } catch (error) {
      auditError = String(error?.message ?? error).slice(0, 200)
      console.error(`[memory-es-panel] 删除审计写入失败 ${esId}: ${auditError}`)
    }
  } else {
    // 个人删除按设计不审计（用户 2026-10-29 确认）：不是"没权限写"的缺陷，就别在响应里
    // 编一条错误说明；auditWritten=false 如实返回即可
    auditError = ''
  }

  console.error(`[memory-es-panel] 删除 ${scope} esId=${esId} deleted=${deleted} audit=${auditWritten} actor=${actor}`)
  json(res, 200, {
    ok: true,
    value: { esId, scope, deleted, auditWritten, auditError, at: now },
  })
}

/**
 * 反馈脚本（阶段 11 批 B）：👍 记 `confirmed_use`，👎 记 `corrections`，并刷新 `feedback_at`。
 *
 * 抽成纯函数（而不是内联在 handler 里）是为了可测：这段 painless 没有任何类型保护，
 * 写错一个字段名只会得到 400，而反馈是低频操作，没人会立刻发现。
 * `now` 可注入，测试里能断言时间戳来自调用方而不是脚本自己取。
 */
export function feedbackScript(verdict, now = new Date().toISOString()) {
  const base = (field) =>
    `if (ctx._source.${field} == null) { ctx._source.${field} = 0 } ` +
    `ctx._source.${field} += 1; ctx._source.feedback_at = params.now`
  if (verdict === 'useful') return { source: base('confirmed_use'), params: { now } }
  if (verdict === 'wrong') return { source: base('corrections'), params: { now } }
  throw new Error(`未知反馈类型「${String(verdict)}」（只支持 useful / wrong）`)
}

/**
 * POST /memories/feedback：给一条个人记忆记一次 👍/👎。
 *
 * 只做个人库：团队库的正确性由审核台（采纳/驳回）负责，两套信号混在一起会让两边都失真。
 * 排序暂不读这两个计数（效用信号在阶段 12 才接入，且默认关），本轮只负责把数据攒起来。
 */
async function handleMemoryFeedback(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const input = body.value ?? {}
  const esId = str(input.esId).trim()
  const verdict = str(input.verdict).trim()
  const scope = str(input.scope).trim() || 'personal'
  if (esId === '') return json(res, 400, { ok: false, error: '缺少 esId（要用 ES 主键）' })
  if (scope !== 'personal') return json(res, 400, { ok: false, error: '反馈只作用于个人库' })

  let script
  try {
    script = feedbackScript(verdict)
  } catch (error) {
    return json(res, 400, { ok: false, error: String(error?.message ?? error) })
  }

  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))

  let rights
  try {
    rights = await client.hasIndexPrivileges(names.personal, ['index'])
  } catch (error) {
    return json(res, 403, { ok: false, error: `权限探测失败：${String(error?.message ?? error)}` })
  }
  if (rights?.has_all_requested !== true) {
    return json(res, 403, { ok: false, error: '没有个人库写权限（反馈需要 index 权限）' })
  }

  try {
    await client.updateScript(names.personal, esId, script, { refresh: 'wait_for' })
  } catch (error) {
    if (error?.status === 404) return json(res, 404, { ok: false, error: '这条记忆不存在' })
    throw error
  }

  console.error(`[memory-es-panel] 反馈 esId=${esId} verdict=${verdict}`)
  json(res, 200, { ok: true, value: { esId, verdict, at: script.params.now } })
}

/**
 * POST /memories/restore：把一条被隔离（status=quarantine）的记忆恢复为有效。
 *
 * 为什么必须有这个按钮：隔离的设计是「不丢弃、等人审」——只能被 AI 用工具恢复的话，
 * 面板就成了只读的事故现场，审完也处理不掉。
 *
 * 权限照旧问 ES（`_has_privileges` 的 index），不认配置声明。
 * 恢复后**不补向量**（面板侧没有 embedding 服务）：诚实告诉前端 `embeddingMissing`，
 * 这条此后只能关键词检索，要向量就重新存一次。
 */
async function handleRestoreMemory(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const input = body.value ?? {}
  const esId = str(input.esId).trim()
  const scope = str(input.scope).trim() || 'personal'
  if (esId === '') return json(res, 400, { ok: false, error: '缺少 esId（要用 ES 主键）' })
  if (scope !== 'personal') {
    return json(res, 400, { ok: false, error: '隔离只发生在个人库；团队库走审核台的驳回/撤回' })
  }

  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  let rights
  try {
    rights = await client.hasIndexPrivileges(names.personal, ['index'])
  } catch (error) {
    return json(res, 403, { ok: false, error: `权限探测失败：${String(error?.message ?? error)}` })
  }
  if (rights?.has_all_requested !== true) {
    return json(res, 403, { ok: false, error: '没有个人库写权限（恢复需要 index 权限）' })
  }

  let source
  // 读侧没有 get 方法（只暴露 search/count），用 ids 查询取同一条。
  // 不排除 embedding：要用它判断「恢复后是不是只能关键词检索」（只查一条，代价可忽略）。
  const found = await client.search(names.personal, {
    size: 1,
    query: { ids: { values: [esId] } },
    track_total_hits: true,
  })
  const hit = found?.hits?.hits?.[0]
  if (!hit) return json(res, 404, { ok: false, error: '这条记忆不存在' })
  source = hit._source ?? {}
  if (str(source.status) !== 'quarantine') {
    return json(res, 409, { ok: false, error: `这条当前状态是 ${str(source.status) || '?'}（只有已隔离的能恢复）` })
  }

  const now = new Date().toISOString()
  await client.update(names.personal, esId, {
    status: 'active',
    // 置 null 而不是删字段：ES 的 exists 对 null 返回 false，效果等价且不需要脚本权限
    quarantine_reason: null,
    updated_at: now,
  }, { refresh: 'wait_for' })

  const embeddingMissing = !Array.isArray(source.embedding) || source.embedding.length === 0
  console.error(`[memory-es-panel] 恢复隔离 esId=${esId} embeddingMissing=${embeddingMissing}`)
  json(res, 200, {
    ok: true,
    value: { esId, status: 'active', embeddingMissing, at: now },
  })
}

/** 待裁决列表：读团队库（reader 有 team 读权限），连同冲突对象一起返回 */
/**
 * 当前心情（阶段 6.2）。读固定文档 `__mood__`；不存在就是中性，不报错。
 *
 * 面板只**展示**，不提供改状态的入口：情绪只由事件驱动，让人手动改等于允许伪造情绪。
 */
async function handleMood(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  try {
    const doc = await client.search(names.personal, {
      size: 1,
      query: { term: { memory_id: '__mood__' } },
      _source: { excludes: ['embedding', 'content'] },
    })
    const hit = doc.hits?.hits?.[0]
    if (!hit) return json(res, 200, { ok: true, value: { exists: false, valence: 0, arousal: 0, events: [] } })
    const src = hit._source ?? {}
    return json(res, 200, {
      ok: true,
      value: {
        exists: true,
        valence: typeof src.mood_valence === 'number' ? src.mood_valence : 0,
        arousal: typeof src.mood_arousal === 'number' ? src.mood_arousal : 0,
        updatedAt: str(src.mood_updated_at),
        events: Array.isArray(src.mood_events) ? src.mood_events.slice(0, 8) : [],
      },
    })
  } catch (err) {
    // 打一行日志：面板"看起来没数据"时，光看界面分不清是没记录还是查询挂了
    console.error(`[记忆库面板] /mood 查询失败：${String(err?.message ?? err).slice(0, 200)}`)
    return json(res, 200, { ok: true, value: { exists: false, valence: 0, arousal: 0, events: [], note: String(err).slice(0, 160) } })
  }
}

/** 待采纳的 identity 候选（阶段 7.2 产出，status=pending） */
/**
 * 阶段 9.4：人格。
 *
 * `seed` 是部署者写在配置里的人格内核，`entries` 是 9.3 学出来、**已 approve** 的倾向。
 * 两者分开返回，前端才能把「你定的」和「我长的」显示成两层。
 */
async function handlePersonaGet(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  const [active, pending] = await Promise.all([
    client.search(names.personal, {
      size: 50,
      _source: ['memory_id', 'content', 'created_at', 'updated_at'],
      sort: [{ updated_at: 'desc' }],
      query: { bool: { filter: [{ term: { status: 'active' } }, { term: { memory_type: 'persona' } }] } },
    }),
    client.search(names.personal, {
      size: 0,
      query: { bool: { filter: [{ term: { status: 'pending' } }, { term: { memory_type: 'persona' } }] } },
      track_total_hits: true,
    }),
  ])

  const persona = config.persona ?? {}
  const seed = str(persona.seed)
  return json(res, 200, {
    ok: true,
    value: {
      enabled: persona.enabled !== false,
      seed,
      seedLength: seed.trim().length,
      entries: (active.hits?.hits ?? []).map((hit) => ({
        memoryId: str(hit._source?.memory_id),
        content: str(hit._source?.content),
        updatedAt: str(hit._source?.updated_at),
      })),
      pendingCount: pending.hits?.total?.value ?? 0,
    },
  })
}

/**
 * 表情包目录：配置里可能是 `~`、`~/xxx` 或绝对路径。
 * 列表与缩略图两条路都用它，免得两边各算一次、算歪了就是「列得出来但读不到图」。
 */
function resolveStickerDir(configRow) {
  const stickers = configRow.value.stickers ?? {}
  const rawDir = str(stickers.dir) === '' ? '~/.dsh/stickers' : str(stickers.dir)
  if (rawDir === '~') return homedir()
  return rawDir.startsWith('~/') ? join(homedir(), rawDir.slice(2)) : rawDir
}

/** 允许预览的图片类型（不收 svg：它能带脚本）。 */
const STICKER_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 单张图上限：面板只做预览，超大的图不该顺着这个接口灌进浏览器。 */
const STICKER_MAX_BYTES = 5 * 1024 * 1024

/**
 * 阶段 9.4 补：表情包缩略图。
 *
 * 浏览器读不了 `~/.dsh/stickers`（那是宿主的磁盘），所以面板里的预览必须由宿主读给它。
 * 安全靠两条硬规则：
 *  1. `basename(file) === file` —— 挡住 `../` 与绝对路径，只能读该目录下的文件；
 *  2. 扩展名白名单 —— 挡住 svg（可带脚本）以及目录里的任何非图片文件。
 */
async function handleStickerImageGet(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const dir = resolveStickerDir(configRow)
  const requested = str(url.searchParams.get('file') ?? '')
  const name = basename(requested)
  const ext = extname(name).toLowerCase()
  if (name === '' || name !== requested || !(ext in STICKER_MIME)) {
    return json(res, 400, { ok: false, error: '只支持读取表情包目录里的图片文件' })
  }
  const abs = join(dir, name)
  let size = 0
  try {
    size = statSync(abs).size
  } catch {
    return json(res, 404, { ok: false, error: `文件不存在：${name}` })
  }
  if (size > STICKER_MAX_BYTES) {
    return json(res, 413, { ok: false, error: `图片超过 5 MiB：${name}` })
  }
  let body
  try {
    body = readFileSync(abs)
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
  res.writeHead(200, {
    'content-type': STICKER_MIME[ext],
    'content-length': body.length,
    // 文件名一般不变、内容偶尔替换：5 分钟够用，别每次展开卡片都重读一遍
    'cache-control': 'private, max-age=300',
    'content-disposition': 'inline',
  })
  res.end(body)
}

/**
 * 阶段 9.4：表情包。
 *
 * 图片不进仓库（阶段 9.2 定的），所以这里只负责**列出目录里实际有什么**：
 * `exists=false` 说明 stickers.json 里写了但文件不在，前端用红色标出来——
 * 这比"贴了图但显示不出来"好排查得多。
 */
async function handleStickersGet(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const stickers = configRow.value.stickers ?? {}
  const dir = resolveStickerDir(configRow)

  let items = []
  let error = ''
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'stickers.json'), 'utf8'))
    const list = Array.isArray(parsed.items) ? parsed.items : []
    items = list
      .filter((item) => item && typeof item.file === 'string')
      .map((item) => ({
        id: str(item.id),
        label: str(item.label),
        file: str(item.file),
        when: str(item.when),
        exists: existsSync(join(dir, str(item.file))),
      }))
  } catch (err) {
    // 目录不存在是常态（图片不进仓库），这里不当错误刷屏，只回一句可读的提示
    error = `没有读到 ${join(dir, 'stickers.json')}`
  }

  return json(res, 200, {
    ok: true,
    value: {
      enabled: stickers.enabled !== false,
      dir,
      maxPerTurn: Number.isFinite(stickers.maxPerTurn) ? stickers.maxPerTurn : 1,
      items,
      error,
    },
  })
}

const STICKER_LABEL_MAX = 24
const STICKER_WHEN_MAX = 160
const STICKER_NOTE_MAX = 200
const STICKER_NAME_MAX = 60
/** 上传体上限：base64 约为原始字节的 4/3，5 MiB 的图约 6.8 MB，留 8 MiB 余量 */
const STICKER_UPLOAD_LIMIT = 8 * 1024 * 1024

/** 自定义表情的 id：custom-N 递增，别去改已有条目占用的编号 */
function nextCustomStickerId(items) {
  let max = 0
  for (const item of Array.isArray(items) ? items : []) {
    const match = /^custom-(\d+)$/.exec(str(item?.id))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `custom-${max + 1}`
}

/** 备份文件名后缀：带上时分秒，出问题时一眼能看出是哪次写入前的版本 */
function timestampSuffix() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 阶段 9.4 补：在线添加表情包。
 *
 * 浏览器读不到宿主磁盘，所以只能把图 base64 传上来、由宿主落盘。读写规则与预览接口同源
 * （扩展名白名单、5 MiB 上限、只认 basename），写入侧另加三条：
 *  1. 同名文件已存在就拒绝——那是用户自己放进去的图，不覆盖；
 *  2. 先落图片、再写 stickers.json；清单写失败就把刚落的图删掉，不留「清单里没有的孤儿图」；
 *  3. 写清单前先备份、写走 tmp + rename：坏在半路也不会留下半截 JSON。
 *
 * 为什么「什么时候用」必填：模型就是靠这一句话决定贴哪张，缺了它这张图永远贴不出来。
 */
async function handleStickerAdd(ctx, res, req) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const stickers = configRow.value.stickers ?? {}
  const dir = resolveStickerDir(configRow)

  const body = await readJsonBody(req, STICKER_UPLOAD_LIMIT)
  if (!body.ok) return json(res, 413, { ok: false, error: `${body.error}（单张图片上限 5 MiB）` })
  const input = body.value && typeof body.value === 'object' ? body.value : {}

  const label = str(input.label).trim()
  const when = str(input.when).trim()
  const note = str(input.note).trim()
  if (label === '') return json(res, 400, { ok: false, error: '名称不能为空' })
  if (label.length > STICKER_LABEL_MAX) return json(res, 400, { ok: false, error: `名称不能超过 ${STICKER_LABEL_MAX} 个字` })
  if (when === '') return json(res, 400, { ok: false, error: '「什么时候用」不能为空：模型靠它决定贴哪张' })
  if (when.length > STICKER_WHEN_MAX) return json(res, 400, { ok: false, error: `「什么时候用」不能超过 ${STICKER_WHEN_MAX} 个字` })
  if (note.length > STICKER_NOTE_MAX) return json(res, 400, { ok: false, error: `外观描述不能超过 ${STICKER_NOTE_MAX} 个字` })

  const rawFile = input.file && typeof input.file === 'object' ? input.file : {}
  const dataUrl = str(rawFile.dataUrl)
  const parsedUrl = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl)
  if (parsedUrl === null) {
    return json(res, 400, { ok: false, error: '图片数据格式不对（需要 data:image/…;base64,…）' })
  }
  const mime = parsedUrl[1].trim().toLowerCase()
  const ext = Object.keys(STICKER_MIME).find((candidate) => STICKER_MIME[candidate] === mime)
  if (ext === undefined) {
    return json(res, 400, { ok: false, error: '只支持 png / jpeg / webp / gif（不收 svg，它能带脚本）' })
  }

  let buffer
  try {
    buffer = Buffer.from(parsedUrl[2].replace(/\s+/g, ''), 'base64')
  } catch {
    return json(res, 400, { ok: false, error: '图片内容无法解码' })
  }
  if (buffer.length === 0) return json(res, 400, { ok: false, error: '图片内容为空' })
  if (buffer.length > STICKER_MAX_BYTES) {
    return json(res, 413, { ok: false, error: `图片超过 ${Math.round(STICKER_MAX_BYTES / 1024 / 1024)} MiB` })
  }

  // 文件名：取原名的 basename，扩展名以 MIME 为准——名字叫 .png 而内容其实是 jpeg 时，
  // 直接沿用原名会让浏览器按错的内容类型解码
  const rawName = str(rawFile.name).trim()
  const stem = rawName === '' ? label : basename(rawName).replace(/\.[^.]*$/, '')
  // 去掉路径分隔符与 Windows 保留字符；控制字符一并清掉，免得文件名里藏换行
  const safeStem = stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, STICKER_NAME_MAX)
  const fileName = `${safeStem === '' ? 'sticker' : safeStem}${ext}`

  const jsonPath = join(dir, 'stickers.json')
  let doc
  if (existsSync(jsonPath)) {
    try {
      doc = JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch {
      // 坏 JSON 不覆盖：里面可能是手写到一半的定义，吞掉等于把已有表情包删了
      return json(res, 500, { ok: false, error: `${jsonPath} 不是合法 JSON，先修好再加` })
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return json(res, 500, { ok: false, error: `${jsonPath} 结构不对（需要对象），先修好再加` })
    }
  } else {
    // 目录/清单都没有是常态（图片不进仓库），那就按默认起一个新清单
    doc = {
      version: 1,
      maxPerTurn: Number.isFinite(stickers.maxPerTurn) ? stickers.maxPerTurn : 1,
      items: [],
    }
  }
  if (!Array.isArray(doc.items)) doc.items = []

  if (existsSync(join(dir, fileName))) {
    return json(res, 409, { ok: false, error: `同名文件已存在：${fileName}（换个名字再传，不覆盖已有的图）` })
  }

  try {
    mkdirSync(dir, { recursive: true })
    const tmpImage = join(dir, `.${fileName}.tmp-${process.pid}`)
    writeFileSync(tmpImage, buffer)
    renameSync(tmpImage, join(dir, fileName))
  } catch (error) {
    return json(res, 500, { ok: false, error: `图片保存失败：${String(error?.message ?? error)}` })
  }

  const item = { id: nextCustomStickerId(doc.items), label, file: fileName, when, ...(note === '' ? {} : { note }) }
  doc.items.push(item)

  try {
    if (existsSync(jsonPath)) copyFileSync(jsonPath, `${jsonPath}.bak-${timestampSuffix()}`)
    const tmpJson = `${jsonPath}.tmp-${process.pid}`
    writeFileSync(tmpJson, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    renameSync(tmpJson, jsonPath)
  } catch (error) {
    // 清单没写成：撤掉刚落的图，保持「目录里有什么」与「清单里有什么」一致
    try {
      unlinkSync(join(dir, fileName))
    } catch {
      // 删不掉就留下孤儿图，比留下一条指向不存在文件的清单好
    }
    return json(res, 500, { ok: false, error: `stickers.json 写入失败：${String(error?.message ?? error)}` })
  }

  return json(res, 200, {
    ok: true,
    value: { id: item.id, file: fileName, label, when, total: doc.items.length },
  })
}

/**
 * 阶段 9.4：日记。
 *
 * 取「我这边发生过什么」：人格与自述条目的状态变迁（active / archived），按更新时间倒序。
 * 刻意不混入记忆浏览的主列表——那是"我知道什么"，这里是"我怎么变成现在这样"。
 */
async function handleDiaryGet(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size') ?? '30', 10) || 30))

  const [result, journalResult] = await Promise.all([
    client.search(names.personal, {
      size,
      _source: ['memory_id', 'content', 'status', 'memory_type', 'updated_at'],
      sort: [{ updated_at: 'desc' }],
      query: {
        bool: {
          filter: [
            { terms: { memory_type: ['persona', 'identity'] } },
            { terms: { status: ['active', 'archived'] } },
          ],
        },
      },
    }),
    // 「每日回顾」是另一类：按天一段，直接生效（不进审核队列）
    client.search(names.personal, {
      size: 30,
      _source: ['memory_id', 'content', 'created_at', 'updated_at', 'day'],
      sort: [{ created_at: 'desc' }],
      query: { bool: { filter: [{ term: { memory_type: 'journal' } }] } },
    }),
  ])

  const rows = (result.hits?.hits ?? []).map((hit) => ({
    memoryId: str(hit._source?.memory_id),
    content: str(hit._source?.content),
    status: str(hit._source?.status),
    memoryType: str(hit._source?.memory_type),
    updatedAt: str(hit._source?.updated_at),
  }))
  const journals = (journalResult.hits?.hits ?? []).map((hit) => {
    const source = (hit._source ?? {})
    const day = typeof source.day === 'string' && source.day !== ''
      ? source.day
      : String(source.created_at ?? '').slice(0, 10)
    return {
      date: day,
      content: String(source.content ?? ''),
      memoryId: String(source.memory_id ?? ''),
    }
  })
  return json(res, 200, { ok: true, value: { rows, journals } })
}

async function handleIdentityPending(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size') ?? '20', 10) || 20))
  const result = await client.search(names.personal, {
    size,
    _source: ['memory_id', 'content', 'memory_type', 'evidence_ids', 'created_at'],
    sort: [{ created_at: 'desc' }],
    // 阶段 9.4：人格候选也走这个闸门（approve 之后才进提示段）
    query: { bool: { filter: [{ term: { status: 'pending' } }, { terms: { memory_type: ['identity', 'persona'] } }] } },
  })
  const rows = (result.hits?.hits ?? []).map((hit) => ({
    memoryId: str(hit._source?.memory_id),
    content: str(hit._source?.content),
    memoryType: str(hit._source?.memory_type),
    evidenceCount: Array.isArray(hit._source?.evidence_ids) ? hit._source.evidence_ids.length : 0,
    createdAt: str(hit._source?.created_at),
  }))
  return json(res, 200, { ok: true, value: { rows } })
}

/** 采纳 / 拒绝一条候选。规则与 src/memory/review.ts 必须一致（两份实现，改一处要改两处）。 */
async function handleIdentityReview(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const memoryId = str(body.value.memory_id)
  const action = str(body.value.action)
  const note = str(body.value.note)
  if (memoryId === '') return json(res, 400, { ok: false, error: '缺少 memory_id' })
  if (action !== 'approve' && action !== 'reject' && action !== 'anchor') {
    return json(res, 400, { ok: false, error: 'action 只能是 approve / reject / anchor' })
  }

  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const writer = createReadClient(() => resolveClientConfig(ctx, 'personal-writer'))
  const reader = createReadClient(() => resolveClientConfig(ctx))

  // 先读校验：只有 pending + (identity | persona) 能动
  const found = await reader.search(names.personal, {
    size: 1,
    query: { bool: { filter: [{ term: { memory_id: memoryId } }] } },
    _source: ['memory_id', 'status', 'memory_type'],
  })
  const src = found.hits?.hits?.[0]?._source
  if (!src) return json(res, 404, { ok: false, error: `找不到条目 ${memoryId}` })
  if (!['identity', 'persona'].includes(str(src.memory_type))) {
    return json(res, 409, { ok: false, error: `这条是 ${str(src.memory_type) || '未知'}，不能走采纳闸门（只收 identity / persona）` })
  }
  if (str(src.status) !== 'pending') return json(res, 409, { ok: false, error: `这条当前状态是 ${str(src.status)}（只有 pending 能被采纳）` })

  // 锚点：不改 status，只改 anchor 标志（规则与 src/memory/review.ts 的 setAnchor 一致）
  if (action === 'anchor') {
    // 与 src/memory/review.ts 的 setAnchor 同规则：只有 identity 且 active 才能设锚点
    if (String(src.memory_type) !== 'identity') {
      return json(res, 409, { ok: false, error: `这条的类型是 ${String(src.memory_type) || '未知'}，不是 identity，不能设锚点` })
    }
    if (String(src.status) !== 'active') {
      return json(res, 409, { ok: false, error: `只有生效中的自述能设锚点（当前 ${String(src.status)}）` })
    }
    const anchor = body.value.anchor !== false
    const anchorAt = new Date().toISOString()
    await writer.update(names.personal, memoryId, { anchor, updated_at: anchorAt }, { refresh: 'wait_for' })
    // 审计必须与工具层同口径：面板点一下和 memory_review 调一次，审核流水里都该有一条
    const anchorAudit = {
      event: anchor ? 'identity_anchor_set' : 'identity_anchor_cleared',
      actor: config.identity.userId,
      at: anchorAt,
      subject_type: 'personal_memory',
      subject_id: memoryId,
      memory_id: memoryId,
      from_state: 'active',
      to_state: 'active',
      reason: anchor ? 'identity_anchor_set' : 'identity_anchor_cleared',
      note: anchor ? '设为锚点：提炼不再归纳它' : '取消锚点',
    }
    let anchorAuditState = 'personal_only'
    try {
      await writer.index(names.personalAudit, anchorAudit, { refresh: 'wait_for' })
      try {
        const consolidator = createReadClient(() => resolveClientConfig(ctx, 'consolidator'))
        await consolidator.index(names.audit, anchorAudit, { refresh: 'wait_for' })
        anchorAuditState = 'ok'
      } catch {
        /* 团队库写不了就只留个人那份 */
      }
    } catch {
      anchorAuditState = 'failed'
    }
    return json(res, 200, { ok: true, value: { memoryId, status: 'active', anchor, audit: anchorAuditState } })
  }

  const target = action === 'approve' ? 'active' : 'archived'
  const at = new Date().toISOString()
  await writer.update(
    names.personal,
    memoryId,
    { status: target, updated_at: at, reviewed_at: at, reviewed_by: config.identity.userId, ...(note === '' ? {} : { review_note: note }) },
    { refresh: 'wait_for' },
  )

  // 审计：个人那份必写，共享那份尽力（与工具侧同口径）
  const auditDoc = {
    event: action === 'approve' ? 'identity_approved' : 'identity_rejected',
    actor: config.identity.userId,
    at,
    subject_type: 'personal_memory',
    subject_id: memoryId,
    memory_id: memoryId,
    from_state: 'pending',
    to_state: target,
    reason: action === 'approve' ? 'identity_approved' : 'identity_rejected',
    ...(note === '' ? {} : { note }),
  }
  let audit = 'personal_only'
  try {
    await writer.index(names.personalAudit, auditDoc, { refresh: 'wait_for' })
    audit = 'ok'
    try {
      const consolidator = createReadClient(() => resolveClientConfig(ctx, 'consolidator'))
      await consolidator.index(names.audit, auditDoc, { refresh: 'wait_for' })
    } catch {
      audit = 'personal_only'
    }
  } catch (err) {
    audit = 'failed'
  }

  return json(res, 200, { ok: true, value: { memoryId, status: target, audit } })
}

/** 生效中的自述（status=active 的 identity）+ 锚点状态（阶段 7.5） */
async function handleIdentityActive(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size') ?? '50', 10) || 50))
  const result = await client.search(names.personal, {
    size,
    _source: ['memory_id', 'content', 'anchor', 'updated_at', 'supersedes'],
    sort: [{ updated_at: 'desc' }],
    query: { bool: { filter: [{ term: { status: 'active' } }, { term: { memory_type: 'identity' } }] } },
  })
  const rows = (result.hits?.hits ?? []).map((hit) => ({
    memoryId: str(hit._source?.memory_id),
    content: str(hit._source?.content),
    anchor: hit._source?.anchor === true,
    updatedAt: str(hit._source?.updated_at),
    hasHistory: str(hit._source?.supersedes) !== '',
  }))
  return json(res, 200, { ok: true, value: { rows } })
}

/** 版本链（阶段 7.4）：沿 supersedes 向旧、superseded_by 向新，最多 10 跳 */
async function handleIdentityVersions(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const memoryId = str(url.searchParams.get('memory_id'))
  if (memoryId === '') return json(res, 400, { ok: false, error: '缺少 memory_id' })

  const readOne = async (id) => {
    const found = await client.search(names.personal, {
      size: 1,
      query: { bool: { filter: [{ term: { memory_id: id } }] } },
      _source: ['memory_id', 'content', 'status', 'supersedes', 'superseded_by', 'created_at'],
    })
    return found.hits?.hits?.[0]?._source ?? null
  }

  const start = await readOne(memoryId)
  if (start === null) return json(res, 200, { ok: true, value: { rows: [] } })

  const versions = [{ ...start, offset: 0 }]
  const seen = new Set([memoryId])

  let cursor = start
  for (let hop = 0; hop < 10; hop += 1) {
    const prev = str(cursor.supersedes)
    if (prev === '' || seen.has(prev)) break
    const doc = await readOne(prev)
    if (doc === null) break
    seen.add(prev)
    versions.unshift({ ...doc, offset: -(hop + 1) })
    cursor = doc
  }
  cursor = start
  for (let hop = 0; hop < 10; hop += 1) {
    const next = str(cursor.superseded_by)
    if (next === '' || seen.has(next)) break
    const doc = await readOne(next)
    if (doc === null) break
    seen.add(next)
    versions.push({ ...doc, offset: hop + 1 })
    cursor = doc
  }

  return json(res, 200, {
    ok: true,
    value: {
      rows: versions.map((v) => ({
        memoryId: str(v.memory_id),
        content: str(v.content),
        status: str(v.status),
        createdAt: str(v.created_at),
        offset: v.offset,
      })),
    },
  })
}

/** 个人审核流水（阶段 7.3 补强） */
async function handlePersonalAudit(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size') ?? '20', 10) || 20))
  try {
    const result = await client.search(names.personalAudit, {
      size,
      sort: [{ at: 'desc' }],
      query: { match_all: {} },
    })
    const rows = (result.hits?.hits ?? []).map((hit) => ({
      event: str(hit._source?.event),
      at: str(hit._source?.at),
      memoryId: str(hit._source?.memory_id),
      from: str(hit._source?.from_state),
      to: str(hit._source?.to_state),
      note: str(hit._source?.note),
    }))
    return json(res, 200, { ok: true, value: { rows } })
  } catch (err) {
    // 索引还没建时是 404：当作"还没有记录"，不当错误
    return json(res, 200, { ok: true, value: { rows: [], note: String(err).slice(0, 160) } })
  }
}

async function handlePending(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size') ?? '20', 10) || 20))
  const page = Math.max(0, Number.parseInt(url.searchParams.get('page') ?? '0', 10) || 0)

  const result = await client.search(names.team, {
    from: page * size,
    size,
    _source: { excludes: ['embedding'] },
    query: pendingQuery(),
    // promoted_at 有并列（同一次整理推上来的），补 doc_id 保证翻页稳定。
    // 注意不能用 _id：ES 默认禁止对 _id 做 fielddata 排序（400 实测过）。
    sort: [{ promoted_at: 'asc' }, { doc_id: 'asc' }],
  })
  const rows = (result.hits?.hits ?? []).map((hit) => {
    const row = projectHit(hit, 'team')
    return { ...row, conflictWith: str(hit._source?.conflict_with), reviewState: str(hit._source?.review_state) }
  })

  // 冲突对象的内容也取出来给人对照（最多 5 个不同的 conflict_with）
  const wanted = [...new Set(rows.map((row) => row.conflictWith).filter(Boolean))].slice(0, 5)
  let conflicts = []
  if (wanted.length > 0) {
    const found = await client.search(names.team, {
      size: wanted.length,
      _source: { excludes: ['embedding'] },
      query: { terms: { doc_id: wanted } },
    })
    conflicts = (found.hits?.hits ?? []).map((hit) => projectHit(hit, 'team'))
  }

  json(res, 200, {
    ok: true,
    value: {
      total: num(result.hits?.total?.value),
      page,
      size,
      rows,
      conflicts,
      canWrite: canReviewTeam(config.identity),
    },
  })
}

/**
 * 审核动作：approve / reject / withdraw。
 * 与 `consolidate/review.ts` 保持一致：approve→approved、reject→rejected+reason、
 * withdraw→status=superseded（不物理删），每个动作都写一条 `memory_audit`。
 */
async function handleReviewAction(ctx, res, docId, action, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const input = body.value ?? {}
  const reason = str(input.reason).trim()
  if ((action === 'reject' || action === 'withdraw') && reason === '') {
    return json(res, 400, { ok: false, error: `${action} 必须填写原因` })
  }
  if (input.confirm !== true) {
    return json(res, 400, { ok: false, error: '缺少 confirm:true（写操作要显式确认）' })
  }

  // 权限前置：团队库写入只允许整理身份。普通账号（只有 reader/writer）不该走到构造客户端那步再报 500
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const identity = configRow.value.identity
  if (!canReviewTeam(identity)) {
    return json(res, 403, {
      ok: false,
      error: '当前部署没有配置整理身份（identity.consolidatorPassword），审核动作不可用；请联系管理员',
    })
  }

  // 审计要能追到"谁"：actor 统一带 userId（panel:xqh），因为免费版 ES 没有安全审计日志，
  // memory_audit 是唯一的人维度证据。
  // ⚠️ 不能取请求体里的 actor：那是调用方说了算，直接调 API 就能把「谁批的」写成别人
  // （2026-10-31 巡检发现 `actor: 'cli:someone'` 会原样落进审计与 reviewed_by）。
  const actor = `panel:${identity.userId}`

  const config = configRow.value
  const names = indexNames(config)
  const writeClient = createReadClient(() => resolveClientConfig(ctx, 'consolidator'))

  // 先读一次当前状态：只允许对 pending 做 approve/reject，避免重复点
  const current = await writeClient.search(names.team, {
    size: 1,
    _source: ['doc_id', 'review_state', 'status', 'content'],
    query: { ids: { values: [docId] } },
  })
  const hit = current.hits?.hits?.[0]
  if (!hit) return json(res, 404, { ok: false, error: `团队库里没有 doc（ES id=${docId}）` })
  const currentState = str(hit._source?.review_state)
  const currentStatus = str(hit._source?.status)
  if (currentStatus !== 'active') {
    return json(res, 409, { ok: false, error: `该条目当前 status=${currentStatus}，不是 active，不能${action}` })
  }
  if ((action === 'approve' || action === 'reject') && currentState !== 'pending') {
    return json(res, 409, { ok: false, error: `该条目当前 review_state=${currentState}，不是 pending` })
  }

  const now = new Date().toISOString()
  const patch = {}
  if (action === 'approve') {
    Object.assign(patch, { review_state: 'approved', reviewed_at: now, reviewed_by: actor, updated_at: now })
  } else if (action === 'reject') {
    Object.assign(patch, {
      review_state: 'rejected',
      status: 'rejected',
      reject_reason: reason,
      reviewed_at: now,
      reviewed_by: actor,
      updated_at: now,
    })
  } else {
    Object.assign(patch, { status: 'superseded', reviewed_at: now, reviewed_by: actor, updated_at: now })
  }

  const updated = await writeClient.update(names.team, docId, patch, { refresh: 'wait_for' })

  // 审计：失败不影响主操作（与 CLI 一致），但要在响应里说明
  const auditDoc = {
    event: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'withdrawn',
    actor,
    at: now,
    subject_type: 'team_doc',
    subject_id: docId,
    team_doc_id: docId,
    ...(action === 'approve' ? { from_state: 'pending', to_state: 'approved' } : {}),
    ...(action === 'reject' ? { from_state: 'pending', to_state: 'rejected' } : {}),
    ...(action === 'withdraw' ? { to_state: 'superseded' } : {}),
    ...(reason === '' ? {} : { reason }),
  }
  let auditWritten = true
  try {
    await writeClient.index(names.audit, auditDoc, { refresh: 'wait_for' })
  } catch (error) {
    auditWritten = false
    console.error(`[memory-es-panel] 审计写入失败 ${action} ${docId}: ${String(error?.message ?? error)}`)
  }

  json(res, 200, {
    ok: true,
    value: { docId, action, result: updated?.result ?? 'unknown', auditWritten, at: now },
  })
}

/**
 * 可编辑的配置字段（只暴露安全的几个；密码不进面板）。
 *
 * ⚠️ **`es.url` / `es.caCertPath` 刻意不在这里**（2026-10-31 巡检收窄）：
 * 它们是"把 Basic Auth 凭据发往哪个地址"的开关。放进可写面，等于会话被盗后
 * 能把 `mem-admin` 的凭据导到任意主机（改 CA 还能顺带绕过校验）。
 * 而改完本来也要重启 dsh 才生效（面板自己会提示 restartRequired），
 * 所以走 profile 的 `cordis.patch.yml` 手动改，收益不比面板低、攻击面小得多。
 */
const EDITABLE = [
  { path: ['es', 'requestTimeoutMs'], label: '请求超时(ms)', type: 'number', default: 8000 },
  { path: ['index', 'team'], label: '团队库索引名', type: 'string', default: 'team_knowledge' },
  { path: ['embedding', 'url'], label: 'Embedding 地址', type: 'string', default: 'http://127.0.0.1:11434' },
  { path: ['embedding', 'model'], label: 'Embedding 模型', type: 'string', default: 'bge-m3' },
  { path: ['embedding', 'dims'], label: '向量维度', type: 'number', default: 1024 },
  { path: ['defaults', 'domain'], label: '默认 domain', type: 'string', default: 'general' },
  // 自动蒸馏：默认关，打开后每次 memory_save 会在后台多花一次模型调用
  { path: ['distill', 'enabled'], label: '入库自动蒸馏', type: 'boolean', default: false, hint: '打开后每次保存会后台调一次模型（花 token，但检索更准）' },
  { path: ['distill', 'model'], label: '蒸馏模型', type: 'string', default: '', hint: '留空 = 用宿主第一个可用模型' },
  { path: ['distill', 'timeoutMs'], label: '蒸馏超时(ms)', type: 'number', default: 30000 },
  // 阶段 9.4：人格内核允许在面板里直接改（改完写回 profile 配置，热重载后下一轮提示词生效）
  { path: ['persona', 'seed'], label: '人格内核', type: 'string', default: '', hint: '这段文字会进系统提示词；留空即不注入人格' },
  { path: ['persona', 'enabled'], label: '启用人格', type: 'boolean', default: true },
  // 阶段 9.5：每日回顾（默认开；关掉后不再调模型，已有日记保留）
  {
    path: ['journal', 'enabled'],
    label: '每日回顾',
    type: 'boolean',
    default: true,
    hint: '每天到点把当天对话压成一段，写进「人格 → 日记」的回顾栏；关掉后不再调模型',
  },
  {
    path: ['journal', 'at'],
    label: '回顾时间',
    type: 'string',
    default: '23:30',
    hint: 'HH:MM（本地时区）。过了点会补跑；同一天只写一次',
  },
  // 阶段 9.6：每日自动提炼（产物仍是待审核候选，不会自己改行为）
  {
    path: ['traits', 'enabled'],
    label: '每日自动提炼',
    type: 'boolean',
    default: true,
    hint: '每天到点替你跑一次 memory_traits；产出仍是待审核候选，采纳要人工点',
  },
  {
    path: ['traits', 'at'],
    label: '提炼时间',
    type: 'string',
    default: '02:30',
    hint: 'HH:MM（本地时区），默认 02:30',
  },
  {
    path: ['traits', 'days'],
    label: '回看天数',
    type: 'number',
    default: 14,
    hint: '提炼时回看最近多少天的记忆（1~90）',
  },
  {
    path: ['traits', 'maxPerDay'],
    label: '每天最多候选',
    type: 'number',
    default: 5,
    hint: '跨多次运行累计（定时一次 + 手动几次都算），默认 5',
  },
  {
    path: ['traits', 'maxOutput'],
    label: '单次上限',
    type: 'number',
    default: 5,
    hint: '一次模型调用最多接受几条，默认 5',
  },
  {
    path: ['traits', 'dedupMinScore'],
    label: '判重阈值',
    type: 'number',
    default: 0.88,
    hint: '同义判定的 kNN 余弦阈值，越高越严（0.7~0.99），默认 0.88',
  },
  {
    path: ['traits', 'dedupMinScoreAnchored'],
    label: '锚定条目阈值',
    type: 'number',
    default: 0.82,
    hint: '对已设锚点（定稿）的自述判重更严（0.6~0.99），默认 0.82',
  },
  // 阶段 12：检索侧三个开关（默认都不改变现有行为）
  {
    path: ['retrieval', 'defaultDetail'],
    label: '缺省返回详略',
    type: 'string',
    default: 'full',
    hint: 'full = 正文最多 500 字（默认）；summary = 摘要 + 120 字，省 ~73% token，模型需要时用 memory_get 展开',
  },
  {
    path: ['retrieval', 'maxPerDomain'],
    label: '同域条数上限',
    type: 'number',
    default: 0,
    hint: '结果多样化：同一 domain 最多保留几条（0 = 关闭，默认关）',
  },
  {
    path: ['ranking', 'utilityWeight'],
    label: '效用信号强度',
    type: 'number',
    default: 0,
    hint: '按 👍/👎 提权：score × (1 + w × log1p(点赞−点踩))；0 = 关闭（默认），负效用不惩罚',
  },
  // 阶段 12：命中后供给（会改变回答风格，默认关）
  {
    path: ['prompt', 'citation'],
    label: '回答标注出处',
    type: 'boolean',
    default: false,
    hint: '打开后模型引用记忆时会标 id 前 8 位；会改变回答风格，默认关',
  },
]

function pick(config, path) {
  let node = config
  for (const key of path) node = node?.[key]
  return node
}

/** GET /config：当前值 + 可编辑字段 + 只读的索引/身份概要（不含密码） */
async function handleConfigGet(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const value = configRow.value
  json(res, 200, {
    ok: true,
    value: {
      fields: EDITABLE.map((field) => {
        // 未显式配置时**不能**渲染成 0：0 会被当成"生效值"，而实际生效的是 schema 默认值。
        // 2026-11-01 用户看到 traits 四项全是 0 来问，就是这条占位逻辑的锅。
        const raw = pick(value, field.path)
        const missing = raw === undefined || raw === null
        return {
          key: field.path.join('.'),
          label: field.label,
          type: field.type,
          value: missing ? field.default : raw,
          isDefault: missing,
        }
      }),
      readonly: {
        entryLabel: configRow.label ?? '',
        personalIndex: `${value.index.personalPrefix}${value.identity.userId}`,
        teamIndex: value.index.team,
        auditIndex: AUDIT_INDEX,
        userId: value.identity.userId,
        // 连接目标只读展示：改它请编辑 profile 的 cordis.patch.yml 并重启（见 EDITABLE 的注释）
        es: `${value.es.url}（CA：${value.es.caCertPath || '系统信任库'}）`,
        reader: value.identity.readUsername,
        writer: value.identity.writerUsername,
        consolidator: value.identity.consolidatorUsername,
        consolidatorConfigured: Boolean(value.identity.consolidatorPassword),
        embedding: `${value.embedding.model} @ ${value.embedding.url} (${value.embedding.dims}d)`,
      },
    },
  })
}

/** POST /config：只改白名单字段，走 configEditor.edit（校验 + Loader 正常路径落盘） */
async function handleConfigWrite(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const input = body.value ?? {}
  if (input.confirm !== true) return json(res, 400, { ok: false, error: '缺少 confirm:true' })

  const editor = ctx.configEditor
  const rows = editor.configuration()
  const target = rows.find((item) => {
    const entry = item.entry ?? {}
    return [entry.id, entry.name].some(
      (label) => typeof label === 'string' && (label === ENTRY_ID || label.endsWith(`:${ENTRY_ID}`)),
    )
  })
  if (!target) return json(res, 503, { ok: false, error: `没有找到 ${ENTRY_ID} 的配置行，无法写入` })

  const rawChanges = Array.isArray(input.changes) ? input.changes : []
  /**
   * configEditor 把多行字符串序列化成**折叠标量**（`>`），而折叠会把单换行变成空格 ——
   * 人格内核粘成一行就毁了段落结构（2026-10-31 实测：存完文件里从 `seed: |` 变成 `seed: >`）。
   * 对策：写入前把单换行补成一个空行，折叠后正好还原成原来的换行。
   * 这里同时留一份原始值，供写后校验比对。
   */
  const seedDraft = rawChanges.find((c) => c?.key === 'persona.seed')?.value
  const changes = rawChanges.map((c) =>
    c?.key === 'persona.seed'
      ? { ...c, value: String(c.value ?? '').replace(/\n(?!\n)/g, '\n\n') }
      : c,
  )
  if (changes.length === 0) return json(res, 400, { ok: false, error: '没有要修改的字段' })

  const allowed = new Set(EDITABLE.map((field) => field.path.join('.')))
  for (const change of changes) {
    if (typeof change?.key !== 'string' || !allowed.has(change.key)) {
      return json(res, 400, { ok: false, error: `不可修改的字段：${change?.key}` })
    }
  }

  // 人格内核是自由文本，但要有上限：配置里塞进几十万字符会让每轮提示词组装变慢
  for (const change of changes) {
    if (change.key === 'persona.seed') {
      const text = String(change.value ?? '')
      if (text.length > 20000) {
        return json(res, 400, { ok: false, error: `人格内核过长（${text.length} 字，上限 20000）` })
      }
    }
  }

  // 保存前校验：写错配置要当场拦住，而不是等重启后 dsh 连不上 ES 才发现
  const currentRow = findEntryRow(ctx)
  const currentValue = currentRow.ok ? currentRow.value : null
  const patched = currentValue ? JSON.parse(JSON.stringify(currentValue)) : {}

  // 转换结果一次算好，校验与写盘共用同一份，避免两处逻辑漂移
  const resolved = new Map()
  for (const change of changes) {
    const [group, key] = change.key.split('.')
    const value = coerceFieldValue(change)
    resolved.set(change.key, value)
    const declaredType = fieldTypeOf(change.key) ?? change.type
    if (declaredType === 'boolean' && typeof value !== 'boolean') {
      return json(res, 400, { ok: false, error: `${change.key} 只能是 true/false` })
    }
    if (declaredType === 'number' && !Number.isFinite(value)) {
      return json(res, 400, { ok: false, error: `${change.key} 必须是数字` })
    }
    if (patched[group] === undefined || patched[group] === null) patched[group] = {}
    patched[group][key] = value

    if (change.key === 'es.requestTimeoutMs' && (value < 500 || value > 60000)) {
      return json(res, 400, { ok: false, error: '请求超时应在 500~60000 毫秒之间' })
    }
    if (change.key === 'embedding.dims' && (!Number.isInteger(value) || value <= 0)) {
      return json(res, 400, { ok: false, error: '向量维度必须是正整数' })
    }
    if (change.key === 'journal.at' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
      return json(res, 400, { ok: false, error: `回顾时间要写成 HH:MM（00:00~23:59），现在是「${value}」` })
    }
    if (change.key === 'traits.at' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
      return json(res, 400, { ok: false, error: `提炼时间要写成 HH:MM（00:00~23:59），现在是「${value}」` })
    }
    if (change.key === 'traits.days' && (!Number.isInteger(value) || value < 1 || value > 90)) {
      return json(res, 400, { ok: false, error: `回看天数要是 1~90 的整数，现在是「${value}」` })
    }
    if (change.key === 'traits.maxPerDay' && (!Number.isInteger(value) || value < 1 || value > 50)) {
      return json(res, 400, { ok: false, error: `每天最多候选要是 1~50 的整数，现在是「${value}」` })
    }
    if (change.key === 'traits.maxOutput' && (!Number.isInteger(value) || value < 1 || value > 20)) {
      return json(res, 400, { ok: false, error: `单次上限要是 1~20 的整数，现在是「${value}」` })
    }
    if (change.key === 'traits.dedupMinScore' && (!Number.isFinite(value) || value < 0.7 || value > 0.99)) {
      return json(res, 400, { ok: false, error: `判重阈值要是 0.7~0.99 之间的小数，现在是「${value}」` })
    }
    if (change.key === 'traits.dedupMinScoreAnchored' && (!Number.isFinite(value) || value < 0.6 || value > 0.99)) {
      return json(res, 400, { ok: false, error: `锚定条目阈值要是 0.6~0.99 之间的小数，现在是「${value}」` })
    }
    // 阶段 12/13：这三个是**枚举/开关**，写错不是"不好看"——插件 apply() 里
    // validateConfig 不通过会直接 throw，下次重启整个插件都不加载。所以在这里拦住。
    if (change.key === 'retrieval.defaultDetail' && value !== 'full' && value !== 'summary') {
      return json(res, 400, { ok: false, error: `缺省返回详略只能是 full 或 summary，现在是「${value}」` })
    }
    if (change.key === 'retrieval.maxPerDomain' && (!Number.isInteger(value) || value < 0 || value > 20)) {
      return json(res, 400, { ok: false, error: `同域条数上限要是 0~20 的整数（0 = 关闭），现在是「${value}」` })
    }
    if (change.key === 'ranking.utilityWeight' && (!Number.isFinite(value) || value < 0 || value > 2)) {
      return json(res, 400, { ok: false, error: `效用信号强度要是 0~2 之间的小数（0 = 关闭），现在是「${value}」` })
    }
  }

  // 连接参数（es.url / caCertPath）不在可写白名单里，所以这里不再需要"改连接先探活"。
  // 探活本身也随之下线：它唯一的作用是防止把坏地址写进配置，而那个入口已经关掉。
  // （2026-10-31：这两个字段曾把「ES 凭据去哪个地址」变成面板可改的开关。）

  try {
    await editor.edit(target.entry, (current) => {
      // 其余键原样带回（configEditor 要求返回完整 raw config）
      const next = applyConfigChanges(current, changes, resolved)
      return next
    })
  } catch (error) {
    return json(res, 400, { ok: false, error: `写入失败：${String(error?.message ?? error)}` })
  }

  // 写后校验：人格内核必须真的落成提交的内容，不能"点了保存但文件里还是旧的"
  let seedWarn = ''
  if (typeof seedDraft === 'string' && seedDraft !== '') {
    const after = findEntryRow(ctx)
    const saved = after.ok ? String(after.value?.persona?.seed ?? '') : ''
    const norm = (text) => text.replace(/\s+/g, ' ').trim()
    if (norm(saved) !== norm(seedDraft)) {
      seedWarn = `人格内核读回不一致：提交 ${norm(seedDraft).length} 字、存下 ${norm(saved).length} 字。保存已写入但内容可能被折叠，请检查配置文件的 seed 段。`
    }
  }

  json(res, 200, {
    ok: true,
    value: {
      saved: changes.map((change) => change.key),
      ...(seedWarn ? { warn: seedWarn } : {}),
      // 关键提示：插件在 apply() 时建好 ES 客户端，配置变更必须重启 dsh 才真正生效
      restartRequired: true,
      note: '已保存到 profile 配置。ES 客户端在插件加载时建立，需重启 dsh 后才生效（容器里是 docker restart <容器名>）。',
    },
  })
}

/**
 * 探测「本人能不能删」：直接问 ES 的 `_has_privileges`，不看配置里的 teamWrite 声明。
 *
 * 为什么不信配置：teamWrite 只是"这个账号被设计成团队写"，而实际角色可能没给到（比如
 * 重跑 init-user 之前建的账号）。免费版 ES 没有安全审计日志，本人权限只有 ES 自己说得准。
 * 探测失败（旧版 ES、账号无该接口）一律按"不能删"处理，并带回原因让界面能解释。
 */
async function probeDeleteRights(ctx) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return { personal: false, team: false, note: configRow.error }
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))
  try {
    const [personal, team] = await Promise.all([
      client.hasIndexPrivileges(names.personal, ['delete']),
      client.hasIndexPrivileges(names.team, ['delete']),
    ])
    return {
      personal: personal?.has_all_requested === true,
      team: team?.has_all_requested === true,
      note: '',
    }
  } catch (error) {
    return { personal: false, team: false, note: `权限探测失败：${String(error?.message ?? error)}`.slice(0, 240) }
  }
}

/** GET /capabilities：当前部署能做到什么（前端据此决定显示哪些标签、哪些按钮可点） */
async function handleCapabilities(ctx, res) {
  const configRow = findEntryRow(ctx)
  const value = configRow.ok ? configRow.value : null
  const canReview = Boolean(value && canReviewTeam(value.identity))
  const del = await probeDeleteRights(ctx)
  json(res, 200, {
    ok: true,
    value: {
      // 审核 = 写团队库的能力；没有整理身份就是只读部署
      canReview,
      // 管理员 = 维护页 + 跨用户查看（与 canReview 同源，单独命名让前端读起来更清楚）
      canAdmin: canReview,
      canMaintain: cliAvailable(),
      // 删除按钮的显示条件：个人库问本人，团队库额外要求 team_knowledge 的 delete
      canDeletePersonal: del.personal,
      canDeleteTeam: del.team,
      deleteProbe: del.note,
      // 让界面能说明"你现在是什么身份"，而不是让人猜按钮为什么灰
      role: canReview ? 'reviewer' : 'reader',
      userId: value?.identity?.userId ?? '',
    },
  })
}

/** GET /facets：浏览页过滤器的候选值（domain / memory_type，按文档数降序） */
async function handleFacets(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx))

  const aggBody = {
    size: 0,
    query: { term: { status: 'active' } },
    aggs: {
      domains: { terms: { field: 'domain', size: 30 } },
      types: { terms: { field: 'memory_type', size: 30 } },
    },
  }
  const [personal, team] = await Promise.all([
    client.search(names.personal, aggBody).catch(() => ({ aggregations: {} })),
    client.search(names.team, aggBody).catch(() => ({ aggregations: {} })),
  ])

  const merge = (field) => {
    const buckets = new Map()
    for (const side of [personal, team]) {
      for (const bucket of side.aggregations?.[field]?.buckets ?? []) {
        buckets.set(bucket.key, (buckets.get(bucket.key) ?? 0) + bucket.doc_count)
      }
    }
    return [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }))
  }

  json(res, 200, { ok: true, value: { domains: merge('domains'), types: merge('types') } })
}

/** GET /maintenance/mirror?name=xxx.md：读镜像文件内容（只看不写） */
async function handleMirrorFile(ctx, res, url) {
  const name = (url.searchParams.get('name') ?? '').trim()
  // 镜像文件是团队库的导出视图，同样只给管理员看
  if (!requireAdmin(ctx, res)) return
  // 只允许镜像目录下的纯文件名：出现路径分隔符或 .. 一律拒绝
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.md')) {
    return json(res, 400, { ok: false, error: '文件名不合法（只接受镜像目录下的 .md 文件名）' })
  }
  const { existsSync, readFileSync, statSync } = await import('node:fs')

  const full = join(MIRROR_DIR, name)
  if (!existsSync(full)) return json(res, 404, { ok: false, error: `镜像目录里没有 ${name}` })

  const stat = statSync(full)
  if (stat.size > 256 * 1024) {
    return json(res, 200, {
      ok: true,
      value: { name, size: stat.size, mtime: stat.mtime.toISOString(), truncated: true, content: '' },
    })
  }
  json(res, 200, {
    ok: true,
    value: {
      name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      truncated: false,
      content: readFileSync(full, 'utf8'),
    },
  })
}

/**
 * 维护页状态：计数、最近整理、镜像目录、快照与定时任务的静态事实。
 *
 * 路径按 DSH_HOME 推导，**不能硬编码 /data/dsh**：那是容器里的 DSH_HOME，
 * 本机（非容器）没有写权限，跑整理会直接 `EACCES: mkdir '/data/dsh/memory-es-state'`。
 * 容器内 DSH_HOME=/data/dsh（路径与以前一致），本机回落到 ~/.dsh。
 * 两个环境变量留作逃生口（把状态放到别的卷上）。
 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = process.env.MEMORY_ES_STATE_DIR || join(DSH_HOME, 'memory-es-state')
const MIRROR_DIR = process.env.MEMORY_ES_MIRROR_DIR || join(DSH_HOME, 'memory-mirror')

async function handleMaintenanceGet(ctx, res, url) {
  // 维护页整体收拢到管理员：普通成员的维护 tab 也不再显示（前端），接口同样拦住
  const config = requireAdmin(ctx, res)
  if (!config) return
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  // 统计跟着"目标用户"走：否则选了别人整理，上面还显示自己的 267 条，很容易误读
  const wantUser = (url?.searchParams.get('user') ?? '').trim()
  if (wantUser !== '' && normalizeUserId(wantUser) === null) {
    return json(res, 400, { ok: false, error: 'user 参数不合法（只允许字母、数字、_ 和 -）' })
  }
  const targetUser = wantUser || config.identity.userId
  const personalIndex =
    targetUser === config.identity.userId ? names.personal : `${config.index.personalPrefix}${targetUser}`
  // 文档库也按目标用户算：前端那一行"文档数"以前永远是 '-'（接口根本没返回这个字段）
  const docsIndex =
    targetUser === config.identity.userId ? names.docs : `${config.index.docPrefix ?? 'personal_doc_'}${targetUser}`

  const { existsSync, readdirSync, readFileSync, statSync } = await import('node:fs')

  const counts = await Promise.all([
    client.search(personalIndex, { size: 0, query: { term: { status: 'active' } }, track_total_hits: true })
      .then((r) => num(r.hits?.total?.value)).catch(() => -1),
    client.search(names.team, { size: 0, query: teamReviewFilter(false), track_total_hits: true })
      .then((r) => num(r.hits?.total?.value)).catch(() => -1),
    client.search(names.team, { size: 0, query: { terms: { review_state: ['pending'] } }, track_total_hits: true })
      .then((r) => num(r.hits?.total?.value)).catch(() => -1),
    // 一个文档切多个 chunk，_count 数的是块；按 doc_id 去重才是"文档数"
    client.search(docsIndex, { size: 0, aggs: { docs: { cardinality: { field: 'doc_id' } } } })
      .then((r) => num(r.aggregations?.docs?.value)).catch(() => -1),
  ])

  // 上次整理时间（CLI 的状态文件）
  let lastRunAt = ''
  let pendingCount = null
  try {
    const raw = JSON.parse(readFileSync(join(STATE_DIR, 'consolidate.json'), 'utf8'))
    lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : ''
    pendingCount = typeof raw.pendingCount === 'number' ? raw.pendingCount : null
  } catch {
    /* 还没跑过 */
  }

  // 镜像目录
  let mirror = { dir: MIRROR_DIR, exists: false, files: [], latest: '' }
  try {
    if (existsSync(MIRROR_DIR)) {
      const entries = readdirSync(MIRROR_DIR).filter((name) => name.endsWith('.md'))
      mirror.exists = true
      mirror.files = entries.slice(0, 20)
      const times = entries.map((name) => statSync(join(MIRROR_DIR, name)).mtimeMs)
      if (times.length > 0) mirror.latest = new Date(Math.max(...times)).toISOString()
    }
  } catch {
    /* 忽略 */
  }

  json(res, 200, {
    ok: true,
    value: {
      counts: { personal: counts[0], team: counts[1], pending: counts[2], docs: counts[3] },
      // 统计对应的用户（前端用来确认"这些数字是谁的"）
      userId: targetUser,
      viewingOther: targetUser !== config.identity.userId,
      lastRunAt,
      pendingCount,
      mirror,
      cli: { available: cliAvailable(), stateDir: STATE_DIR, mirrorDir: MIRROR_DIR },
      // 静态事实：这两件事不由面板管，写清楚免得误以为是面板漏了功能
      snapshot: {
        managedBy: 'ES 快照生命周期管理（策略 dsh_memory_daily，每日 03:30 执行，保留 14 天）',
        note: '只读身份没有 cluster:monitor 权限，面板读不到快照状态；请用 curl 或 Kibana 查看 _snapshot。',
      },
      cron: {
        managedBy: '宿主机 crontab（脚本 scripts/memory-cron.sh，默认关闭）',
        note: '总开关在记忆库仓库的 .state/cron.env 里（变量 MEMCRON_ENABLED）；面板不会代改宿主机 cron。',
      },
    },
  })
}

/** POST /maintenance/consolidate：跑一次整理（默认 dry-run） */
async function handleConsolidate(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const apply = body.value?.apply === true
  if (apply && body.value?.confirm !== true) {
    return json(res, 400, { ok: false, error: '真写库需要 confirm:true' })
  }
  // 预演也要管理员：它会读个人库、打 embedding，普通账号不该能触发（2026-10-29 收拢）
  const config = requireAdmin(ctx, res)
  if (!config) return
  if (!cliAvailable()) {
    return json(res, 503, { ok: false, error: 'CLI 源码未随面板部署（缺少 panel/cli/consolidate），无法触发整理' })
  }

  // 目标用户：管理员可以整理别人的个人记忆（CLI 的 --user 决定扫哪个 personal 索引）。
  // 不传或传自己 = 整理自己那份。user 会拼进索引名，必须过白名单。
  const rawUser = str(body.value?.userId).trim()
  if (rawUser !== '' && normalizeUserId(rawUser) === null) {
    return json(res, 400, { ok: false, error: 'userId 不合法（只允许字母、数字、_ 和 -）' })
  }
  const targetUser = rawUser || config.identity.userId
  const args = apply ? ['--auto', '--apply'] : ['--auto']
  if (targetUser !== config.identity.userId) args.push('--user', targetUser)

  const result = await runCli(config, args, { timeoutMs: 180_000, stateDir: STATE_DIR })
  json(res, 200, {
    ok: true,
    value: {
      mode: apply ? 'apply' : 'dry-run',
      userId: targetUser,
      exitCode: result.code,
      lines: summarize(result.stdout),
      stderr: result.stderr.slice(-2000),
    },
  })
}

/** POST /maintenance/export：导出 Markdown 镜像 */
async function handleExport(ctx, res, req) {
  const body = await readJsonBody(req)
  if (!body.ok) return json(res, 400, { ok: false, error: body.error })
  const config = requireAdmin(ctx, res)
  if (!config) return
  // 先校验参数再查环境：参数不合法就不该因为"CLI 没部署"而返回 503
  // dir 会原样传给 CLI 的 --export，必须限制在镜像目录内：
  // 否则管理员（或拿到管理员会话的人）能把 Markdown 写到容器里任意可写路径。
  const requested = typeof body.value?.dir === 'string' ? body.value.dir.trim() : ''
  const dir = requested === '' ? MIRROR_DIR : requested
  if (dir !== MIRROR_DIR && !dir.startsWith(`${MIRROR_DIR}/`)) {
    return json(res, 400, { ok: false, error: `导出目录必须位于 ${MIRROR_DIR} 下` })
  }
  if (!cliAvailable()) {
    return json(res, 503, { ok: false, error: 'CLI 源码未随面板部署，无法导出' })
  }
  const result = await runCli(config, ['--export', dir], { timeoutMs: 60_000, stateDir: STATE_DIR })
  json(res, 200, {
    ok: true,
    value: { dir, exitCode: result.code, lines: summarize(result.stdout), stderr: result.stderr.slice(-2000) },
  })
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  // prefix 路由的语义可能是"原样传入"也可能"剥掉前缀"，两种都认：
  // 注册 `/memory-es/api` 后，req.url 可能是 `/memory-es/api/overview` 或 `/overview`。
  const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
  try {
    const reviewMatch = /^\/review\/([^/]+)\/(approve|reject|withdraw)$/.exec(path)
    if (path === '/maintenance/consolidate' && req.method === 'POST') return await handleConsolidate(ctx, res, req)
    if (path === '/maintenance/export' && req.method === 'POST') return await handleExport(ctx, res, req)
    if (path === '/maintenance' && req.method === 'GET') return await handleMaintenanceGet(ctx, res, url)
    if (path === '/maintenance/mirror' && req.method === 'GET') return await handleMirrorFile(ctx, res, url)
    if (path === '/facets' && req.method === 'GET') return await handleFacets(ctx, res)
    if (path === '/capabilities' && req.method === 'GET') return await handleCapabilities(ctx, res)
    // 管理员专用：列出有个人记忆的用户（浏览页/维护页切换目标用户）
    if (path === '/users' && req.method === 'GET') return await handleUsers(ctx, res)
    if (path === '/config' && req.method === 'POST') return await handleConfigWrite(ctx, res, req)
    // 删除：物理删一条记忆（个人/团队两种 scope，权限各自校验）
    if (path === '/memories/delete' && req.method === 'POST') return await handleDeleteMemory(ctx, res, req)
    if (path === '/memories/restore' && req.method === 'POST') return await handleRestoreMemory(ctx, res, req)
    if (path === '/memories/feedback' && req.method === 'POST') return await handleMemoryFeedback(ctx, res, req)
    if (req.method === 'POST' && reviewMatch) {
      return await handleReviewAction(ctx, res, decodeURIComponent(reviewMatch[1]), reviewMatch[2], req)
    }
    // ⚠️ POST 路由必须全部排在下面这条之前，否则会被 405 吞掉（identity/review 就踩过）
    if (path === '/identity/review' && req.method === 'POST') return await handleIdentityReview(ctx, res, req)
    // 表情包新增：写宿主磁盘的唯一入口，校验全在 handleStickerAdd 里
    if (path === '/stickers/add' && req.method === 'POST') return await handleStickerAdd(ctx, res, req)
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '该接口只支持 GET' })
    if (path === '/overview') return await handleOverview(ctx, res)
    if (path === '/graph') return await handleGraph(ctx, res, url)
    if (path === '/memories') return await handleMemories(ctx, res, url)
    // 阶段 11：检索埋点的覆盖率与反查
    if (path === '/search-log' && req.method === 'GET') return await handleSearchLog(ctx, res, url)
    if (path === '/search-log/used-in' && req.method === 'GET') return await handleSearchLogUsedIn(ctx, res, url)
    if (path === '/review/pending') return await handlePending(ctx, res, url)
    if (path === '/mood' && req.method === 'GET') return await handleMood(ctx, res)
    if (path === '/persona') return await handlePersonaGet(ctx, res)
    if (path === '/stickers') return await handleStickersGet(ctx, res)
    if (path === '/sticker') return await handleStickerImageGet(ctx, res, url)
    if (path === '/diary') return await handleDiaryGet(ctx, res, url)
    if (path === '/identity/pending' && req.method === 'GET') return await handleIdentityPending(ctx, res, url)
    if (path === '/identity/audit' && req.method === 'GET') return await handlePersonalAudit(ctx, res, url)
    if (path === '/identity/active' && req.method === 'GET') return await handleIdentityActive(ctx, res, url)
    if (path === '/identity/versions' && req.method === 'GET') return await handleIdentityVersions(ctx, res, url)
    if (path === '/config') return await handleConfigGet(ctx, res)
    return json(res, 404, { ok: false, error: `未知接口 ${path}` })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * 写自检（一次性）：由 flag 文件 `/data/dsh/profiles/web/.memory-es-selftest-write` 触发。
 * 造一条临时 pending → 走真实的 approve 处理函数 → 检查审计是否写入 → 清理。
 * 只在需要验证写路径时手动放 flag，平时不跑（写操作不该每次启动都执行）。
 */
async function writeSelfTest(ctx) {
  const flag = '/data/dsh/profiles/web/.memory-es-selftest-write'
  const { existsSync, rmSync } = await import('node:fs')
  if (!existsSync(flag)) return

  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return console.error(`[memory-es-panel] 写自检跳过：${configRow.error}`)
  const names = indexNames(configRow.value)
  const client = createReadClient(() => resolveClientConfig(ctx, 'consolidator'))
  const docId = '__selftest_pending'
  const now = new Date().toISOString()

  try {
    await client.index(names.team, {
      doc_id: docId,
      content: '自检临时条目（写完即删）',
      memory_type: 'fact',
      domain: 'selftest',
      topic_key: 'selftest:temp',
      content_sha256: 'selftest-hash',
      source_user: 'selftest',
      source_memory_id: 'mem-selftest',
      source_created_at: now,
      promoted_at: now,
      updated_at: now,
      status: 'active',
      review_state: 'pending',
    }, { id: docId, refresh: 'wait_for' })

    // 造一个最小的"请求流"喂给真实处理函数（模拟 POST body）
    const payload = JSON.stringify({ confirm: true, reason: 'write-selftest', actor: 'selftest' })
    const req = Object.assign(new (await import('node:stream')).Readable({ read() {} }), { method: 'POST' })
    const res = await new Promise((resolve) => {
      const fake = {
        statusCode: 0,
        writeHead(status) {
          this.statusCode = status
        },
        end(body) {
          resolve({ status: this.statusCode, body: String(body ?? '') })
        },
      }
      setTimeout(() => {
        req.push(payload)
        req.push(null)
      }, 0)
      handleReviewAction(ctx, fake, docId, 'approve', req).catch((error) =>
        resolve({ status: 0, body: String(error?.message ?? error) }),
      )
    })

    let detail = res.body.slice(0, 200)
    try {
      const body = JSON.parse(res.body)
      detail = body.ok ? `ok result=${body.value?.result} audit=${body.value?.auditWritten}` : `err ${body.error}`
    } catch {
      /* 保留原始片段 */
    }

    // 复核：条目是否真的变成 approved，审计里是否真有这条
    const after = await client.search(names.team, { size: 1, _source: ['review_state'], query: { ids: { values: [docId] } } })
    const state = after.hits?.hits?.[0]?._source?.review_state
    const audit = await client.search(names.audit, {
      size: 1,
      _source: ['event', 'actor', 'subject_id'],
      query: { term: { subject_id: docId } },
    })
    const auditHit = audit.hits?.hits?.[0]?._source

    // 配置写入自检（可选）：把 requestTimeoutMs 写回**同一个值**——空操作，但能证明
    // configEditor.edit 的 change 函数形状正确、不会被校验拒绝。
    if (existsSync('/data/dsh/profiles/web/.memory-es-selftest-config')) {
      const currentValue = configRow.value.es.requestTimeoutMs
      const payload2 = JSON.stringify({
        confirm: true,
        changes: [{ key: 'es.requestTimeoutMs', type: 'number', value: currentValue }],
      })
      const req2 = Object.assign(new (await import('node:stream')).Readable({ read() {} }), { method: 'POST' })
      const res2 = await new Promise((resolve) => {
        const fake = {
          statusCode: 0,
          writeHead(status) {
            this.statusCode = status
          },
          end(body) {
            resolve({ status: this.statusCode, body: String(body ?? '') })
          },
        }
        setTimeout(() => {
          req2.push(payload2)
          req2.push(null)
        }, 0)
        handleConfigWrite(ctx, fake, req2).catch((error) => resolve({ status: 0, body: String(error?.message ?? error) }))
      })
      let info = res2.body.slice(0, 200)
      try {
        const body = JSON.parse(res2.body)
        info = body.ok ? `ok saved=${body.value?.saved?.join(',')} restart=${body.value?.restartRequired}` : `err ${body.error}`
      } catch {
        /* 原始片段 */
      }
      console.error(`[记忆库面板] 配置写入自检（空操作）HTTP ${res2.status} ${info}`)
      try {
        rmSync('/data/dsh/profiles/web/.memory-es-selftest-config')
      } catch {
        /* 已删除 */
      }
    }

    console.error(
      `[memory-es-panel] 写自检 HTTP ${res.status} ${detail} | 复核 review_state=${state ?? '?'} ` +
        `audit=${auditHit ? `${auditHit.event}/${auditHit.actor}` : '缺失'}`,
    )
  } catch (error) {
    console.error(`[memory-es-panel] 写自检异常：${String(error?.message ?? error)}`)
  } finally {
    // 清理临时条目 + 摘掉 flag（只跑一次）
    try {
      await client.update(names.team, `${docId}`, { status: 'superseded', updated_at: new Date().toISOString() }, { refresh: 'wait_for' })
    } catch {
      /* 清理失败不影响结论 */
    }
    try {
      rmSync(flag)
    } catch {
      /* flag 已不存在 */
    }
  }
}

/** 自检：直接调用自己的 handler（不过 HTTP，绕开登录门禁），结果只打一行日志。
 *  这样"面板能不能取到数据"不依赖人眼：重启后看一行日志就知道。 */
async function selfTest(ctx) {
  const call = (routePath) => new Promise((resolve) => {
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
      },
      end(body) {
        resolve({ status: this.statusCode, body: String(body ?? '') })
      },
    }
    handle(ctx, { method: 'GET', url: `${ROUTE}${routePath}` }, res).catch((error) =>
      resolve({ status: 0, body: String(error?.message ?? error) }),
    )
  })

  // 阶段 6/7 的新接口也过一遍：重启后在日志里就能看到"心情/候选/个人审计"通不通
  const probe = async (label, routePath, pick) => {
    const res = await call(routePath)
    if (res.status !== 200) return `${label}=err(${res.status})`
    try {
      return `${label}=${pick(JSON.parse(res.body))}`
    } catch {
      return `${label}=bad-json`
    }
  }

  const result = await call('/overview')

  if (result.status !== 200) {
    console.error(`[记忆库面板] 自检失败 HTTP ${result.status} ${result.body.slice(0, 240)}`)
    return
  }
  try {
    const payload = JSON.parse(result.body)
    const counts = payload.value?.counts ?? {}
    const es = payload.value?.es ?? {}
    const moodView = await probe('心情', '/mood', (p) =>
      p.value?.exists ? `${Number(p.value.valence).toFixed(2)}/${Array.isArray(p.value.events) ? p.value.events.length : 0}事件` : '中性',
    )
    const pendingView = await probe('候选', '/identity/pending', (p) => `${Array.isArray(p.value?.rows) ? p.value.rows.length : 0}条`)
    const auditView = await probe('个人审计', '/identity/audit', (p) => `${Array.isArray(p.value?.rows) ? p.value.rows.length : 0}条`)

    // 用 stderr 输出：实测 ctx.logger.info 不落 dsh 的启动日志，console.error 会（一行/次启动，不算噪音）
    // 第二个接口也跑一遍：/memories 覆盖查询构造与分页投影
    const list = await call('/memories?size=2&includePending=1')
    let listInfo = `HTTP ${list.status}`
    try {
      const body = JSON.parse(list.body)
      listInfo = body.ok ? `ok total=${body.value?.total} rows=${body.value?.rows?.length}` : `err ${body.error}`
    } catch {
      listInfo = `HTTP ${list.status} 非 JSON`
    }
    const pendingRes = await call('/review/pending?size=50')
    let pendingInfo = `HTTP ${pendingRes.status}`
    try {
      const body = JSON.parse(pendingRes.body)
      pendingInfo = body.ok ? `ok total=${body.value?.total} canWrite=${body.value?.canWrite}` : `err ${body.error}`
    } catch {
      pendingInfo = `HTTP ${pendingRes.status} 非 JSON`
    }
    // 翻页自检：page=0 与 page=1 各取 1 条，必须不是同一条（跨两库分页曾经的 bug）
    let pagingInfo = '未测'
    try {
      const first = JSON.parse((await call('/memories?scope=both&size=1&page=0')).body)
      const second = JSON.parse((await call('/memories?scope=both&size=1&page=1')).body)
      const idOf = (body) => body.value?.rows?.[0]?.id ?? '(空)'
      const a = idOf(first)
      const b = idOf(second)
      pagingInfo =
        a === b && a !== '(空)'
          ? `重复(${a})`
          : `总=${first.value?.total ?? '?'} 第1条=${a} 第2条=${b}${first.value?.truncated ? ' 截断' : ''}`
    } catch (error) {
      pagingInfo = `失败 ${String(error?.message ?? error).slice(0, 80)}`
    }

    const configRes = await call('/config')
    let configInfo = `HTTP ${configRes.status}`
    try {
      const body = JSON.parse(configRes.body)
      configInfo = body.ok ? `ok fields=${body.value?.fields?.length}` : `err ${body.error}`
    } catch {
      configInfo = `HTTP ${configRes.status} 非 JSON`
    }
    const facetsRes = await call('/facets')
    let facetsInfo = `HTTP ${facetsRes.status}`
    try {
      const body = JSON.parse(facetsRes.body)
      facetsInfo = body.ok
        ? `ok domains=${body.value?.domains?.length ?? 0} types=${body.value?.types?.length ?? 0}`
        : `err ${body.error}`
    } catch {
      facetsInfo = `HTTP ${facetsRes.status} 非 JSON`
    }

    const mirrorRes = await call('/maintenance/mirror?name=INDEX.md')
    let mirrorInfo = `HTTP ${mirrorRes.status}`
    try {
      const body = JSON.parse(mirrorRes.body)
      // 非管理员的 403 是**正常**状态：镜像属于维护功能，不该把它记成自检失败
      mirrorInfo = mirrorRes.status === 403
        ? 'skip(非管理员)'
        : body.ok
          ? `ok ${body.value?.size ?? 0}B`
          : `err ${body.error}`
    } catch {
      mirrorInfo = `HTTP ${mirrorRes.status} 非 JSON`
    }

    const maintRes = await call('/maintenance')
    let maintInfo = `HTTP ${maintRes.status}`
    try {
      const body = JSON.parse(maintRes.body)
      if (maintRes.status === 403) {
        // 普通成员看不到维护页，403 是**正常**状态而不是自检失败
        maintInfo = 'skip(非管理员)'
      } else {
        maintInfo = body.ok
          ? `ok cli=${body.value?.cli?.available} mirror=${body.value?.mirror?.files?.length ?? 0}`
          : `err ${body.error}`
      }
    } catch {
      maintInfo = `HTTP ${maintRes.status} 非 JSON`
    }

    // 阶段 11：检索埋点的自检。次数=0 有两种可能——这 7 天真的没检索，或埋点写失败
    // （fire-and-forget，失败只记日志），所以这一行要能在部署时被看到。
    const searchLogRes = await call('/search-log?days=7&limit=1')
    let searchLogInfo = `HTTP ${searchLogRes.status}`
    try {
      const body = JSON.parse(searchLogRes.body)
      searchLogInfo = body.ok
        ? `ok 次数=${body.value?.summary?.total ?? 0} 簇=${body.value?.summary?.clusters ?? 0} 缺口=${body.value?.summary?.miss ?? 0}`
        : `err ${body.error}`
    } catch {
      searchLogInfo = `HTTP ${searchLogRes.status} 非 JSON`
    }

    // 凭据体检：只打长度不打值。整理任务报「.env 缺少 MEM_USERNAME/MEM_PASSWORD」时，
    // 先看这一行——passwordLen=0 说明配置没读到凭据，非 0 说明是写盘或 CLI 解析的问题。
    {
      const cfgRow = findEntryRow(ctx)
      if (cfgRow.ok) {
        const idn = cfgRow.value.identity
        console.error(
          `[记忆库面板] 凭据体检 | userId=${idn.userId || '(空)'} username=${idn.username || '(空)'} ` +
            `passwordLen=${String(idn.password ?? '').length} teamWrite=${Boolean(idn.teamWrite)}`,
        )
      }
    }

    const capsRes = await call('/capabilities')
    let capsInfo = `HTTP ${capsRes.status}`
    try {
      const body = JSON.parse(capsRes.body)
      // 删除权限也打出来：部署后看这一行就知道"该看到删除按钮的账号是否真的探测到了"
      capsInfo = body.ok
        ? `role=${body.value?.role} canReview=${body.value?.canReview} canDelete个人=${body.value?.canDeletePersonal} canDelete团队=${body.value?.canDeleteTeam}`
        : `err ${body.error}`
    } catch {
      capsInfo = `HTTP ${capsRes.status} 非 JSON`
    }

    console.error(
      `[记忆库面板] 自检通过 v${PANEL_VERSION} | 配置行=${payload.value?.config?.entryLabel ?? '?'} ` +
        `ES=${es.reachable ? '可达' : '不可达'} 个人=${counts.personal} 团队=${counts.team} ` +
        `文档=${counts.docs ?? '—'}(${counts.docChunks ?? '—'} 块) ` +
        `待裁决=${counts.pending} 最近=${payload.value?.recent?.length ?? 0} | ` +
        `审计=${payload.value?.counts?.audit ?? '—'} | 浏览: ${listInfo} | 分页: ${pagingInfo} | ` +
        `审核: ${pendingInfo} | 过滤候选: ${facetsInfo} | 镜像预览: ${mirrorInfo} | ` +
        `权限: ${capsInfo} | 配置: ${configInfo} | 维护: ${maintInfo} | 检索: ${searchLogInfo} | ` +
        `${moodView} | ${pendingView} | ${auditView}`,
    )
  } catch {
    console.error(`[memory-es-panel] 自检返回无法解析 ${result.body.slice(0, 240)}`)
  }
}

/** 宿主半边入口：注册路由，插件卸载时自动摘掉。 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        // 鉴权必须在任何业务分支之前：漏一次就等于整个记忆库对外开放
        const rejection = admitRequest(ctx, req)
        if (rejection !== null) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(rejection === 503 ? 'memory-es panel: 鉴权服务不可用，已拒绝请求\n' : 'unauthorized\n')
          return
        }
        return handle(ctx, req, res)
      },
    })
    console.error(`[记忆库面板] 已注册只读接口 ${ROUTE}/{overview,memories,review/pending,config,maintenance}`)
    void selfTest(ctx)
    void writeSelfTest(ctx)
    return dispose
  })
}

/**
 * 依赖声明：**必须有**。Cordis 里访问未注入的服务会直接抛
 * `cannot get property "webServer" without inject`；而 `ctx.get()` 是静默返回 undefined，
 * 表现为"路由没注册、页面 404"，比抛错难查得多（2026-10-25 就是这么栽的）。
 */
// 纯函数导出给测试用（不改变运行行为）：口径、配置合并、行匹配最容易悄悄错的地方
export {
  admitRequest,
  applyConfigChanges,
  coerceFieldValue,
  fieldTypeOf,
  entryLabels,
  findEntryRow,
  handleCapabilities,
  handleConsolidate,
  handleDeleteMemory,
  buildGraph,
  handleExport,
  handleGraph,
  handleMaintenanceGet,
  handleMemories,
  handleSearchLog,
  handleSearchLogUsedIn,
  handleMemoryFeedback,
  handleReviewAction,
  handleStickerImageGet,
  handleStickerAdd,
  handleUsers,
  indexNames,
  mergeConfig,
  pendingQuery,
  probeDeleteRights,
  projectHit,
  resolveStickerDir,
  EDITABLE,
}

export const inject = ['webServer', 'configEditor']
