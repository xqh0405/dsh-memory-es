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

function findEntryRow(ctx) {
  const editor = ctx.get('configEditor')
  if (!editor) return { ok: false, error: 'configEditor 服务不可用（无法读取插件配置）' }
  const row = editor.configuration().find((item) => {
    const entry = item.entry ?? {}
    return entry.name === ENTRY_ID || entry.id === ENTRY_ID
  })
  if (!row) return { ok: false, error: `没有找到 ${ENTRY_ID} 的配置行（插件是否已安装？）` }
  return { ok: true, value: mergeConfig(row.inherited, row.override) }
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
    client.health().catch((error) => ({ error: String(error.message ?? error) })),
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
        status: str(health.status),
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

/** 宿主半边入口：注册路由，插件卸载时自动摘掉 */
export function apply(ctx) {
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (!webServer) {
      ctx.logger?.warn?.('dsh-memory-es-panel: 没有 webServer 服务，面板 API 不注册')
      return
    }
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => handle(ctx, req, res),
    })
    ctx.logger?.info?.(`dsh-memory-es-panel: 已注册只读路由 ${ROUTE}/{overview,memories}`)
    return dispose
  })
}
