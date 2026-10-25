/**
 * 「记忆库」设置页（settings.section 样板）。
 *
 * 这一版是**只读样板**：验证 Web UI 管道（客户端 bundle → 槽位注册 → 设置页渲染），
 * 真实数据接入留到下一步（需要宿主注册 Cordis Service + typert 描述符，
 * 客户端用 ctx.remote.<service>.<method>() 调用）。
 *
 * 约定（来自 Slots.listSubTree 的 settings.section 契约）：
 *   · 注册项：id（必填）、order、label（string | () => string）
 *   · 组件收到的 owner props：{ close: () => void }
 *   · 组件同时能拿到一组标准 hooks（useSessions 等），本样板暂不使用。
 * 文案走客户端 locale 服务：ctx.locale.register(ns, locale, dict) + ctx.locale.bind(ns)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-es-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'memory-es-panel'
    const ZH = {
      sectionLabel: '记忆库',
      title: '记忆库',
      subtitle: 'Elasticsearch 后端记忆（dsh-memory-es）。当前为只读样板，实时数据接入是下一步。',
      toolsTitle: '模型可调用的工具',
      tools: 'memory_save｜memory_search｜memory_update_status｜memory_promote',
      promptTitle: '系统提示段',
      promptBody: '插件会往系统提示里插一段「什么时候该用记忆」，让模型自己判断该存、该查还是该更新。',
      cmdTitle: '常用命令（在插件仓库目录执行）',
      storageTitle: '存储布局',
      storageBody: '个人库 personal_memory_<用户>（含向量）｜团队库 team_knowledge（审核通过才可检索）｜审计库 memory_audit',
      copied: '已复制',
      copy: '复制',
      next: '下一步：实时记忆列表 + 审核动作（批准 / 驳回 / 撤回）。需要宿主注册远程服务，客户端从 ctx.remote 取数。',
      close: '关闭',
    }
    const EN = {
      sectionLabel: 'Memory',
      title: 'Memory',
      subtitle: 'Elasticsearch-backed memory (dsh-memory-es). This is a read-only sample; live data comes next.',
      toolsTitle: 'Tools the model can call',
      tools: 'memory_save | memory_search | memory_update_status | memory_promote',
      promptTitle: 'System prompt section',
      promptBody: 'The plugin injects a section telling the model when memory is worth using.',
      cmdTitle: 'Common commands (run in the plugin repository)',
      storageTitle: 'Storage layout',
      storageBody: 'Personal index personal_memory_<user> (with vectors) | Team index team_knowledge (retrievable only after review) | Audit index memory_audit',
      copied: 'Copied',
      copy: 'Copy',
      next: 'Next: live memory list and review actions (approve / reject / withdraw). Needs a Host remote service; the client reads it from ctx.remote.',
      close: 'Close',
    }

    const COMMANDS = [
      { label: '列出记忆', cmd: 'node consolidate/cli.ts --ls' },
      { label: '待裁决队列', cmd: 'node consolidate/cli.ts --review list' },
      { label: '导出 Markdown', cmd: 'node consolidate/cli.ts --export' },
    ]

    const card = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-1)',
      padding: '14px 16px',
      marginBottom: 12,
    }
    const cardTitle = {
      margin: '0 0 8px',
      fontSize: 13,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    }
    const bodyText = {
      margin: 0,
      fontSize: 13,
      lineHeight: 1.65,
      color: 'var(--dsw-alias-label-secondary)',
    }

    /** 一条命令 = 等宽代码 + 复制按钮（clipboard 不可用时退化成选中提示） */
    function CommandRow({ item, t }) {
      const [done, setDone] = React.useState(false)
      const copy = () => {
        const text = item.cmd
        const fallback = () => {
          const area = document.createElement('textarea')
          area.value = text
          document.body.appendChild(area)
          area.select()
          try {
            document.execCommand('copy')
          } catch {
            /* 忽略：复制失败不阻塞面板 */
          }
          document.body.removeChild(area)
        }
        const write = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text).catch(fallback)
          : Promise.resolve(fallback())
        Promise.resolve(write).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        })
      }
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
        h('code', {
          style: {
            flex: 1,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          },
        }, item.cmd),
        h('button', {
          type: 'button',
          onClick: copy,
          style: {
            flex: '0 0 auto',
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: done ? 'var(--dsw-alias-state-success-primary)' : 'transparent',
            color: done ? '#fff' : 'var(--dsw-alias-label-primary)',
            cursor: 'pointer',
          },
        }, done ? t('copied') : t('copy')),
      )
    }

    function MemoryPanel(props) {
      const t = props.t
      return h('div', { style: { padding: '4px 2px 8px' } },
        h('h2', { style: { margin: '0 0 6px', fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
        h('p', { style: { ...bodyText, marginBottom: 16 } }, t('subtitle')),

        h('div', { style: card },
          h('h3', { style: cardTitle }, t('toolsTitle')),
          h('p', { style: { ...bodyText, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } }, t('tools')),
        ),

        h('div', { style: card },
          h('h3', { style: cardTitle }, t('promptTitle')),
          h('p', { style: bodyText }, t('promptBody')),
        ),

        h('div', { style: card },
          h('h3', { style: cardTitle }, t('cmdTitle')),
          COMMANDS.map((item) => h(CommandRow, { key: item.cmd, item: { ...item, label: t('copy') }, t })),
        ),

        h('div', { style: card },
          h('h3', { style: cardTitle }, t('storageTitle')),
          h('p', { style: bodyText }, t('storageBody')),
        ),

        h('p', {
          style: {
            margin: '4px 0 0',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--dsw-alias-label-secondary)',
            borderLeft: '3px solid var(--dsw-alias-brand-primary)',
            paddingLeft: 10,
          },
        }, t('next')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 字典按活跃语言自动切换；disposer 交回 ctx.effect，插件卸载时清干净
        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'zh', ZH),
            ctx.locale.register(NS, 'en', EN),
          ]
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
