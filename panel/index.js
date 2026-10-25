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
import { createReadClient } from './es.js'

const ROUTE = '/memory-es/api'
const ENTRY_ID = 'dsh-memory-es'
const AUDIT_INDEX = 'memory_audit'

/** 配置默认值与 `src/config.ts` 保持一致（只用于面板兜底，不替代插件校验） */
const DEFAULTS = {
  es: { url: 'https://127.0.0.1:9200', caCertPath: 'deploy/es/certs/ca.crt', requestTimeoutMs: 8000 },
  index: { personalPrefix: 'personal_memory_', team: 'team_knowledge' },
  identity: { userId: '', readUsername: '', readPassword: '' },
  embedding: { url: 'http://127.0.0.1:11434', model: 'bge-m3', dims: 1024 },
  defaults: { domain: 'general' },
}

/** 只合并已知的两层键：配置是固定 schema，不需要通用深合并 */
function mergeConfig(inherited, override) {
  const merged = {}
  for (const [group, defaults] of Object.entries(DEFAULTS)) {
    merged[group] = { ...defaults, ...(inherited?.[group] ?? {}), ...(override?.[group] ?? {}) }
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

/** 每次请求现读配置 → 配置改了面板不用重启 */
function resolveClientConfig(ctx) {
  const config = findEntryRow(ctx)
  if (!config.ok) return config
  const value = config.value
  if (!value.identity.readUsername || !value.identity.readPassword) {
    return { ok: false, error: '插件配置缺少只读身份（readUsername / readPassword）' }
  }
  return {
    ok: true,
    value: {
      url: value.es.url,
      caCertPath: value.es.caCertPath,
      timeoutMs: value.es.requestTimeoutMs,
      auth: { username: value.identity.readUsername, password: value.identity.readPassword },
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
    team: config.index.team,
    audit: AUDIT_INDEX,
  }
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
  }
}

async function handleOverview(ctx, res) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))

  const [health, personalCount, teamCount, pendingCount, personalRecent, teamRecent] = await Promise.all([
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
    client
      .search(names.team, { size: 0, query: teamReviewFilter(false), track_total_hits: true })
      .then((r) => num(r.hits?.total?.value))
      .catch(() => -1),
    client
      .search(names.team, { size: 0, query: { terms: { review_state: ['pending'] } }, track_total_hits: true })
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
  ])

  const recent = [...personalRecent, ...teamRecent]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, 5)

  json(res, 200, {
    ok: true,
    value: {
      es: {
        reachable: !health.error,
        // 读不到集群健康（权限不足），这里不编造状态；可达性由上面的索引读探测给出
        status: '',
        error: health.error ? String(health.error) : '',
      },
      counts: { personal: personalCount, team: teamCount, pending: pendingCount, audit: null },
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
  const domains = params.getAll('domain').filter(Boolean)
  const types = params.getAll('type').filter(Boolean)
  const status = (params.get('status') ?? 'active').trim()
  const includePending = params.get('includePending') === '1'

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
      from: page * size,
      size,
      track_total_hits: true,
      _source: { excludes: ['embedding'] },
      query: { bool: { must, filter } },
      sort: [{ updated_at: 'desc' }],
    }
  }

  const emptyPage = { hits: { total: { value: 0 }, hits: [] } }
  const [personal, team] = await Promise.all([
    scope !== 'team' ? client.search(names.personal, buildBody(false)) : Promise.resolve(emptyPage),
    scope !== 'personal' ? client.search(names.team, buildBody(true)) : Promise.resolve(emptyPage),
  ])

  const rows = [
    ...(personal.hits?.hits ?? []).map((hit) => projectHit(hit, 'personal')),
    ...(team.hits?.hits ?? []).map((hit) => projectHit(hit, 'team')),
  ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  json(res, 200, {
    ok: true,
    value: {
      total: num(personal.hits?.total?.value) + num(team.hits?.total?.value),
      totals: {
        personal: num(personal.hits?.total?.value),
        team: num(team.hits?.total?.value),
      },
      page,
      size,
      rows,
    },
  })
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  // prefix 路由的语义可能是"原样传入"也可能"剥掉前缀"，两种都认：
  // 注册 `/memory-es/api` 后，req.url 可能是 `/memory-es/api/overview` 或 `/overview`。
  const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
  try {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'P1 只提供只读接口（GET）' })
    if (path === '/overview') return await handleOverview(ctx, res)
    if (path === '/memories') return await handleMemories(ctx, res, url)
    return json(res, 404, { ok: false, error: `未知接口 ${path}` })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
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

  const result = await call('/overview')

  if (result.status !== 200) {
    console.error(`[memory-es-panel] 自检失败 HTTP ${result.status} ${result.body.slice(0, 240)}`)
    return
  }
  try {
    const payload = JSON.parse(result.body)
    const counts = payload.value?.counts ?? {}
    const es = payload.value?.es ?? {}
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
    console.error(
      `[memory-es-panel] 自检通过 entry=${payload.value?.config?.entryLabel ?? '?'} es=${es.reachable ? 'up' : 'down'} ` +
        `personal=${counts.personal} team=${counts.team} pending=${counts.pending} recent=${payload.value?.recent?.length ?? 0} | list: ${listInfo}`,
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
      handler: (req, res) => handle(ctx, req, res),
    })
    console.error(`[memory-es-panel] 已注册只读路由 ${ROUTE}/{overview,memories}`)
    void selfTest(ctx)
    return dispose
  })
}

/**
 * 依赖声明：**必须有**。Cordis 里访问未注入的服务会直接抛
 * `cannot get property "webServer" without inject`；而 `ctx.get()` 是静默返回 undefined，
 * 表现为"路由没注册、页面 404"，比抛错难查得多（2026-10-25 就是这么栽的）。
 */
export const inject = ['webServer', 'configEditor']
