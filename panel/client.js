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
      versionLabel: '版本',
      tabOverview: '概览',
      tabBrowse: '记忆浏览',
      tabReview: '审核台',
      tabIdentity: '自述',
      idTitle: '待采纳的候选（自述 / 人格）',
      idEmpty: '还没有候选。自述用 memory_traits 提炼，人格用 memory_persona 归纳（两者都先 dry_run 看看）。',
      idEvidence: '依据',
      idApprove: '采纳',
      idReject: '拒绝',
      idNote: '备注（可选）',
      idApproved: '已采纳，这条自述现在会参与检索。',
      idRejected: '已拒绝，条目置 archived（内容保留）。',
      idAudit: '我的审核记录',
      idAuditEmpty: '还没有审核记录。',
      idBusy: '处理中…',
      idHint: '采纳是唯一让候选生效的动作：pending 不进检索，active 才会。',
      idActiveTitle: '生效中的自述',
      idActiveEmpty: '还没有生效的自述。',
      idAnchorOn: '锚点：开',
      idAnchorOff: '设为锚点',
      idAnchorHint: '锚点 = 提炼任务不再把它当素材，避免又归纳出一条差不多的。',
      idHistory: '历史',
      idHistoryTitle: '版本历史',
      idHistoryEmpty: '没有更早的版本。',
      idClose: '收起',
      tabPersona: '人格',
      personaKernel: '人格内核（你定的）',
      personaKernelHint: '来自配置 persona.seed；模型不会改它，改它要动配置文件',
      personaKernelEmpty: '配置里的 persona.seed 为空，现在只有学到的倾向在生效。',
      personaLearned: '我学到的倾向',
      personaLearnedHint: '从会话里归纳、经你采纳后才生效；pending 不进提示词',
      personaLearnedEmpty: '还没有学到的倾向。用 memory_persona 归纳一次，再回来采纳。',
      personaPending: '待采纳',
      personaEdit: '编辑',
      personaSave: '保存',
      personaCancel: '取消',
      personaSaved: '已保存。配置热重载后下一轮提示词生效；若下一轮没变，重启 dsh-web。',
      personaStickers: '表情包',
      personaStickerDir: '目录',
      personaStickerLimit: '单次最多',
      personaStickerMissing: '文件缺失',
      personaStickerNone: '这个目录里没有 stickers.json（图片不进仓库，要自己放）',
      personaDiary: '日记',
      diaryTabJournal: '每日回顾',
      diaryTabEvents: '变迁',
      diaryJournalEmpty: '还没有回顾。默认每天 23:30 之后把当天对话压成一段；也可以在对话里让助手跑 memory_journal 补某一天。',
      diaryJournalHint: '按天一段，直接生效、不进审核',
      personaDiaryHint: '这里只记「我怎么变成现在这样」：人格与自述条目何时被采纳、何时被拒绝',
      personaDiaryEmpty: '还没有记录。',
      colWhen: '时间',
      colKind: '类型',
      colState: '状态',
      colContent: '内容',
      colLabel: '名称',
      colFile: '文件',
      kindPersona: '人格',
      kindIdentity: '自述',
      stateActive: '生效中',
      stateArchived: '已拒绝',
      tabConfig: '配置',
      tabMaint: '维护',
      cardPersonal: '个人记忆',
      cardTeam: '团队知识',
      cardDocs: '文档',
      cardDocChunks: '分块',
      cardPending: '待裁决',
      moodTitle: '此刻心情',
      moodCalm: '平静',
      moodGreat: '愉快',
      moodGood: '不错',
      moodMeh: '有点闷',
      moodLow: '低落',
      moodNeutral: '还没有情绪记录',
      moodUpdated: '更新于',
      moodEvents: '最近事件',
      moodNote: '心情只由事件推动（用户夸奖/批评、工具成败），面板不提供手动修改。',
      cardAudit: '审计事件',
      cardAuditNA: '需配置整理身份（identity.consolidatorPassword）后可见',
      cardAudit7d: '近 7 天',
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
      colDomain: '领域',
      colType: '类型',
      colStatus: '状态',
      colUpdated: '更新时间',
      detail: '详情',
      delBtn: '删除',
      delTitle: '删除这条记忆',
      delIrreversible: '物理删除，不可恢复',
      delReasonPlaceholder: '删除原因（团队记忆必填，会写进审计）',
      delReasonRequired: '团队记忆必须填写删除原因',
      delConfirm: '确认删除',
      delCancel: '取消',
      delBusy: '删除中…',
      delDone: '已删除',
      delDoneAudited: '已删除，并已写入审计',
      copy: '复制',
      copyContent: '复制内容',
      copyId: '复制 ID',
      copied: '已复制',
      prev: '上一页',
      next: '下一页',
      total: '共',
      rows: '条',
      loading: '加载中…',
      error: '出错了',
      retry: '重试',
      close: '关闭',
      reviewEmpty: '没有待裁决的条目',
      reviewConflict: '冲突对象',
      reviewApprove: '批准',
      reviewReject: '驳回',
      reviewWithdraw: '撤回',
      reviewReason: '原因（驳回/撤回必填）',
      reviewConfirm: '确认',
      reviewCancel: '取消',
      reviewDone: '已完成',
      reviewAuditFailed: '（审计写入失败，请查日志）',
      browseTruncated: '结果窗口已到上限 500 条，请用搜索缩小范围',
      reviewNoWrite: '未配置整理身份（identity.consolidatorPassword），审核动作不可用。',
      capsReader: '当前是只读部署（没有整理身份）：审核台不显示，团队库只能看不能改。',
      reviewBusy: '处理中…',
      maintConsolidate: '整理任务',
      maintLastRun: '上次运行',
      maintNever: '还没跑过',
      maintDryRun: '跑一次 dry-run',
      maintApply: '真写库',
      maintApplyWarn: '会写团队库，需确认',
      userSelf: '我',
      userFilterHint: '切换查看谁的个人记忆（管理员）',
      viewingOther: '正在查看别人的个人记忆',
      readOnlyOther: '只读，不能删除',
      maintTargetUser: '目标用户',
      maintStatScope: '统计对象',
      maintOtherWarn: '整理别人的记忆会改写对方的 promote_state（标记已处理），不影响其检索与使用',
      maintExport: 'Markdown 镜像',
      maintExportNow: '立即导出',
      maintSnapshot: '快照',
      maintCron: '定时任务',
      maintResult: '结果',
      labelPersonal: '个人库',
      labelTeam: '团队库',
      labelDocs: '文档数',
      labelPending: '待裁决',
      labelDir: '目录',
      labelFiles: '文件数',
      labelManagedBy: '管理者',
      labelEntry: '配置行',
      labelUser: '用户',
      labelAuditIndex: '审计库',
      labelReader: '只读身份',
      labelWriter: '写身份',
      labelConsolidator: '整理身份',
      labelEmbedding: '向量模型',
      labelSource: '来源',
      filterDomain: '领域',
      filterType: '类型',
      tpContext: '上下文',
      tpFact: '事实',
      tpPreference: '偏好',
      tpInsight: '洞察',
      tpDecision: '决定',
      tpGeneral: '通用',
      dmGeneral: '通用',
      filterAll: '全部',
      reviewPage: '第',
      mirrorPreview: '查看内容',
      mirrorEmpty: '（文件为空）',
      mirrorTooBig: '文件超过 256 KB，不在面板里预览',
      stActive: '有效',
      stPending: '待裁决',
      stApproved: '已通过',
      stRejected: '已驳回',
      stSuperseded: '已撤回',
      stAuto: '自动',
      stExpired: '已过期',
      maintCliMissing: '面板未随带 CLI 源码，整理与导出不可用（部署时缺 panel/cli）',
      configTitle: '配置',
      configSave: '保存',
      configSaved: '已保存到 profile 配置',
      configRestart: '⚠️ 需要重启 dsh 才生效（ES 客户端在插件加载时建立）。容器里执行：docker restart <容器名>',
      configReadonly: '只读信息（密码不显示）',
      configNoChange: '没有改动',
      configChanged: '有未保存改动',
      indexNames: '索引',
      embedding: '嵌入',
      auditNote: '审计索引不在插件配置里，且只读身份没有它的读权限，P3 再补。',
    }
    const EN = {
      sectionLabel: 'Memory',
      title: 'Memory',
      subtitle: 'Elasticsearch-backed memory (dsh-memory-es): overview and browse.',
      versionLabel: 'Version',
      tabOverview: 'Overview',
      tabBrowse: 'Browse',
      tabReview: 'Review',
      tabIdentity: 'Identity',
      idTitle: 'Draft identity traits',
      idEmpty: 'No drafts yet. Run memory_traits first (dry_run to preview).',
      idEvidence: 'evidence',
      idApprove: 'Approve',
      idReject: 'Reject',
      idNote: 'Note (optional)',
      idApproved: 'Approved — this trait is now live.',
      idRejected: 'Rejected — archived, content kept.',
      idAudit: 'My review log',
      idAuditEmpty: 'No review records yet.',
      idBusy: 'Working…',
      idHint: 'Approving is the only action that makes a draft live: pending is never retrieved, active is.',
      idActiveTitle: 'Live traits',
      idActiveEmpty: 'No live traits yet.',
      idAnchorOn: 'Anchor: on',
      idAnchorOff: 'Set anchor',
      idAnchorHint: 'Anchored traits are excluded from distillation so they are not re-derived.',
      idHistory: 'History',
      idHistoryTitle: 'Version history',
      idHistoryEmpty: 'No earlier versions.',
      idClose: 'Hide',
      tabPersona: 'Persona',
      personaKernel: 'Core persona (yours)',
      personaKernelHint: 'From persona.seed in config; the model never rewrites it',
      personaKernelEmpty: 'persona.seed is empty — only the learned traits are active.',
      personaLearned: 'Traits I learned',
      personaLearnedHint: 'Distilled from sessions, active only after your approval; pending never reaches the prompt',
      personaLearnedEmpty: 'Nothing learned yet. Run memory_persona, then approve here.',
      personaPending: 'pending',
      personaEdit: 'Edit',
      personaSave: 'Save',
      personaCancel: 'Cancel',
      personaSaved: 'Saved. Takes effect next turn after config reload; restart dsh-web if it does not.',
      personaStickers: 'Stickers',
      personaStickerDir: 'Directory',
      personaStickerLimit: 'Max per reply',
      personaStickerMissing: 'missing',
      personaStickerNone: 'No stickers.json in that directory (images are not shipped).',
      personaDiary: 'Diary',
      diaryTabJournal: 'Daily',
      diaryTabEvents: 'Changes',
      diaryJournalEmpty: 'No daily recaps yet. They are written automatically after the configured time; run memory_journal to backfill a day.',
      diaryJournalHint: 'One entry per day; takes effect without review',
      personaDiaryHint: 'Only records how I became this: when persona/identity entries were approved or rejected',
      personaDiaryEmpty: 'No records yet.',
      colWhen: 'When',
      colKind: 'Kind',
      colState: 'State',
      colContent: 'Content',
      colLabel: 'Label',
      colFile: 'File',
      kindPersona: 'Persona',
      kindIdentity: 'Identity',
      stateActive: 'active',
      stateArchived: 'rejected',
      tabConfig: 'Config',
      tabMaint: 'Maintenance',
      cardPersonal: 'Personal',
      cardTeam: 'Team',
      cardDocs: 'Docs',
      cardDocChunks: 'chunks',
      cardPending: 'Pending review',
      moodTitle: 'Current mood',
      moodCalm: 'Calm',
      moodGreat: 'Cheerful',
      moodGood: 'Good',
      moodMeh: 'A bit low',
      moodLow: 'Down',
      moodNeutral: 'No mood recorded yet',
      moodUpdated: 'Updated',
      moodEvents: 'Recent events',
      moodNote: 'Mood is driven by events only (praise/criticism, tool success/failure); there is no manual override.',
      cardAudit: 'Audit events',
      cardAuditNA: 'visible once identity.consolidatorPassword is configured',
      cardAudit7d: 'last 7 days',
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
      delBtn: 'Delete',
      delTitle: 'Delete this memory',
      delIrreversible: 'Permanent deletion, cannot be undone',
      delReasonPlaceholder: 'Reason (required for team memory, written to audit)',
      delReasonRequired: 'A reason is required for team memory',
      delConfirm: 'Confirm delete',
      delCancel: 'Cancel',
      delBusy: 'Deleting…',
      delDone: 'Deleted',
      delDoneAudited: 'Deleted and audited',
      copy: 'Copy',
      copyContent: 'Copy content',
      copyId: 'Copy ID',
      copied: 'Copied',
      prev: 'Prev',
      next: 'Next',
      total: 'Total',
      rows: 'rows',
      loading: 'Loading…',
      error: 'Failed',
      retry: 'Retry',
      close: 'Close',
      reviewEmpty: 'Nothing pending review',
      reviewConflict: 'Conflicting entry',
      reviewApprove: 'Approve',
      reviewReject: 'Reject',
      reviewWithdraw: 'Withdraw',
      reviewReason: 'Reason (required for reject/withdraw)',
      reviewConfirm: 'Confirm',
      reviewCancel: 'Cancel',
      reviewDone: 'Done',
      reviewAuditFailed: '(audit write failed — check the log)',
      browseTruncated: 'result window hit the 500-document cap; narrow the search',
      reviewNoWrite: 'Consolidator identity (identity.consolidatorPassword) is not configured; review actions are unavailable.',
      capsReader: 'Read-only deployment (no consolidator identity): the review tab is hidden and the team library is read-only.',
      reviewBusy: 'Working…',
      maintExportNow: 'Export now',
      maintSnapshot: 'Snapshots',
      maintCron: 'Scheduled job',
      maintResult: 'Result',
      labelPersonal: 'Personal',
      labelTeam: 'Team',
      labelDocs: 'Docs',
      labelPending: 'Pending',
      labelDir: 'Directory',
      labelFiles: 'Files',
      labelManagedBy: 'Managed by',
      labelEntry: 'Entry',
      labelUser: 'User',
      labelAuditIndex: 'Audit index',
      labelReader: 'Reader identity',
      labelWriter: 'Writer identity',
      labelConsolidator: 'Consolidator identity',
      labelEmbedding: 'Embedding model',
      labelSource: 'Source',
      filterDomain: 'Domain',
      filterType: 'Type',
      tpContext: 'Context',
      tpFact: 'Fact',
      tpPreference: 'Preference',
      tpInsight: 'Insight',
      tpDecision: 'Decision',
      tpGeneral: 'General',
      dmGeneral: 'General',
      filterAll: 'All',
      reviewPage: 'Page',
      mirrorPreview: 'Preview',
      mirrorEmpty: '(empty file)',
      mirrorTooBig: 'File is larger than 256 KB; preview disabled',
      stActive: 'active',
      stPending: 'pending',
      stApproved: 'approved',
      stRejected: 'rejected',
      stSuperseded: 'superseded',
      stAuto: 'auto',
      stExpired: 'expired',
      maintCliMissing: 'CLI sources were not shipped with the panel',
      configTitle: 'Configuration',
      configSave: 'Save',
      configSaved: 'Saved to the profile configuration',
      configRestart: '⚠️ Restart dsh for it to take effect (the ES client is built when the plugin loads). In a container: docker restart <container>',
      configReadonly: 'Read-only info (passwords hidden)',
      configNoChange: 'No changes',
      configChanged: 'Unsaved changes',
      indexNames: 'Indexes',
      embedding: 'Embedding',
      auditNote: 'The audit index is not in the plugin config and the reader identity cannot read it; P3 will add it.',
      maintConsolidate: 'Consolidation',
      maintLastRun: 'Last run',
      maintNever: 'never',
      maintDryRun: 'Run dry-run',
      maintApply: 'Apply to library',
      maintApplyWarn: 'writes the team index — needs confirmation',
      userSelf: 'Me',
      userFilterHint: 'Switch which user’s personal memory to view (admin)',
      viewingOther: 'Viewing another user’s personal memory',
      readOnlyOther: 'read-only, delete disabled',
      maintTargetUser: 'Target user',
      maintStatScope: 'Stats for',
      maintOtherWarn: 'Consolidating another user’s memory rewrites their promote_state (marked as processed); search and usage are unaffected',
      maintExport: 'Markdown mirror',
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
      // 双行列表（替代 7 列表格）：第一行「库 + 内容 + 状态 + 时间」，第二行「领域 · 类型 + 操作」。
      // 表格版把中文挤成竖排（个/人、详/情），内容又换行占三四行，一屏只能看 4 条。
      row: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      rowMain: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 },
      // minWidth: 0 是关键：flex 子项默认 min-width:auto，不加它省略号不会生效
      rowTitle: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
      },
      rowTime: {
        flexShrink: 0,
        whiteSpace: 'nowrap',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      rowMeta: {
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
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

    async function apiPost(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const type = res.headers.get('content-type') || ''
      if (!type.includes('application/json')) {
        throw new Error(`HTTP ${res.status}，返回 ${type || '无 content-type'} 而不是 JSON`)
      }
      const payload = await res.json()
      if (!payload.ok) throw new Error(payload.error || `HTTP ${res.status}`)
      return payload.value
    }

    const STATE_KEYS = {
      active: 'stActive',
      pending: 'stPending',
      approved: 'stApproved',
      rejected: 'stRejected',
      superseded: 'stSuperseded',
      auto: 'stAuto',
      expired: 'stExpired',
    }

    // 记忆类型中文化：只翻语义明确的枚举值，认不出的原样露出
    const TYPE_KEYS = {
      context: 'tpContext',
      fact: 'tpFact',
      preference: 'tpPreference',
      insight: 'tpInsight',
      decision: 'tpDecision',
      general: 'tpGeneral',
    }

    // 领域里只有「未分类」这个语义值需要翻；lottery-cloud 之类是业务代号，原样保留
    const DOMAIN_KEYS = { general: 'dmGeneral' }

    function typeLabel(value, t) {
      if (!value) return '-'
      const key = TYPE_KEYS[value]
      return key ? t(key) : value
    }

    function domainLabel(value, t) {
      if (!value) return '-'
      const key = DOMAIN_KEYS[value]
      return key ? t(key) : value
    }

    /** 状态值中文化：不认识的值原样返回（宁可露原文，也别猜错语义） */
    function stateLabel(value, t) {
      if (!value) return ''
      const key = STATE_KEYS[value]
      return key ? t(key) : value
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

    function CopyButton({ text, t, label }) {
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
      }, done ? t('copied') : (label ?? t('copy')))
    }

    // ── 心情卡（阶段 6.2）───────────────────────────────────────────────
    const MOOD_LABELS = [
      [0.5, 'moodGreat'],
      [0.12, 'moodGood'],
      [-0.12, 'moodCalm'],
      [-0.5, 'moodMeh'],
    ]
    function moodLabelOf(valence, t) {
      for (const [threshold, key] of MOOD_LABELS) {
        if (valence >= threshold) return t(key)
      }
      return t('moodLow')
    }

    function MoodCard({ mood, t }) {
      const exists = mood && mood.exists
      const valence = exists ? Number(mood.valence) || 0 : 0
      const events = exists && Array.isArray(mood.events) ? mood.events : []
      if (!exists) {
        const why = mood && mood.note ? ` · ${String(mood.note).slice(0, 160)}` : ''
        return h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: S.muted }, `${t('moodTitle')} · ${t('moodNeutral')}${why}`),
          h('p', { style: { ...S.muted, marginTop: 6, fontSize: 12 } }, t('moodNote')),
        )
      }
      // -1..1 映射成 0..100% 的填充：左负右正，视觉上"往哪边偏"一眼能看出
      const pct = Math.round(((valence + 1) / 2) * 100)
      const strong = Math.abs(valence) >= 0.12
      return h('div', { style: { ...S.card, marginBottom: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
            `${t('moodTitle')} · ${strong ? moodLabelOf(valence, t) : t('moodCalm')}`),
          h('span', { style: S.muted },
            `${valence >= 0 ? '+' : ''}${valence.toFixed(2)} · ${t('moodUpdated')} ${String(mood.updatedAt || '').replace('T', ' ').slice(0, 16)}`),
        ),
        h('div', {
          style: { marginTop: 8, height: 6, borderRadius: 999, background: 'var(--dsw-alias-fill-2, rgba(127,127,127,.18))', overflow: 'hidden' },
        }, h('div', {
          style: { width: `${pct}%`, height: '100%', borderRadius: 999, background: valence >= 0 ? '#4c9a6a' : '#b8623f' },
        })),
        events.length === 0
          ? null
          : h('div', { style: { marginTop: 10 } },
              h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 4 } }, `${t('moodEvents')}（${events.length}）`),
              events.slice(0, 5).map((event, index) =>
                h('div', { key: `${index}:${event.at ?? ''}`, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 } },
                  `· ${String(event.kind ?? '?')}${event.note ? `（${event.note}）` : ''} · ${String(event.at ?? '').replace('T', ' ').slice(5, 16)}`),
              ),
            ),
        h('p', { style: { ...S.muted, marginTop: 8, fontSize: 12 } }, t('moodNote')),
      )
    }

    // ── 概览 ─────────────────────────────────────────────────────────────
    function Overview({ data, mood, loading, error, t, onRetry, onOpenBrowse }) {
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
            label: t('cardDocs'),
            value: show(counts.docs),
            hint:
              counts.docChunks === undefined || counts.docChunks === null || counts.docChunks <= 0
                ? ''
                : `${counts.docChunks} ${t('cardDocChunks')}`,
          }),
          h(StatCard, {
            label: t('cardPending'),
            value: show(counts.pending),
            hint: counts.pending > 0 ? '→ ' + t('tabBrowse') : '',
          }),
          h(StatCard, {
            label: t('cardAudit'),
            value: counts.audit === null || counts.audit === undefined ? '—' : counts.audit,
            hint:
              counts.auditLast7d === null || counts.auditLast7d === undefined
                ? t('cardAuditNA')
                : `${t('cardAudit7d')} ${counts.auditLast7d}`,
          }),
        ),

        MoodCard({ mood, t }),

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

    // ── 维护（P3：整理 dry-run / 镜像导出 / 快照与 cron 的静态事实）──────────
    function Maintenance({ t, canReview, caps }) {
      const [state, setState] = React.useState({ loading: true, error: '', data: null })

      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      // 整理谁的个人记忆：'' = 自己；管理员可切到别人（CLI 用 --user 指定）
      const [targetUser, setTargetUser] = React.useState('')
      const [users, setUsers] = React.useState([])

      React.useEffect(() => {
        if (!caps?.canAdmin) return
        apiGet('/users')
          .then((value) => setUsers(value.users ?? []))
          .catch(() => setUsers([]))
      }, [caps?.canAdmin])

      // 统计要跟着"目标用户"走：选了别人整理，上面的个人/团队计数也得是那个人的
      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/maintenance', targetUser === '' ? undefined : { user: targetUser })
          .then((data) => setState({ loading: false, error: '', data }))
          .catch((error) => setState({ loading: false, error: String(error.message ?? error), data: null }))
      }, [targetUser])

      React.useEffect(() => {
        load()
      }, [load])

      const run = (kind) => {
        setBusy(kind)
        setResult(null)
        const path = kind === 'export' ? '/maintenance/export' : '/maintenance/consolidate'
        const body = kind === 'export' ? {} : { apply: kind === 'apply', confirm: kind === 'apply' }
        // 整理指定用户（'' = 自己）；导出与用户无关
        if (kind !== 'export' && targetUser !== '') body.userId = targetUser
        apiPost(path, body)
          .then((value) => {
            setResult({ kind, value })
            load()
          })
          .catch((error) => setResult({ kind, error: String(error.message ?? error) }))
          .finally(() => setBusy(''))
      }

      if (state.loading) return h('p', { style: S.muted }, t('loading'))
      if (state.error) {
        return h('div', null,
          h('p', { style: S.err }, `${t('error')}: ${state.error}`),
          h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
        )
      }
      const data = state.data

      const card = (title, body, actions) =>
        h('div', { style: { ...S.card, marginBottom: 12 } },
          h('h3', { style: { margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
          body,
          actions ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } }, actions) : null,
        )

      const line = (label, value) =>
        h('div', { key: label, style: { display: 'flex', gap: 10, marginBottom: 4, fontSize: 12 } },
          h('span', { style: { width: 110, ...S.muted } }, label),
          h('span', { style: S.mono }, String(value ?? '-')),
        )

      return h('div', null,
        data.cli.available ? null : h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('maintCliMissing')),

        card(t('maintConsolidate'),
          h('div', null,
            // 目标用户：管理员可以把别人的个人记忆整理进团队库
            caps?.canAdmin
              ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 12 } },
                  h('span', { style: { width: 110, ...S.muted } }, t('maintTargetUser')),
                  h('select', {
                    style: S.select,
                    value: targetUser,
                    onChange: (event) => {
                      setTargetUser(event.target.value)
                      setResult(null)
                    },
                  },
                    h('option', { value: '' }, `${t('userSelf')} · ${caps.userId || ''}`.trim()),
                    users
                      .filter((entry) => entry.userId !== caps.userId)
                      .map((entry) => h('option', { key: entry.userId, value: entry.userId }, `${entry.userId} · ${entry.count}`)),
                  ),
                )
              : null,
            // 整理别人时把后果说清楚：只改 promote_state，不动个人记忆的可用性
            caps?.canAdmin && targetUser !== ''
              ? h('p', { style: { margin: '0 0 8px 118px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-primary)' } }, t('maintOtherWarn'))
              : null,
            line(t('maintStatScope'), data.userId || '-'),
            line(t('maintLastRun'), data.lastRunAt ? shortTime(data.lastRunAt) : t('maintNever')),
            line(t('labelPersonal'), data.counts.personal),
            line(t('labelTeam'), data.counts.team),
            line(t('labelDocs'), data.counts.docs),
            line(t('labelPending'), data.counts.pending),
          ),
          [
            h('button', {
              type: 'button',
              style: { ...S.btn, opacity: busy ? 0.5 : 1 },
              disabled: Boolean(busy) || !data.cli.available,
              onClick: () => run('dry'),
            }, busy === 'dry' ? t('reviewBusy') : t('maintDryRun')),
            h('button', {
              type: 'button',
              style: { ...S.btn, opacity: busy ? 0.5 : 1, borderColor: 'var(--dsw-alias-state-warn-primary)' },
              disabled: Boolean(busy) || !data.cli.available || canReview === false,
              title: canReview === false ? t('reviewNoWrite') : t('maintApplyWarn'),
              onClick: () => {
                if (!window.confirm(`${t('maintApply')}: ${t('maintApplyWarn')}`)) return
                run('apply')
              },
            }, busy === 'apply' ? t('reviewBusy') : t('maintApply')),
          ],
        ),

        card(t('maintExport'),
          h('div', null,
            line(t('labelDir'), data.mirror.dir),
            line(t('maintLastRun'), data.mirror.latest ? shortTime(data.mirror.latest) : t('maintNever')),
            line(t('labelFiles'), data.mirror.exists ? data.mirror.files.length : 0),
            data.mirror.files.length > 0
              ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 } },
                  data.mirror.files.map((name) =>
                    h('button', {
                      key: name,
                      type: 'button',
                      style: { ...S.btn, fontSize: 11.5, padding: '2px 8px' },
                      onClick: () => {
                        setPreview({ loading: true, name })
                        apiGet('/maintenance/mirror', { name })
                          .then((value) => setPreview({ loading: false, ...value }))
                          .catch((error) => setPreview({ loading: false, name, error: String(error.message ?? error) }))
                      },
                    }, name),
                  ),
                )
              : null,
            preview
              ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' } },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
                    h('span', { style: { ...S.mono, fontSize: 12 } }, preview.name),
                    preview.size !== undefined ? h('span', { style: { ...S.muted, fontSize: 11.5 } }, `${preview.size} B`) : null,
                    h('span', { style: { flex: 1 } }),
                    h('button', { type: 'button', style: { ...S.btn, fontSize: 11.5, padding: '2px 8px' }, onClick: () => setPreview(null) }, t('close')),
                  ),
                  preview.loading
                    ? h('span', { style: S.muted }, t('loading'))
                    : preview.error
                    ? h('span', { style: S.err }, preview.error)
                    : preview.truncated
                    ? h('span', { style: { ...S.muted, fontSize: 12 } }, t('mirrorTooBig'))
                    : h('pre', {
                        style: {
                          margin: 0,
                          maxHeight: 260,
                          overflow: 'auto',
                          fontSize: 11.5,
                          lineHeight: 1.6,
                          whiteSpace: 'pre-wrap',
                          color: 'var(--dsw-alias-label-secondary)',
                        },
                      }, preview.content === '' ? t('mirrorEmpty') : preview.content),
                )
              : null,
          ),
          [h('button', {
            type: 'button',
            style: { ...S.btn, opacity: busy ? 0.5 : 1 },
            disabled: Boolean(busy) || !data.cli.available,
            onClick: () => run('export'),
          }, busy === 'export' ? t('reviewBusy') : t('maintExportNow'))],
        ),

        card(t('maintSnapshot'),
          h('div', null,
            line(t('labelManagedBy'), data.snapshot.managedBy),
            h('p', { style: { ...S.muted, fontSize: 12, margin: '4px 0 0', lineHeight: 1.6 } }, data.snapshot.note),
          ),
        ),

        card(t('maintCron'),
          h('div', null,
            line(t('labelManagedBy'), data.cron.managedBy),
            h('p', { style: { ...S.muted, fontSize: 12, margin: '4px 0 0', lineHeight: 1.6 } }, data.cron.note),
          ),
        ),

        result
          ? h('div', {
              style: {
                ...S.card,
                borderLeft: '3px solid var(--dsw-alias-brand-primary)',
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                lineHeight: 1.7,
                color: 'var(--dsw-alias-label-primary)',
              },
            },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, `${t('maintResult')}: ${result.kind}`),
              result.error
                ? h('span', { style: S.err }, result.error)
                : h('div', null,
                    h('div', null, `exit=${result.value.exitCode}`),
                    (result.value.lines ?? []).map((text, index) => h('div', { key: index }, text)),
                    result.value.stderr ? h('div', { style: { ...S.err, marginTop: 6 } }, result.value.stderr) : null,
                  ),
            )
          : null,
      )
    }

    // ── 配置（P4：可改白名单字段 + 强制重启提示）──────────────────────────
    function Config({ t }) {
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)

      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/config')
          .then((data) => {
            setState({ loading: false, error: '', data })
            const next = {}
            for (const field of data.fields) next[field.key] = field.value
            setDraft(next)
            setResult(null)
          })
          .catch((error) => setState({ loading: false, error: String(error.message ?? error), data: null }))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const data = state.data
      const norm = (value) => (typeof value === 'boolean' ? String(value) : String(value ?? ''))
      const changed = data
        ? data.fields.filter((field) => norm(draft[field.key]) !== norm(field.value))
        : []

      const save = () => {
        if (changed.length === 0) return
        setBusy(true)
        apiPost('/config', {
          confirm: true,
          changes: changed.map((field) => ({ key: field.key, type: field.type, value: draft[field.key] })),
        })
          .then((value) => setResult(value))
          .catch((error) => setState((prev) => ({ ...prev, error: String(error.message ?? error) })))
          .finally(() => setBusy(false))
      }

      if (state.loading) return h('p', { style: S.muted }, t('loading'))
      if (state.error) {
        return h('div', null,
          h('p', { style: S.err }, `${t('error')}: ${state.error}`),
          h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
        )
      }

      return h('div', null,
        h('div', { style: S.card },
          h('h3', { style: { margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('configTitle')),
          data.fields.map((field) =>
            h('div', { key: field.key, style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 } },
              h('label', { style: { width: 130, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, field.label),
              field.type === 'boolean'
                ? h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', flex: 1, fontSize: 12.5 } },
                    h('input', {
                      type: 'checkbox',
                      checked: draft[field.key] === true || draft[field.key] === 'true',
                      onChange: (event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.checked })),
                    }),
                    h('span', { style: S.muted }, field.hint ?? ''),
                  )
                : h('input', {
                    style: { ...S.input, flex: 1 },
                    type: field.type === 'number' ? 'number' : 'text',
                    value: draft[field.key] ?? '',
                    placeholder: field.hint ?? '',
                    onChange: (event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value })),
                  }),
              h('code', { style: { ...S.mono, ...S.muted, width: 170 } }, field.key),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              style: { ...S.btn, opacity: busy || changed.length === 0 ? 0.5 : 1 },
              disabled: busy || changed.length === 0,
              onClick: save,
            }, busy ? t('reviewBusy') : t('configSave')),
            h('span', { style: { fontSize: 12, ...S.muted } },
              changed.length === 0 ? t('configNoChange') : `${t('configChanged')}: ${changed.map((f) => f.key).join(', ')}`),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
          ),
          result
            ? h('div', {
                style: {
                  marginTop: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.6,
                  borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  whiteSpace: 'pre-wrap',
                },
              }, `${t('configSaved')}: ${result.saved.join(', ')}\n${t('configRestart')}`)
            : null,
        ),

        h('div', { style: S.card },
          h('h3', { style: { margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('configReadonly')),
          [
            [t('labelEntry'), data.readonly.entryLabel],
            [t('labelUser'), data.readonly.userId],
            [t('labelPersonal'), data.readonly.personalIndex],
            [t('labelTeam'), data.readonly.teamIndex],
            [t('labelAuditIndex'), data.readonly.auditIndex],
            [t('labelReader'), data.readonly.reader],
            [t('labelWriter'), data.readonly.writer],
            [t('labelConsolidator'), `${data.readonly.consolidator}${data.readonly.consolidatorConfigured ? '' : '（密码未配置）'}`],
            [t('labelEmbedding'), data.readonly.embedding],
          ].map(([label, value]) =>
            h('div', { key: label, style: { display: 'flex', gap: 10, marginBottom: 4, fontSize: 12 } },
              h('span', { style: { width: 130, ...S.muted } }, label),
              h('span', { style: S.mono }, String(value ?? '-')),
            ),
          ),
        ),
      )
    }

    // ── 审核台 ───────────────────────────────────────────────────────────
    // ── 自述：候选采纳 + 个人审核记录（阶段 7.2/7.3）────────────────────
    /**
     * 阶段 9.4：人格页。
     *
     * 三个来源各管一层，别混：
     *  - `/persona`  内核（你写的）+ 学到的倾向（approve 过的）
     *  - `/stickers` 表情包清单，`exists=false` 标红——图片不在仓库里，缺文件很常见
     *  - `/diary`    条目级的状态变迁（生效/被拒），只回答「我怎么变成现在这样」
     */
    /**
     * 阶段 9.4 人格页（2026-10-31 重排版式）。
     *
     * 为什么这么排：四个区块平铺展开时，表情包一行一个、日记一天几条，
     * 跑几个月页面就变成一条望不到头的长卷。改成
     *   内核 / 学到的倾向 = 常驻（这是"我是谁"，要一眼看到）
     *   表情包 / 日记     = 折叠（这是"证据与足迹"，需要时再翻）
     * 标题行常驻，看一眼就知道有多少条，不用展开去数。
     */
    function Persona({ t }) {
      const [persona, setPersona] = React.useState({ loading: true, data: null, error: '' })
      const [stickers, setStickers] = React.useState(null)
      const [diary, setDiary] = React.useState({ loading: true, rows: [], journals: [], error: '' })
      const [diaryTab, setDiaryTab] = React.useState('journal')
      // 内核可编辑：draft 与 seed 分开，取消时不污染已保存的值
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveMsg, setSaveMsg] = React.useState('')
      // 折叠状态：默认只收起表情包与日记
      const [openKeys, setOpenKeys] = React.useState({ stickers: false, diary: false })
      const toggle = (key) => setOpenKeys((prev) => ({ ...prev, [key]: !prev[key] }))

      const load = React.useCallback(() => {
        setPersona((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/persona')
          .then((value) => setPersona({ loading: false, data: value, error: '' }))
          .catch((error) => setPersona({ loading: false, data: null, error: String(error.message ?? error) }))
        apiGet('/stickers')
          .then((value) => setStickers(value))
          .catch(() => setStickers(null))
        setDiary((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/diary', { size: '30' })
          .then((value) => setDiary({
            loading: false,
            rows: Array.isArray(value.rows) ? value.rows : [],
            journals: Array.isArray(value.journals) ? value.journals : [],
            error: '',
          }))
          .catch((error) => setDiary({ loading: false, rows: [], journals: [], error: String(error.message ?? error) }))
      }, [])

      React.useEffect(() => { load() }, [load])

      const saveSeed = () => {
        setSaving(true)
        setSaveMsg('')
        apiPost('/config', {
          confirm: true,
          changes: [{ key: 'persona.seed', value: draft, type: 'string' }],
        })
          .then(() => {
            setEditing(false)
            setSaveMsg(t('personaSaved'))
            load()
          })
          .catch((error) => setSaveMsg(`${t('error')}: ${String(error.message ?? error)}`))
          .finally(() => setSaving(false))
      }

      /** 卡片外壳。expandable=true 时标题行可点，正文按 openKeys 收起。 */
      const card = (title, hint, body, options = {}) => {
        const { expandable = false, open = true, count = null, extra = null } = options
        const expanded = expandable ? Boolean(open) : true
        const head = h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            ...(expandable ? { cursor: 'pointer', userSelect: 'none' } : {}),
          },
          ...(expandable ? { onClick: () => toggle(options.key) } : {}),
        },
          expandable
            ? h('span', {
                style: {
                  display: 'inline-block',
                  width: 10,
                  fontSize: 10,
                  color: 'var(--dsw-alias-label-secondary)',
                  transition: 'transform .12s',
                },
              }, expanded ? '▾' : '▸')
            : null,
          h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' }, children: title }),
          count !== null && count !== undefined
            ? h('span', { style: S.pill('plain') }, String(count))
            : null,
          hint
            ? h('span', {
                style: {
                  ...S.muted,
                  flex: 1,
                  minWidth: 0,
                  fontSize: 11.5,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  opacity: expandable && !expanded ? 1 : 0.9,
                },
                children: hint,
              })
            : h('span', { style: { flex: 1 } }),
          extra,
        )
        return h('div', { style: { ...S.card, marginBottom: 10 } },
          head,
          expanded ? h('div', { style: { marginTop: 8 } }, body) : null)
      }

      if (persona.loading) return h('div', { style: S.muted, children: '…' })

      const data = persona.data ?? {}
      const entries = Array.isArray(data.entries) ? data.entries : []
      const seed = typeof data.seed === 'string' ? data.seed : ''
      const seedLines = seed.trim() === '' ? 0 : seed.trim().split('\n').length
      const stickerRows = stickers && Array.isArray(stickers.items) ? stickers.items : []
      const diaryRows = diary.rows

      // ── 内核（可编辑）────────────────────────────────────────────────
      const kernelBody = editing
        ? h('div', null,
            h('textarea', {
              value: draft,
              rows: 12,
              onChange: (event) => setDraft(event.target.value),
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: 10,
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-l2)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: 'inherit',
                resize: 'vertical',
              },
            }),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { type: 'button', style: S.btn, disabled: saving, onClick: saveSeed },
                saving ? '…' : t('personaSave')),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => { setEditing(false); setSaveMsg('') },
              }, t('personaCancel')),
              h('span', { style: S.muted, children: `${draft.length} 字` })))
        : seed.trim() === ''
          ? h('div', { style: S.muted, children: t('personaKernelEmpty') })
          : h('pre', {
              style: {
                margin: 0,
                padding: 10,
                // 定高滚动：文本再长也不把页面顶下去
                maxHeight: 200,
                overflow: 'auto',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-l2)',
                fontSize: 12,
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
              },
              children: seed,
            })

      const kernelCard = card(
        t('personaKernel'),
        seed.trim() === '' ? t('personaKernelHint') : `${data.seedLength || seed.length} 字 · ${seedLines} 行 · ${data.enabled === false ? '已关闭' : '已启用'}`,
        h('div', null,
          saveMsg === ''
            ? null
            : h('div', { style: { ...S.muted, marginBottom: 6, fontSize: 12 }, children: saveMsg }),
          kernelBody),
        {
          extra: editing
            ? null
            : h('button', {
                type: 'button',
                style: { ...S.btn, flexShrink: 0 },
                onClick: () => { setDraft(seed); setSaveMsg(''); setEditing(true) },
              }, t('personaEdit')),
        },
      )

      // ── 学到的倾向（常驻，条数封顶 + 内部滚动）─────────────────────────
      const learnedCard = card(
        t('personaLearned'),
        entries.length === 0 ? t('personaLearnedHint') : (data.pendingCount > 0 ? `${data.pendingCount} ${t('personaPending')}` : ''),
        entries.length === 0
          ? h('div', { style: S.muted, children: t('personaLearnedEmpty') })
          : h('ul', {
              style: {
                margin: 0,
                paddingLeft: 18,
                lineHeight: 1.75,
                maxHeight: 220,
                overflow: 'auto',
              },
            }, entries.map((row) => h('li', { key: row.memoryId, children: row.content }))),
        { count: entries.length },
      )

      // ── 表情包（默认收起）────────────────────────────────────────────
      const missing = stickerRows.filter((item) => !item.exists).length
      const stickersCard = card(
        t('personaStickers'),
        stickers
          ? `${t('personaStickerDir')} ${stickers.dir} · ${t('personaStickerLimit')} ${stickers.maxPerTurn}${missing > 0 ? ` · ${missing} 个${t('personaStickerMissing')}` : ''}`
          : t('personaStickerNone'),
        !stickers
          ? h('div', { style: S.muted, children: t('personaStickerNone') })
          : stickerRows.length === 0
            ? h('div', { style: S.muted, children: stickers.error || t('personaStickerNone') })
            : h('div', { style: { maxHeight: 260, overflow: 'auto' } },
                h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                  h('thead', null, h('tr', null,
                    h('th', { style: S.th }, t('colLabel')),
                    h('th', { style: S.th }, t('colWhen')),
                    h('th', { style: S.th }, t('colFile')),
                    h('th', { style: S.th }, ''))),
                  h('tbody', null,
                    stickerRows.map((item) => h('tr', { key: item.id || item.file },
                      h('td', { style: S.td, children: item.label }),
                      h('td', { style: S.td, children: item.when }),
                      h('td', { style: { ...S.td, ...S.mono }, children: item.file }),
                      h('td', { style: S.td },
                        h('span', { style: S.pill(item.exists ? 'ok' : 'warn') },
                          item.exists ? '✓' : t('personaStickerMissing')))))))),
        { key: 'stickers', expandable: true, open: openKeys.stickers, count: stickerRows.length },
      )

      // ── 日记（默认收起）──────────────────────────────────────────────
      // 两栏：每日回顾（按天一段） / 变迁（审核足迹）。默认看回顾——「日记」本来就该记日子。
      const journalRows = diary.journals
      const segBtn = (key, label, count) =>
        h('button', {
          type: 'button',
          key,
          style: {
            ...S.btn,
            padding: '4px 10px',
            fontSize: 12,
            ...(diaryTab === key
              ? { background: 'var(--dsw-alias-bg-l2)', borderColor: 'var(--dsw-alias-border-l2)', fontWeight: 600 }
              : {}),
          },
          onClick: () => setDiaryTab(key),
        }, `${label} ${count}`)

      const journalView = journalRows.length === 0
        ? h('div', { style: S.muted, children: t('diaryJournalEmpty') })
        : h('div', { style: { maxHeight: 360, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 } },
            journalRows.map((row) => h('div', {
              key: row.memoryId || row.date,
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8,
                padding: '8px 10px',
              },
            },
              h('div', { style: { ...S.mono, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } },
                row.date),
              h('div', { style: { fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }, children: row.content }))))

      const eventsView = diaryRows.length === 0
        ? h('div', { style: S.muted, children: t('personaDiaryEmpty') })
        : h('div', { style: { maxHeight: 320, overflow: 'auto' } },
            h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
              h('thead', null, h('tr', null,
                h('th', { style: S.th }, t('colWhen')),
                h('th', { style: S.th }, t('colKind')),
                h('th', { style: S.th }, t('colState')),
                h('th', { style: S.th }, t('colContent')))),
              h('tbody', null,
                diaryRows.map((row) => h('tr', { key: row.memoryId },
                  h('td', { style: { ...S.td, ...S.mono }, children: (row.updatedAt || '').slice(0, 19).replace('T', ' ') }),
                  h('td', { style: S.td }, row.memoryType === 'persona' ? t('kindPersona') : t('kindIdentity')),
                  h('td', { style: S.td },
                    h('span', { style: S.pill(row.status === 'active' ? 'ok' : 'warn') },
                      row.status === 'active' ? t('stateActive') : t('stateArchived'))),
                  h('td', { style: S.td, children: row.content }))))))

      const diaryCard = card(
        t('personaDiary'),
        diaryTab === 'journal' ? t('diaryJournalHint') : t('personaDiaryHint'),
        diary.loading
          ? h('div', { style: S.muted, children: '…' })
          : h('div', null,
              h('div', { style: { display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
                segBtn('journal', t('diaryTabJournal'), journalRows.length),
                segBtn('events', t('diaryTabEvents'), diaryRows.length)),
              diaryTab === 'journal' ? journalView : eventsView),
        {
          key: 'diary',
          expandable: true,
          open: openKeys.diary,
          count: diaryTab === 'journal' ? journalRows.length : diaryRows.length,
        },
      )

      return h('div', null,
        persona.error ? h('div', { style: S.err, children: persona.error }) : null,
        kernelCard,
        learnedCard,
        stickersCard,
        diaryCard,
      )
    }

    function Identity({ t }) {
      const [pending, setPending] = React.useState({ loading: true, rows: [], error: '' })
      const [active, setActive] = React.useState([])
      const [versions, setVersions] = React.useState({ id: '', rows: [] })
      const [audit, setAudit] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      const [done, setDone] = React.useState('')

      const load = React.useCallback(() => {
        setPending((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/identity/pending', { size: '50' })
          .then((value) => setPending({ loading: false, rows: Array.isArray(value.rows) ? value.rows : [], error: '' }))
          .catch((error) => setPending({ loading: false, rows: [], error: String(error.message ?? error) }))
        apiGet('/identity/audit', { size: '10' })
          .then((value) => setAudit(Array.isArray(value.rows) ? value.rows : []))
          .catch(() => setAudit([]))
        apiGet('/identity/active', { size: '50' })
          .then((value) => setActive(Array.isArray(value.rows) ? value.rows : []))
          .catch(() => setActive([]))
      }, [])

      React.useEffect(() => { load() }, [load])

      const act = (memoryId, action) => {
        setBusy(memoryId)
        setDone('')
        apiPost('/identity/review', { memory_id: memoryId, action, note })
          .then((value) => {
            setDone(`${action === 'approve' ? t('idApproved') : t('idRejected')}${value.audit === 'failed' ? ' ⚠' : ''}`)
            setNote('')
            load()
          })
          .catch((error) => setDone(`${t('error')}: ${String(error.message ?? error)}`))
          .finally(() => setBusy(''))
      }

      const toggleAnchor = (row) => {
        setBusy(row.memoryId)
        setDone('')
        apiPost('/identity/review', { memory_id: row.memoryId, action: 'anchor', anchor: !row.anchor })
          .then(() => load())
          .catch((error) => setDone(`${t('error')}: ${String(error.message ?? error)}`))
          .finally(() => setBusy(''))
      }

      const showVersions = (memoryId) => {
        if (versions.id === memoryId) { setVersions({ id: '', rows: [] }); return }
        apiGet('/identity/versions', { memory_id: memoryId })
          .then((value) => setVersions({ id: memoryId, rows: Array.isArray(value.rows) ? value.rows : [] }))
          .catch((error) => setDone(`${t('error')}: ${String(error.message ?? error)}`))
      }

      return h('div', null,
        h('div', { style: S.card },
          h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('idTitle')),
          h('p', { style: { ...S.muted, marginTop: 6, fontSize: 12 } }, t('idHint')),
          done === '' ? null : h('p', { style: { ...S.muted, marginTop: 6, fontSize: 12 } }, done),
          pending.loading
            ? h('p', { style: S.muted }, t('loading'))
            : pending.error !== ''
              ? h('p', { style: S.err }, `${t('error')}: ${pending.error}`)
              : pending.rows.length === 0
                ? h('p', { style: S.muted }, t('idEmpty'))
                : h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 } },
                    pending.rows.map((row) =>
                      h('div', {
                        key: row.memoryId,
                        style: { border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,.22))', borderRadius: 10, padding: 10 },
                      },
                        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
                          h('span', { style: S.pill(row.memoryType === 'persona' ? 'ok' : 'plain') },
                            row.memoryType === 'persona' ? t('kindPersona') : t('kindIdentity'))),
                        h('div', { style: { fontSize: 13, lineHeight: 1.7 } }, row.content),
                        h('div', { style: { ...S.muted, fontSize: 12, marginTop: 4 } },
                          `${t('idEvidence')} ${row.evidenceCount ?? 0} 条 · ${String(row.createdAt ?? '').replace('T', ' ').slice(0, 16)}`),
                        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
                          h('input', {
                            type: 'text',
                            placeholder: t('idNote'),
                            value: note,
                            onChange: (event) => setNote(event.target.value),
                            style: { flex: '1 1 160px', minWidth: 120, padding: '4px 8px', borderRadius: 6,
                              border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,.3))',
                              background: 'transparent', color: 'inherit', fontSize: 12 },
                          }),
                          h('button', {
                            type: 'button',
                            style: S.btn,
                            disabled: busy === row.memoryId,
                            onClick: () => act(row.memoryId, 'approve'),
                          }, busy === row.memoryId ? t('idBusy') : t('idApprove')),
                          h('button', {
                            type: 'button',
                            style: S.btn,
                            disabled: busy === row.memoryId,
                            onClick: () => act(row.memoryId, 'reject'),
                          }, t('idReject')),
                        ),
                      ),
                    ),
                  ),
        ),
        h('div', { style: { ...S.card, marginTop: 12 } },
          h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('idActiveTitle')),
          h('p', { style: { ...S.muted, marginTop: 6, fontSize: 12 } }, t('idAnchorHint')),
          active.length === 0
            ? h('p', { style: { ...S.muted, marginTop: 6 } }, t('idActiveEmpty'))
            : h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 } },
                active.map((row) =>
                  h('div', {
                    key: row.memoryId,
                    style: { border: '1px solid var(--dsw-alias-border-1, rgba(127,127,127,.22))', borderRadius: 10, padding: 10 },
                  },
                    h('div', { style: { fontSize: 13, lineHeight: 1.7 } }, row.content),
                    h('div', { style: { ...S.muted, fontSize: 12, marginTop: 4 } },
                      `${String(row.updatedAt ?? '').replace('T', ' ').slice(0, 16)}${row.anchor ? ' · 锚点' : ''}`),
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                      h('button', {
                        type: 'button',
                        style: S.btn,
                        disabled: busy === row.memoryId,
                        onClick: () => toggleAnchor(row),
                      }, row.anchor ? t('idAnchorOn') : t('idAnchorOff')),
                      row.hasHistory
                        ? h('button', { type: 'button', style: S.btn, onClick: () => showVersions(row.memoryId) },
                            versions.id === row.memoryId ? t('idClose') : t('idHistory'))
                        : null,
                    ),
                    versions.id === row.memoryId
                      ? h('div', { style: { marginTop: 8 } },
                          versions.rows.length === 0
                            ? h('p', { style: { ...S.muted, fontSize: 12 } }, t('idHistoryEmpty'))
                            : versions.rows.map((v) =>
                                h('div', { key: v.memoryId, style: { fontSize: 12, lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary)' } },
                                  `· [${v.status}] ${v.offset === 0 ? '← 当前' : ''} ${String(v.createdAt ?? '').slice(0, 10)} ${String(v.content ?? '').slice(0, 60)}`),
                              ),
                        )
                      : null,
                  ),
                ),
              ),
        ),
        h('div', { style: { ...S.card, marginTop: 12 } },
          h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('idAudit')),
          audit.length === 0
            ? h('p', { style: { ...S.muted, marginTop: 6 } }, t('idAuditEmpty'))
            : h('div', { style: { marginTop: 8 } },
                audit.map((row, index) =>
                  h('div', { key: `${index}:${row.at ?? ''}`, style: { fontSize: 12, lineHeight: 1.9, color: 'var(--dsw-alias-label-secondary)' } },
                    `· ${String(row.at ?? '').replace('T', ' ').slice(0, 16)} ${row.event === 'identity_approved' ? '✓' : '✗'} ${String(row.memoryId ?? '')}${row.note ? `（${row.note}）` : ''}`),
                ),
              ),
        ),
      )
    }

    function Review({ t }) {
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      const [pending, setPending] = React.useState(null) // { docId, action }
      const [reason, setReason] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [done, setDone] = React.useState('')
      const [page, setPage] = React.useState(0)
      const size = 20

      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/review/pending', { size: String(size), page: String(page) })
          .then((data) => setState({ loading: false, error: '', data }))
          .catch((error) => setState({ loading: false, error: String(error.message ?? error), data: null }))
      }, [page])

      const totalPages = Math.max(1, Math.ceil((state.data?.total ?? 0) / size))

      React.useEffect(() => {
        load()
      }, [load])

      const submit = () => {
        if (!pending) return
        setBusy(true)
        apiPost(`/review/${encodeURIComponent(pending.docId)}/${pending.action}`, {
          reason: reason.trim(),
          confirm: true,
          actor: 'panel',
        })
          .then((value) => {
            // 审计写失败时后端返回 auditWritten:false —— 不能让界面只说"成功"
            setDone(
              value?.auditWritten === false
                ? `${pending.action} ${pending.docId.slice(0, 8)} ✓ ${t('reviewAuditFailed')}`
                : `${pending.action} ${pending.docId.slice(0, 8)} ✓`,
            )
            setPending(null)
            setReason('')
            load()
          })
          .catch((error) => setState((prev) => ({ ...prev, error: String(error.message ?? error) })))
          .finally(() => setBusy(false))
      }

      const data = state.data
      const rows = data?.rows ?? []
      const conflicts = new Map((data?.conflicts ?? []).map((item) => [item.id, item]))

      const actionBtn = (row, action, label) =>
        h('button', {
          type: 'button',
          style: { ...S.btn, ...(action === 'approve' ? { borderColor: 'var(--dsw-alias-state-success-primary)' } : {}) },
          onClick: () => {
            setPending({ docId: row.id, action })
            setReason('')
            setDone('')
          },
        }, label)

      return h('div', null,
        state.loading ? h('p', { style: S.muted }, t('loading')) : null,
        state.error
          ? h('div', null,
              h('p', { style: S.err }, `${t('error')}: ${state.error}`),
              h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
            )
          : null,
        done ? h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, `${t('reviewDone')}: ${done}`) : null,
        data && data.canWrite === false ? h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('reviewNoWrite')) : null,

        !state.loading && !state.error && rows.length === 0
          ? h('div', { style: S.card }, h('p', { style: S.muted }, t('reviewEmpty')))
          : null,

        (data?.total ?? 0) > size
          ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
              h('span', { style: { fontSize: 12, ...S.mono, ...S.muted } },
                `${t('reviewPage')} ${page + 1}/${totalPages} · ${t('total')} ${data?.total ?? 0}`),
              h('span', { style: { flex: 1 } }),
              h('button', {
                type: 'button',
                style: { ...S.btn, opacity: page > 0 ? 1 : 0.5 },
                disabled: page <= 0,
                onClick: () => setPage((value) => Math.max(0, value - 1)),
              }, t('prev')),
              h('button', {
                type: 'button',
                style: { ...S.btn, opacity: page + 1 < totalPages ? 1 : 0.5 },
                disabled: page + 1 >= totalPages,
                onClick: () => setPage((value) => Math.min(totalPages - 1, value + 1)),
              }, t('next')),
            )
          : null,

        rows.map((row) => {
          const conflict = row.conflictWith ? conflicts.get(row.conflictWith) : null
          return h('div', { key: row.id, style: { ...S.card, marginBottom: 12 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
              h('span', { style: S.pill('warn') }, stateLabel(row.reviewState || 'pending', t)),
              h('span', { style: { ...S.mono, ...S.muted } }, row.domain || '-'),
              h('span', { style: { ...S.mono, ...S.muted } }, row.topicKey || '-'),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { ...S.mono, ...S.muted } }, shortTime(row.updatedAt)),
            ),
            h('p', { style: { margin: '0 0 8px', fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' } }, row.content),
            row.sourceUser
              ? h('p', { style: { ...S.mono, ...S.muted, margin: '0 0 8px' } }, `${t('labelSource')}：${row.sourceUser} / ${row.sourceMemoryId || '-'}`)
              : null,

            conflict
              ? h('div', {
                  style: {
                    borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
                    padding: '6px 0 6px 10px',
                    marginBottom: 8,
                  },
                },
                  h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 4 } },
                    `${t('reviewConflict')}: ${conflict.id.slice(0, 8)}`),
                  h('div', { style: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' } },
                    conflict.content.length > 200 ? `${conflict.content.slice(0, 200)}…` : conflict.content),
                )
              : null,

            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              actionBtn(row, 'approve', t('reviewApprove')),
              actionBtn(row, 'reject', t('reviewReject')),
              actionBtn(row, 'withdraw', t('reviewWithdraw')),
            ),

            pending && pending.docId === row.id
              ? h('div', {
                  style: {
                    marginTop: 10,
                    padding: 10,
                    borderRadius: 8,
                    background: 'var(--dsw-alias-bg-layer-2)',
                    border: '1px solid var(--dsw-alias-border-l1)',
                  },
                },
                  h('div', { style: { fontSize: 12, marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' } },
                    `${t('reviewConfirm')}: ${pending.action}`),
                  pending.action === 'approve'
                    ? null
                    : h('textarea', {
                        style: { ...S.input, width: '100%', minHeight: 56, boxSizing: 'border-box', marginBottom: 8 },
                        placeholder: t('reviewReason'),
                        value: reason,
                        onChange: (event) => setReason(event.target.value),
                      }),
                  h('div', { style: { display: 'flex', gap: 8 } },
                    h('button', {
                      type: 'button',
                      style: { ...S.btn, opacity: busy ? 0.6 : 1 },
                      disabled: busy,
                      onClick: submit,
                    }, busy ? t('reviewBusy') : t('reviewConfirm')),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: busy,
                      onClick: () => {
                        setPending(null)
                        setReason('')
                      },
                    }, t('reviewCancel')),
                  ),
                )
              : null,
          )
        }),
      )
    }

    // ── 记忆浏览 ─────────────────────────────────────────────────────────
    function Browse({ t, caps }) {
      const [scope, setScope] = React.useState('both')
      const [query, setQuery] = React.useState('')
      const [status, setStatus] = React.useState('active')
      const [includePending, setIncludePending] = React.useState(true)
      const [domains, setDomains] = React.useState([])
      const [types, setTypes] = React.useState([])
      const [page, setPage] = React.useState(0)
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      const [selected, setSelected] = React.useState(null)
      // 删除：物理删除不可恢复，所以要点一下按钮 → 在下方展开确认区 → 再确认
      // （个人删不需要原因；团队删必须填，后端也会写 memory_audit）
      const [deleting, setDeleting] = React.useState(null)
      const [delReason, setDelReason] = React.useState('')
      const [delBusy, setDelBusy] = React.useState(false)
      const [delResult, setDelResult] = React.useState(null)
      // 管理员可以切换"看谁的个人库"（'' = 自己）；普通账号不渲染这个下拉
      const [targetUser, setTargetUser] = React.useState('')
      const [users, setUsers] = React.useState([])
      const size = 20

      // 过滤器候选值来自 /facets（后端聚合，前端不猜有哪些 domain）
      React.useEffect(() => {
        apiGet('/facets')
          .then((value) => setFacets({ domains: value.domains ?? [], types: value.types ?? [] }))
          .catch(() => setFacets({ domains: [], types: [] }))
      }, [])
      const [facets, setFacets] = React.useState({ domains: [], types: [] })

      // 管理员：拉一次"有记忆的用户"列表，供切换查看（普通账号不发这个请求）
      React.useEffect(() => {
        if (!caps?.canAdmin) return
        apiGet('/users')
          .then((value) => setUsers(value.users ?? []))
          .catch(() => setUsers([]))
      }, [caps?.canAdmin])

      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        const params = { scope, page: String(page), size: String(size), status }
        if (query.trim() !== '') params.q = query.trim()
        if (includePending) params.includePending = '1'
        if (domains.length > 0) params.domain = domains.join(',')
        if (types.length > 0) params.type = types.join(',')
        // 只有管理员切到别人时才有值；后端对非管理员忽略这个参数
        if (targetUser !== '') params.user = targetUser
        apiGet('/memories', params)
          .then((data) => setState({ loading: false, error: '', data }))
          .catch((error) => setState({ loading: false, error: String(error.message ?? error), data: null }))
      }, [scope, page, status, query, includePending, domains, types, targetUser])

      React.useEffect(() => {
        load()
      }, [load])

      const toggle = (list, setList, value) => {
        setPage(0)
        setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
      }

      const filterRow = (label, items, selectedList, setList, format = (k) => k) =>
        items.length === 0
          ? null
          : h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
              h('span', { style: { fontSize: 12, ...S.muted, width: 40 } }, label),
              items.slice(0, 12).map((item) =>
                h('button', {
                  key: item.key,
                  type: 'button',
                  style: {
                    ...S.pill(selectedList.includes(item.key) ? 'ok' : 'idle'),
                    cursor: 'pointer',
                    border: 'none',
                  },
                  onClick: () => toggle(selectedList, setList, item.key),
                }, `${format(item.key)} ${item.count}`),
              ),
            )

      // 删除请求：团队必须带原因（后端也会校验并写 memory_audit）
      const doDelete = () => {
        if (!deleting || delBusy) return
        const target = deleting
        const reason = delReason.trim()
        if (target.scope === 'team' && reason === '') {
          setDelResult({ ok: false, error: t('delReasonRequired') })
          return
        }
        setDelBusy(true)
        apiPost('/memories/delete', { esId: target.esId, scope: target.scope, confirm: true, reason })
          .then((value) => {
            // 团队删除写了审计；个人写不了（账号没该索引写权限），界面据实显示
            setDelResult({ ok: true, text: value?.auditWritten ? t('delDoneAudited') : t('delDone') })
            if (selected && selected.esId === target.esId) setSelected(null)
            load()
            window.setTimeout(() => {
              setDeleting(null)
              setDelResult(null)
            }, 1200)
          })
          .catch((error) => setDelResult({ ok: false, error: String(error.message ?? error) }))
          .finally(() => setDelBusy(false))
      }

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
          // 管理员专用：切换"看谁的个人记忆"。普通账号不渲染，后端也不会返回别人的数据。
          caps?.canAdmin
            ? h('select', {
                style: S.select,
                value: targetUser,
                title: t('userFilterHint'),
                onChange: (event) => {
                  const next = event.target.value
                  setTargetUser(next)
                  // 看别人的时候只可能是个人库，顺手锁到 personal
                  if (next !== '') setScope('personal')
                  setPage(0)
                },
              },
                h('option', { value: '' }, `${t('userSelf')} · ${caps.userId || ''}`.trim()),
                users
                  .filter((entry) => entry.userId !== caps.userId)
                  .map((entry) => h('option', { key: entry.userId, value: entry.userId }, `${entry.userId} · ${entry.count}`)),
              )
            : null,
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
        filterRow(t('filterDomain'), facets.domains, domains, setDomains, (k) => domainLabel(k, t)),
        filterRow(t('filterType'), facets.types, types, setTypes, (k) => typeLabel(k, t)),

        state.loading ? h('p', { style: S.muted }, t('loading')) : null,
        state.error
          ? h('div', null,
              h('p', { style: S.err }, `${t('error')}: ${state.error}`),
              h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
            )
          : null,

        // 看别人的个人库时明确标出来，免得把别人的记忆当成自己的
        data?.viewingOther
          ? h('p', { style: { margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
              `${t('viewingOther')}：${data.userId} · ${t('readOnlyOther')}`)
          : null,

        state.loading || state.error
          ? null
          : h('div', { style: { ...S.card, padding: 0, overflow: 'hidden' } },
              rows.length === 0
                ? h('p', { style: { ...S.muted, padding: '12px 14px' } }, t('empty'))
                : rows.map((row) =>
                    h('div', { key: `${row.scope}:${row.id}`, style: S.row },
                      h('div', { style: S.rowMain },
                        h('span', { style: S.pill('') }, row.scope === 'team' ? t('scopeTeam') : t('scopePersonal')),
                        // 单行省略：全文放 title，悬停可看；不再靠换行撑高行
                        h('span', { style: S.rowTitle, title: row.content }, row.content),
                        h('span', { style: S.pill(row.reviewState === 'pending' ? 'warn' : 'ok') },
                          row.reviewState
                            ? `${stateLabel(row.status, t)}/${stateLabel(row.reviewState, t)}`
                            : stateLabel(row.status, t)),
                        h('span', { style: S.rowTime }, shortTime(row.updatedAt)),
                      ),
                      h('div', { style: S.rowMeta },
                        h('span', null,
                          [domainLabel(row.domain, t), typeLabel(row.memoryType, t), row.topicKey]
                            .filter(Boolean)
                            .join(' · ')),
                        h('span', { style: { flex: 1 } }),
                        h('button', { type: 'button', style: S.btn, onClick: () => setSelected(row) }, t('detail')),
                        // 个人记忆的删除按钮一律显示（本人的库本人能删）；
                        // 团队记忆要真持有 team_knowledge 的 delete 才出现——由后端问 ES 得出
                        // 看别人的个人记忆时不给删除（mem_admin 只有读+index，没有别人库的 delete）
                        (row.scope === 'personal' && !data?.viewingOther) || caps?.canDeleteTeam === true
                          ? h('button', {
                              type: 'button',
                              style: { ...S.btn, color: 'var(--dsw-alias-state-danger-primary, #d33)' },
                              onClick: () => {
                                setDelResult(null)
                                setDelReason('')
                                setDeleting(row)
                              },
                            }, t('delBtn'))
                          : null,
                      ),
                    ),
                  ),

              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 12, ...S.muted } },
                  [
                    `${t('total')} ${total} ${t('rows')} · ${t('scopePersonal')} ${data?.totals?.personal ?? 0} / ${t('scopeTeam')} ${data?.totals?.team ?? 0}`,
                    data?.truncated ? `· ${t('browseTruncated')}` : '',
                  ].join(' ')),
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

        deleting
          ? h('div', {
              style: {
                ...S.card,
                marginTop: 12,
                borderLeft: '3px solid var(--dsw-alias-state-danger-primary, #d33)',
              },
            },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                h('strong', { style: { fontSize: 13, color: 'var(--dsw-alias-state-danger-primary, #d33)' } }, t('delTitle')),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    setDeleting(null)
                    setDelResult(null)
                  },
                }, t('close')),
              ),
              h('p', { style: { margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' } },
                deleting.content.length > 120 ? `${deleting.content.slice(0, 120)}…` : deleting.content),
              h('p', { style: { margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-state-danger-primary, #d33)' } },
                `${t('delIrreversible')} · ${deleting.scope === 'team' ? t('scopeTeam') : t('scopePersonal')}`),
              deleting.scope === 'team'
                ? h('input', {
                    style: { ...S.input, marginBottom: 8 },
                    placeholder: t('delReasonPlaceholder'),
                    value: delReason,
                    onChange: (event) => setDelReason(event.target.value),
                  })
                : null,
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  style: { ...S.btn, opacity: delBusy ? 0.6 : 1 },
                  disabled: delBusy,
                  onClick: doDelete,
                }, delBusy ? t('delBusy') : t('delConfirm')),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    setDeleting(null)
                    setDelResult(null)
                  },
                }, t('delCancel')),
                delResult
                  ? h('span', {
                      style: {
                        fontSize: 12,
                        color: delResult.ok
                          ? 'var(--dsw-alias-state-success-primary, #2a7a2a)'
                          : 'var(--dsw-alias-state-danger-primary, #d33)',
                      },
                    }, delResult.ok ? delResult.text : `${t('error')}: ${delResult.error}`)
                  : null,
              ),
            )
          : null,

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
                  [t('colDomain'), domainLabel(selected.domain, t)],
                  [t('colType'), typeLabel(selected.memoryType, t)],
                  [
                    t('colStatus'),
                    selected.reviewState
                      ? `${stateLabel(selected.status, t)}/${stateLabel(selected.reviewState, t)}`
                      : stateLabel(selected.status, t),
                  ],
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
                h(CopyButton, { text: selected.content, t, label: t('copyContent') }),
                h(CopyButton, { text: selected.id, t, label: t('copyId') }),
              ),
            )
          : null,
      )
    }

    // ── 页面主体 ─────────────────────────────────────────────────────────
    let activeLocale = ''
    function ctxLocaleActive() {
      return activeLocale
    }

    function MemoryPanel({ t }) {
      const [tab, setTab] = React.useState('overview')
      // 权限：没有整理身份的部署（普通账号）不显示审核台，避免"能点但点了报错"
      const [caps, setCaps] = React.useState({ loaded: false, canReview: false, canMaintain: false, role: 'reader', canDeletePersonal: false, canDeleteTeam: false, canAdmin: false, userId: '' })

      React.useEffect(() => {
        apiGet('/capabilities')
          .then((value) => setCaps({
            loaded: true,
            canReview: Boolean(value.canReview),
            canMaintain: Boolean(value.canMaintain),
            role: value.role ?? '',
            // 管理员 = 维护页 + 跨用户查看；userId 用于"用户"下拉里标出"我"
            canAdmin: Boolean(value.canAdmin),
            userId: value.userId ?? '',
            // 删除权限由后端问 ES 的 _has_privileges 得出，不是看配置声明
            canDeletePersonal: Boolean(value.canDeletePersonal),
            canDeleteTeam: Boolean(value.canDeleteTeam),
          }))
          .catch(() => setCaps({ loaded: true, canReview: false, canMaintain: false, role: 'reader', canDeletePersonal: false, canDeleteTeam: false }))
      }, [])
      const [overview, setOverview] = React.useState({ loading: true, error: '', data: null })

      const [mood, setMood] = React.useState(null)

      const loadOverview = React.useCallback(() => {
        setOverview((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/overview')
          .then((data) => setOverview({ loading: false, error: '', data }))
          .catch((error) => setOverview({ loading: false, error: String(error.message ?? error), data: null }))
        // 心情单独拉：它失败不该让整页报错（老库没有这个文档是正常的）
        apiGet('/mood')
          .then((value) => setMood(value))
          .catch(() => setMood(null))
      }, [])

      const firstLoad = React.useRef(true)
      React.useEffect(() => {
        // 首次挂载无论哪个 tab 都拉一次（页脚要显示服务端版本）；之后切回概览时刷新。
        if (firstLoad.current || tab === 'overview') loadOverview()
        firstLoad.current = false
      }, [tab, loadOverview])

      return h('div', { style: S.wrap },
        h('h2', { style: S.h2 }, t('title')),
        h('p', { style: S.sub },
          `${t('subtitle')} · ${t('versionLabel')} ${overview.data?.version ?? '—'} · 语言 ${(() => {
            try {
              return ctxLocaleActive() || '未知'
            } catch {
              return '未知'
            }
          })()}`),
        h('div', { style: S.tabs },
          [
            ['overview', t('tabOverview')],
            ['browse', t('tabBrowse')],
            // 自述 = 个人库的候选采纳，只需要单账号（不依赖 teamWrite），所以总是显示
            ['identity', t('tabIdentity')],
            ['persona', t('tabPersona')],
            // 审核台 = 写团队库的权限；没有就不显示（后端也会 403）
            ...(caps.canReview ? [['review', t('tabReview')]] : []),
            // 维护 = 整理任务 / 导出镜像，只有管理员可见（后端三个接口也会 403）
            ...(caps.canReview ? [['maint', t('tabMaint')]] : []),
            ['config', t('tabConfig')],
          ].map(([value, label]) =>
            h('button', {
              key: value,
              type: 'button',
              style: S.tab(tab === value),
              onClick: () => setTab(value),
            }, label),
          ),
        ),
        tab === 'maint'
          ? h(Maintenance, { t, canReview: caps.canReview, caps })
          : tab === 'config'
          ? h(Config, { t })
          : tab === 'review'
          ? h(Review, { t })
          : tab === 'identity'
          ? h(Identity, { t })
          : tab === 'persona'
          ? h(Persona, { t })
          : tab === 'overview'
          ? h(Overview, {
              data: overview.data,
              mood,
              loading: overview.loading,
              error: overview.error,
              t,
              onRetry: loadOverview,
              onOpenBrowse: () => setTab('browse'),
            })
          : h(Browse, { t, caps }),
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
        try {
          activeLocale = ctx.locale.getLocale?.()?.active ?? ''
        } catch {
          activeLocale = ''
        }

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
