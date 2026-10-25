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
  identity: {
    userId: '',
    readUsername: '',
    readPassword: '',
    consolidatorUsername: 'mem-consolidator',
    consolidatorPassword: '',
  },
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
function resolveClientConfig(ctx, role = 'reader') {
  const config = findEntryRow(ctx)
  if (!config.ok) return config
  const value = config.value
  if (role === 'consolidator') {
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

/** 待裁决列表：读团队库（reader 有 team 读权限），连同冲突对象一起返回 */
async function handlePending(ctx, res, url) {
  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
  const config = configRow.value
  const names = indexNames(config)
  const client = createReadClient(() => resolveClientConfig(ctx))
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size') ?? '20', 10) || 20))

  const result = await client.search(names.team, {
    size: limit,
    _source: { excludes: ['embedding'] },
    query: { bool: { filter: [{ term: { review_state: 'pending' } }, { term: { status: 'active' } }] } },
    sort: [{ promoted_at: 'asc' }],
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
      rows,
      conflicts,
      canWrite: Boolean(config.identity.consolidatorUsername && config.identity.consolidatorPassword),
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
  const actor = str(input.actor).trim() || 'panel'

  if ((action === 'reject' || action === 'withdraw') && reason === '') {
    return json(res, 400, { ok: false, error: `${action} 必须填写原因` })
  }
  if (input.confirm !== true) {
    return json(res, 400, { ok: false, error: '缺少 confirm:true（写操作要显式确认）' })
  }

  const configRow = findEntryRow(ctx)
  if (!configRow.ok) return json(res, 503, { ok: false, error: configRow.error })
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

/** 可编辑的配置字段（只暴露安全的几个；密码不进面板） */
const EDITABLE = [
  { path: ['es', 'url'], label: 'ES 地址', type: 'string' },
  { path: ['es', 'caCertPath'], label: 'CA 证书路径', type: 'string' },
  { path: ['es', 'requestTimeoutMs'], label: '请求超时(ms)', type: 'number' },
  { path: ['index', 'team'], label: '团队库索引名', type: 'string' },
  { path: ['embedding', 'url'], label: 'Embedding 地址', type: 'string' },
  { path: ['embedding', 'model'], label: 'Embedding 模型', type: 'string' },
  { path: ['embedding', 'dims'], label: '向量维度', type: 'number' },
  { path: ['defaults', 'domain'], label: '默认 domain', type: 'string' },
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
      fields: EDITABLE.map((field) => ({
        key: field.path.join('.'),
        label: field.label,
        type: field.type,
        value: pick(value, field.path) ?? (field.type === 'number' ? 0 : ''),
      })),
      readonly: {
        entryLabel: configRow.label ?? '',
        personalIndex: `${value.index.personalPrefix}${value.identity.userId}`,
        teamIndex: value.index.team,
        auditIndex: AUDIT_INDEX,
        userId: value.identity.userId,
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

  const changes = Array.isArray(input.changes) ? input.changes : []
  if (changes.length === 0) return json(res, 400, { ok: false, error: '没有要修改的字段' })

  const allowed = new Set(EDITABLE.map((field) => field.path.join('.')))
  for (const change of changes) {
    if (typeof change?.key !== 'string' || !allowed.has(change.key)) {
      return json(res, 400, { ok: false, error: `不可修改的字段：${change?.key}` })
    }
  }

  try {
    await editor.edit(target.entry, (current) => {
      // 浅拷贝两层，只写白名单路径，其余原样带回（configEditor 要求返回完整 raw config）
      const next = {}
      for (const [group, groupValue] of Object.entries(current ?? {})) {
        next[group] = groupValue && typeof groupValue === 'object' ? { ...groupValue } : groupValue
      }
      for (const change of changes) {
        const [group, key] = change.key.split('.')
        if (next[group] === undefined || next[group] === null) next[group] = {}
        next[group][key] = change.type === 'number' ? Number(change.value) : String(change.value)
      }
      return next
    })
  } catch (error) {
    return json(res, 400, { ok: false, error: `写入失败：${String(error?.message ?? error)}` })
  }

  json(res, 200, {
    ok: true,
    value: {
      saved: changes.map((change) => change.key),
      // 关键提示：插件在 apply() 时建好 ES 客户端，配置变更必须重启 dsh 才真正生效
      restartRequired: true,
      note: '已保存到 profile 配置。ES 客户端在插件加载时建立，需重启 dsh 后才生效（.125 是 docker restart dsh-xqh）。',
    },
  })
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  // prefix 路由的语义可能是"原样传入"也可能"剥掉前缀"，两种都认：
  // 注册 `/memory-es/api` 后，req.url 可能是 `/memory-es/api/overview` 或 `/overview`。
  const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
  try {
    const reviewMatch = /^\/review\/([^/]+)\/(approve|reject|withdraw)$/.exec(path)
    if (path === '/config' && req.method === 'POST') return await handleConfigWrite(ctx, res, req)
    if (req.method === 'POST' && reviewMatch) {
      return await handleReviewAction(ctx, res, decodeURIComponent(reviewMatch[1]), reviewMatch[2], req)
    }
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '该接口只支持 GET' })
    if (path === '/overview') return await handleOverview(ctx, res)
    if (path === '/memories') return await handleMemories(ctx, res, url)
    if (path === '/review/pending') return await handlePending(ctx, res, url)
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
      console.error(`[memory-es-panel] 配置写入自检（空操作）HTTP ${res2.status} ${info}`)
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
    const pendingRes = await call('/review/pending?size=50')
    let pendingInfo = `HTTP ${pendingRes.status}`
    try {
      const body = JSON.parse(pendingRes.body)
      pendingInfo = body.ok ? `ok total=${body.value?.total} canWrite=${body.value?.canWrite}` : `err ${body.error}`
    } catch {
      pendingInfo = `HTTP ${pendingRes.status} 非 JSON`
    }
    const configRes = await call('/config')
    let configInfo = `HTTP ${configRes.status}`
    try {
      const body = JSON.parse(configRes.body)
      configInfo = body.ok ? `ok fields=${body.value?.fields?.length}` : `err ${body.error}`
    } catch {
      configInfo = `HTTP ${configRes.status} 非 JSON`
    }
    console.error(
      `[memory-es-panel] 自检通过 entry=${payload.value?.config?.entryLabel ?? '?'} es=${es.reachable ? 'up' : 'down'} ` +
        `personal=${counts.personal} team=${counts.team} pending=${counts.pending} recent=${payload.value?.recent?.length ?? 0} | ` +
        `list: ${listInfo} | review: ${pendingInfo} | config: ${configInfo}`,
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
    void writeSelfTest(ctx)
    return dispose
  })
}

/**
 * 依赖声明：**必须有**。Cordis 里访问未注入的服务会直接抛
 * `cannot get property "webServer" without inject`；而 `ctx.get()` 是静默返回 undefined，
 * 表现为"路由没注册、页面 404"，比抛错难查得多（2026-10-25 就是这么栽的）。
 */
export const inject = ['webServer', 'configEditor']
