/**
 * 「记忆库」设置页（P1：概览 + 记忆浏览，只读）。
 *
 * 数据来自宿主半边注册的只读接口 `/memory-es/api/{overview,memories}`（见同目录 index.js）：
 * 同源 fetch、自动带登录 cookie，凭证留在宿主进程里，浏览器只拿到投影后的字段。
 *
 * 约定（Slots.listSubTree 的 settings.section 契约）：注册项 `{id, order, label}`，
 * 组件拿到 owner props `{close}`；文案走客户端 locale 服务。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-es-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'memory-es-panel'
    const API = '/memory-es/api'

    const ZH = {
      sectionLabel: '记忆库',
      title: '记忆库',
      subtitle: 'Elasticsearch 后端记忆（dsh-memory-es）：概览与浏览。',
      tabOverview: '概览',
      tabBrowse: '记忆浏览',
      cardPersonal: '个人记忆',
      cardTeam: '团队知识',
      cardPending: '待裁决',
      cardAudit: '审计事件',
      cardAuditNA: '待整理身份（P3）',
      esOk: 'ES 正常',
      esDown: 'ES 不可达',
      esChecking: '正在检查…',
      recent: '最近更新',
      empty: '还没有记忆',
      scopeAll: '全部',
      scopePersonal: '个人',
      scopeTeam: '团队',
      search: '搜索内容或主题…',
      searchGo: '查询',
      statusActive: '有效',
      statusAll: '全部状态',
      includePending: '含待裁决',
      colContent: '内容',
      colScope: '库',
      colDomain: 'domain',
      colType: '类型',
      colStatus: '状态',
      colUpdated: '更新时间',
      detail: '详情',
      copy: '复制',
      copied: '已复制',
      prev: '上一页',
      next: '下一页',
      total: '共',
      rows: '条',
      loading: '加载中…',
      error: '出错了',
      retry: '重试',
      close: '关闭',
      configTitle: '配置（只读）',
      indexNames: '索引',
      embedding: '嵌入',
      auditNote: '审计索引不在插件配置里，且只读身份没有它的读权限，P3 再补。',
    }
    const EN = {
      sectionLabel: 'Memory',
      title: 'Memory',
      subtitle: 'Elasticsearch-backed memory (dsh-memory-es): overview and browse.',
      tabOverview: 'Overview',
      tabBrowse: 'Browse',
      cardPersonal: 'Personal',
      cardTeam: 'Team',
      cardPending: 'Pending review',
      cardAudit: 'Audit events',
      cardAuditNA: 'needs the consolidator identity (P3)',
      esOk: 'ES healthy',
      esDown: 'ES unreachable',
      esChecking: 'Checking…',
      recent: 'Recently updated',
      empty: 'No memory yet',
      scopeAll: 'All',
      scopePersonal: 'Personal',
      scopeTeam: 'Team',
      search: 'Search content or topic…',
      searchGo: 'Search',
      statusActive: 'Active',
      statusAll: 'All statuses',
      includePending: 'Include pending',
      colContent: 'Content',
      colScope: 'Index',
      colDomain: 'Domain',
      colType: 'Type',
      colStatus: 'Status',
      colUpdated: 'Updated',
      detail: 'Detail',
      copy: 'Copy',
      copied: 'Copied',
      prev: 'Prev',
      next: 'Next',
      total: 'Total',
      rows: 'rows',
      loading: 'Loading…',
      error: 'Failed',
      retry: 'Retry',
      close: 'Close',
      configTitle: 'Configuration (read-only)',
      indexNames: 'Indexes',
      embedding: 'Embedding',
      auditNote: 'The audit index is not in the plugin config and the reader identity cannot read it; P3 will add it.',
    }

    // ── 样式（全部走主题 token，不写死颜色）─────────────────────────────
    const S = {
      wrap: { padding: '4px 2px 12px' },
      h2: { margin: '0 0 4px', fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sub: { margin: '0 0 14px', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: 14 },
      tab: (active) => ({
        appearance: 'none',
        border: 'none',
        borderBottom: active ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
        background: 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        padding: '8px 12px',
        cursor: 'pointer',
      }),
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
      },
      statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 12 },
      statValue: { fontSize: 22, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.2 },
      statLabel: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      statHint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', opacity: 0.85, marginTop: 2 },
      toolbar: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 },
      seg: { display: 'flex', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, overflow: 'hidden' },
      segBtn: (active) => ({
        appearance: 'none',
        border: 'none',
        padding: '6px 10px',
        fontSize: 12,
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: active ? '#fff' : 'var(--dsw-alias-label-primary)',
      }),
      input: {
        flex: '1 1 220px',
        minWidth: 160,
        fontSize: 12,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      select: {
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      btn: {
        appearance: 'none',
        fontSize: 12,
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: {
        textAlign: 'left',
        padding: '8px 8px',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '8px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
        verticalAlign: 'top',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 },
      pill: (tone) => ({
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        border: '1px solid var(--dsw-alias-border-l1)',
        color:
          tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : tone === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)',
      }),
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5 },
    }

    // ── 数据访问 ─────────────────────────────────────────────────────────
    async function apiGet(path, params) {
      const query = params ? `?${new URLSearchParams(params).toString()}` : ''
      const res = await fetch(`${API}${path}${query}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      // 返回不是 JSON 时最常见的两种原因：登录态过期（被 302 到登录页）或路由没注册上
      // （落到 SPA fallback，回一个 HTML）。把 content-type 说出来，省得下次靠猜。
      const type = res.headers.get('content-type') || ''
      if (!type.includes('application/json')) {
        throw new Error(
          `HTTP ${res.status}，返回 ${type || '无 content-type'} 而不是 JSON：` +
            `会话可能已过期，或 /memory-es/api 路由未注册`,
        )
      }
      const body = await res.json()
      if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body.value
    }

    function shortTime(value) {
      return typeof value === 'string' && value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)}` : value || '-'
    }

    function StatCard({ label, value, hint }) {
      return h('div', { style: S.card },
        h('div', { style: S.statValue }, value),
        h('div', { style: S.statLabel }, label),
        hint ? h('div', { style: S.statHint }, hint) : null,
      )
    }

    function CopyButton({ text, t }) {
      const [done, setDone] = React.useState(false)
      return h('button', {
        type: 'button',
        style: S.btn,
        onClick: () => {
          const fallback = () => {
            const area = document.createElement('textarea')
            area.value = text
            document.body.appendChild(area)
            area.select()
            try {
              document.execCommand('copy')
            } catch {
              /* 复制失败不阻塞面板 */
            }
            document.body.removeChild(area)
          }
          const task = navigator.clipboard?.writeText
            ? navigator.clipboard.writeText(text).catch(fallback)
            : Promise.resolve(fallback())
          Promise.resolve(task).then(() => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1200)
          })
        },
      }, done ? t('copied') : t('copy'))
    }

    // ── 概览 ─────────────────────────────────────────────────────────────
    function Overview({ data, loading, error, t, onRetry, onOpenBrowse }) {
      if (loading) return h('p', { style: S.muted }, t('loading'))
      if (error) {
        return h('div', null,
          h('p', { style: S.err }, `${t('error')}: ${error}`),
          h('button', { type: 'button', style: S.btn, onClick: onRetry }, t('retry')),
        )
      }
      const counts = data.counts
      const show = (value) => (value === -1 ? '—' : String(value))
      return h('div', null,
        h('div', { style: S.statGrid },
          h(StatCard, { label: t('cardPersonal'), value: show(counts.personal) }),
          h(StatCard, { label: t('cardTeam'), value: show(counts.team) }),
          h(StatCard, {
            label: t('cardPending'),
            value: show(counts.pending),
            hint: counts.pending > 0 ? '→ ' + t('tabBrowse') : '',
          }),
          h(StatCard, { label: t('cardAudit'), value: '—', hint: t('cardAuditNA') }),
        ),

        h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: S.pill(data.es.reachable ? 'ok' : 'warn') },
              data.es.reachable ? t('esOk') : t('esDown')),
            h('span', { style: S.mono }, data.config.url),
            h('span', { style: S.muted }, `· ${data.es.status || '-'}`),
            h('span', { style: S.muted }, `· ${t('indexNames')}: ${data.config.indexes.personal} / ${data.config.indexes.team}`),
          ),
          data.es.reachable ? null : h('p', { style: S.err }, data.es.error),
        ),

        h('div', { style: S.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
            h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('recent')),
            h('button', { type: 'button', style: S.btn, onClick: onOpenBrowse }, t('tabBrowse')),
          ),
          data.recent.length === 0
            ? h('p', { style: S.muted }, t('empty'))
            : data.recent.map((row) =>
                h('div', {
                  key: `${row.scope}:${row.id}`,
                  style: {
                    display: 'flex',
                    gap: 10,
                    alignItems: 'baseline',
                    padding: '7px 0',
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                  },
                },
                  h('span', { style: S.pill('') }, row.scope === 'team' ? t('scopeTeam') : t('scopePersonal')),
                  h('span', { style: { flex: 1, fontSize: 12.5, color: 'var(--dsw-alias-label-primary)' } },
                    row.content.length > 64 ? `${row.content.slice(0, 64)}…` : row.content),
                  h('span', { style: { ...S.mono, ...S.muted } }, shortTime(row.updatedAt)),
                ),
              ),
        ),
      )
    }

    // ── 记忆浏览 ─────────────────────────────────────────────────────────
    function Browse({ t }) {
      const [scope, setScope] = React.useState('both')
      const [query, setQuery] = React.useState('')
      const [status, setStatus] = React.useState('active')
      const [includePending, setIncludePending] = React.useState(true)
      const [page, setPage] = React.useState(0)
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      const [selected, setSelected] = React.useState(null)
      const size = 20

      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        const params = { scope, page: String(page), size: String(size), status }
        if (query.trim() !== '') params.q = query.trim()
        if (includePending) params.includePending = '1'
        apiGet('/memories', params)
          .then((data) => setState({ loading: false, error: '', data }))
          .catch((error) => setState({ loading: false, error: String(error.message ?? error), data: null }))
      }, [scope, page, status, query, includePending])

      React.useEffect(() => {
        load()
      }, [load])

      const data = state.data
      const rows = data?.rows ?? []
      const total = data?.total ?? 0
      const maxPage = Math.max(0, Math.ceil(total / size) - 1)

      return h('div', null,
        h('div', { style: S.toolbar },
          h('div', { style: S.seg },
            [['both', t('scopeAll')], ['personal', t('scopePersonal')], ['team', t('scopeTeam')]].map(([value, label]) =>
              h('button', {
                key: value,
                type: 'button',
                style: S.segBtn(scope === value),
                onClick: () => {
                  setScope(value)
                  setPage(0)
                },
              }, label),
            ),
          ),
          h('input', {
            style: S.input,
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                setPage(0)
                load()
              }
            },
          }),
          h('button', {
            type: 'button',
            style: S.btn,
            onClick: () => {
              setPage(0)
              load()
            },
          }, t('searchGo')),
          h('select', {
            style: S.select,
            value: status,
            onChange: (event) => {
              setStatus(event.target.value)
              setPage(0)
            },
          },
            h('option', { value: 'active' }, t('statusActive')),
            h('option', { value: 'all' }, t('statusAll')),
          ),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('input', {
              type: 'checkbox',
              checked: includePending,
              onChange: (event) => {
                setIncludePending(event.target.checked)
                setPage(0)
              },
            }),
            t('includePending'),
          ),
        ),

        state.loading ? h('p', { style: S.muted }, t('loading')) : null,
        state.error
          ? h('div', null,
              h('p', { style: S.err }, `${t('error')}: ${state.error}`),
              h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
            )
          : null,

        state.loading || state.error
          ? null
          : h('div', { style: S.card },
              rows.length === 0
                ? h('p', { style: S.muted }, t('empty'))
                : h('table', { style: S.table },
                    h('thead', null,
                      h('tr', null,
                        h('th', { style: S.th }, t('colContent')),
                        h('th', { style: S.th }, t('colScope')),
                        h('th', { style: S.th }, t('colDomain')),
                        h('th', { style: S.th }, t('colType')),
                        h('th', { style: S.th }, t('colStatus')),
                        h('th', { style: S.th }, t('colUpdated')),
                        h('th', { style: S.th }, ''),
                      ),
                    ),
                    h('tbody', null,
                      rows.map((row) =>
                        h('tr', { key: `${row.scope}:${row.id}` },
                          h('td', { style: { ...S.td, maxWidth: 360 } },
                            row.content.length > 80 ? `${row.content.slice(0, 80)}…` : row.content),
                          h('td', { style: S.td }, h('span', { style: S.pill('') }, row.scope === 'team' ? t('scopeTeam') : t('scopePersonal'))),
                          h('td', { style: { ...S.td, ...S.mono } }, row.domain || '-'),
                          h('td', { style: { ...S.td, ...S.mono } }, row.memoryType || '-'),
                          h('td', { style: S.td },
                            h('span', { style: S.pill(row.reviewState === 'pending' ? 'warn' : 'ok') },
                              row.reviewState ? `${row.status}/${row.reviewState}` : row.status),
                          ),
                          h('td', { style: { ...S.td, ...S.mono } }, shortTime(row.updatedAt)),
                          h('td', { style: S.td },
                            h('button', { type: 'button', style: S.btn, onClick: () => setSelected(row) }, t('detail')),
                          ),
                        ),
                      ),
                    ),
                  ),

              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 12, ...S.muted } },
                  `${t('total')} ${total} ${t('rows')} · personal ${data?.totals?.personal ?? 0} / team ${data?.totals?.team ?? 0}`),
                h('span', { style: { flex: 1 } }),
                h('button', {
                  type: 'button',
                  style: { ...S.btn, opacity: page <= 0 ? 0.5 : 1 },
                  disabled: page <= 0,
                  onClick: () => setPage((value) => Math.max(0, value - 1)),
                }, t('prev')),
                h('span', { style: { fontSize: 12, ...S.mono } }, `${page + 1}/${maxPage + 1}`),
                h('button', {
                  type: 'button',
                  style: { ...S.btn, opacity: page >= maxPage ? 0.5 : 1 },
                  disabled: page >= maxPage,
                  onClick: () => setPage((value) => Math.min(maxPage, value + 1)),
                }, t('next')),
              ),
            ),

        selected
          ? h('div', { style: { ...S.card, marginTop: 12 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('detail')),
                h('button', { type: 'button', style: S.btn, onClick: () => setSelected(null) }, t('close')),
              ),
              h('p', { style: { margin: '0 0 10px', fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' } },
                selected.content),
              h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6, fontSize: 12 } },
                [
                  ['id', selected.id],
                  [t('colScope'), selected.scope],
                  [t('colDomain'), selected.domain],
                  [t('colType'), selected.memoryType],
                  [t('colStatus'), selected.reviewState ? `${selected.status}/${selected.reviewState}` : selected.status],
                  ['topic_key', selected.topicKey || '-'],
                  ['source_user', selected.sourceUser || '-'],
                  ['source_memory_id', selected.sourceMemoryId || '-'],
                  ['promote_state', selected.promoteState || '-'],
                  [t('colUpdated'), shortTime(selected.updatedAt)],
                ].map(([label, value]) =>
                  h('div', { key: label, style: { display: 'flex', gap: 6 } },
                    h('span', { style: { ...S.muted, minWidth: 110 } }, label),
                    h('span', { style: S.mono }, String(value ?? '-')),
                  ),
                ),
              ),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
                h(CopyButton, { text: selected.content, t }),
                h(CopyButton, { text: selected.id, t }),
              ),
            )
          : null,
      )
    }

    // ── 页面主体 ─────────────────────────────────────────────────────────
    function MemoryPanel({ t }) {
      const [tab, setTab] = React.useState('overview')
      const [overview, setOverview] = React.useState({ loading: true, error: '', data: null })

      const loadOverview = React.useCallback(() => {
        setOverview((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/overview')
          .then((data) => setOverview({ loading: false, error: '', data }))
          .catch((error) => setOverview({ loading: false, error: String(error.message ?? error), data: null }))
      }, [])

      React.useEffect(() => {
        if (tab === 'overview') loadOverview()
      }, [tab, loadOverview])

      return h('div', { style: S.wrap },
        h('h2', { style: S.h2 }, t('title')),
        h('p', { style: S.sub }, t('subtitle')),
        h('div', { style: S.tabs },
          [['overview', t('tabOverview')], ['browse', t('tabBrowse')]].map(([value, label]) =>
            h('button', {
              key: value,
              type: 'button',
              style: S.tab(tab === value),
              onClick: () => setTab(value),
            }, label),
          ),
        ),
        tab === 'overview'
          ? h(Overview, {
              data: overview.data,
              loading: overview.loading,
              error: overview.error,
              t,
              onRetry: loadOverview,
              onOpenBrowse: () => setTab('browse'),
            })
          : h(Browse, { t }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [ctx.locale.register(NS, 'zh', ZH), ctx.locale.register(NS, 'en', EN)]
          return () => {
            for (const dispose of disposers) dispose()
          }
        })
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'memory-es',
          order: 60,
          label: () => t('sectionLabel'),
        }, (props) => h(MemoryPanel, { ...props, t })))
      },
    }
  },
})
