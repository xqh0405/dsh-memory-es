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
  id: 'dsh-memory-es',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-memory-es'
    const API = '/memory-es/api'

    const ZH = {
      sectionLabel: '记忆库',
      title: '记忆库',
      subtitle: 'Elasticsearch 后端记忆（dsh-memory-es）：概览与浏览。',
      backToConversation: '返回会话',
      versionLabel: '版本',
      tabOverview: '概览',
      tabBrowse: '记忆浏览',
      tabGraph: '星图',
      graphNodes: '节点',
      graphEdges: '边',
      graphClusters: '簇',
      graphOrphans: '孤点',
      graphUnresolved: '端点缺失',
      graphZoomHint: '滚轮缩放 · 拖动平移',
      graphReset: '复位',
      graphOrbit: '自转',
      graphOrbitHint: '开/关镜头自转；只在页签可见时转，切走就停',
      graphFocus: '聚焦',
      graphBack: '返回全图',
      graphGlobalHint: '点击节点看两跳',
      graphFocusHint: '点击空白返回全图',
      graphDegree: '度数',
      graphExport: '导出 .canvas',
      graphExportHint: '导出当前视图为 JSON Canvas，可在 Obsidian 等 canvas 工具里打开',
      hitIn: '命中',
      fieldContent: '正文',
      fieldTopic: '主题',
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
      stickerAdd: '添加',
      stickerAddFile: '图片',
      stickerAddFileHint: 'PNG / JPEG / WebP / GIF，单张不超过 5 MiB',
      stickerAddPick: '选择文件',
      stickerAddNoFile: '还没选图片',
      stickerAddLabel: '名称',
      stickerAddLabelPlaceholder: '例：委屈巴巴',
      stickerAddWhen: '什么时候用',
      stickerAddWhenPlaceholder: '例：被否了方案、想撒娇但又不太服气',
      stickerAddWhenHint: '必填。模型就是靠这一句决定贴不贴这张，写清楚使用场景',
      stickerAddNote: '外观描述',
      stickerAddNotePlaceholder: '可选。画面长什么样，帮模型认图',
      stickerAddSave: '保存',
      stickerAddCancel: '取消',
      stickerAddErrFile: '先选一张图片',
      stickerAddErrLabel: '名称不能为空',
      stickerAddErrWhen: '「什么时候用」不能为空',
      stickerAddDone: '已添加，下一轮就能用',
      stickerAddHint: '加进来的图立刻生效，不用重启 dsh',
      personaDiary: '日记',
      diaryTabJournal: '每日回顾',
      diaryTabEvents: '变迁',
      diaryJournalEmpty: '还没有回顾。默认每天 23:30 之后把当天对话压成一段；也可以在对话里让助手跑 memory_journal 补某一天。',
      diaryJournalHint: '按天一段，直接生效、不进审核',
      personaDiaryHint: '这里只记「我怎么变成现在这样」：人格与自述条目何时被采纳、何时被拒绝',
      personaDiaryEmpty: '还没有记录。',
      // 日记「变迁」那列才是时间；表情包那列是「什么时候贴」，共用一个键会让列名说谎
      colWhen: '时间',
      colStickerWhen: '什么时候用',
      colKind: '类型',
      colState: '状态',
      colContent: '内容',
      colLabel: '名称',
      colFile: '文件',
      colPreview: '预览',
      kindPersona: '人格',
      kindIdentity: '自述',
      stateActive: '生效中',
      stateArchived: '已拒绝',
      tabSearchLog: '检索',
      slDays: '统计范围',
      slDays7: '近 7 天',
      slDays30: '近 30 天',
      slDays90: '近 90 天',
      slTotal: '检索次数',
      slClusters: '问题簇',
      slMiss: '一次没答上',
      slLowCount: '低置信/漏答',
      slMissingTitle: '缺口清单（问过、但一次都没命中）',
      slTopTitle: '被用得最多的记忆',
      colMemory: '记忆',
      slLowTitle: '低置信与漏答',
      slRecentTitle: '最近检索',
      slEmpty: '这段时间没有检索记录',
      slLegacyHint: '覆盖率只统计补字段之后的检索；更早的记录没有归一化键，不进簇统计。',
      slUsedIn: '被哪些检索命中过',
      fbUseful: '👍 有用',
      fbWrong: '👎 不对',
      fbDone: '已记录',
      fbCounts: '反馈：👍 {up} / 👎 {down}',
      fbEmpty: '还没有反馈',
      slUsedInEmpty: '还没有检索命中过这条',
      slStatusMiss: '没答上',
      slStatusMixed: '有漏答',
      slStatusLow: '低置信',
      slStatusHit: '有命中',
      colCount: '次数',
      colLast: '最近',
      colQuery: '问题',
      colHitsN: '命中',
      colMs: '耗时',
      colNote: '结论',
      noData: '—',
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
      cardAuditNA: '需配置整理身份',
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
      statusQuarantine: '已隔离',
      includePending: '含待裁决',
      colContent: '内容',
      colScope: '库',
      colDomain: '领域',
      colType: '类型',
      colStatus: '状态',
      colOrigin: '来源',
      quarantineReason: '隔离原因',
      quarantineNoReason: '（早期条目没有记录原因）',
      restoreBtn: '恢复为有效',
      restoreDone: '已恢复为有效',
      restoreDoneNoVector: '已恢复为有效（这条没有向量，此后只能关键词检索）',
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
      stQuarantine: '已隔离',
      stMood: '心情',
      maintCliMissing: '面板未随带 CLI 源码，整理与导出不可用（部署时缺 panel/cli）',
      configTitle: '配置',
      configSave: '保存',
      configSaved: '已保存到 profile 配置',
      configRestart: '⚠️ 需要重启 dsh 才生效（ES 客户端在插件加载时建立）。容器里执行：docker restart <容器名>',
      configReadonly: '只读信息（密码不显示）',
      configNoChange: '没有改动',
      configDefault: '默认值',
      configChanged: '有未保存改动',
      indexNames: '索引',
      backendTitle: '记忆后端',
      backendUrl: '地址',
      backendScope: '全局',
      storageTitle: '存储域',
      embedding: '嵌入',
      auditNote: '审计索引不在插件配置里，且只读身份没有它的读权限，P3 再补。',
    }
    const EN = {
      sectionLabel: 'Memory',
      title: 'Memory',
      subtitle: 'Elasticsearch-backed memory (dsh-memory-es): overview and browse.',
      backToConversation: 'Back to chat',
      versionLabel: 'Version',
      tabOverview: 'Overview',
      tabBrowse: 'Browse',
      tabGraph: 'Constellation',
      graphNodes: 'nodes',
      graphEdges: 'edges',
      graphClusters: 'clusters',
      graphOrphans: 'orphans',
      graphUnresolved: 'unresolved',
      graphZoomHint: 'wheel to zoom · drag to pan',
      graphReset: 'Reset',
      graphOrbit: 'Orbit',
      graphOrbitHint: 'Toggle the slow camera orbit; it stops while the tab is hidden',
      graphFocus: 'Focus',
      graphBack: 'Back to full graph',
      graphGlobalHint: 'click a node to see two hops',
      graphFocusHint: 'click empty space to go back',
      graphDegree: 'degree',
      graphExport: 'Export .canvas',
      graphExportHint: 'Export the current view as JSON Canvas (opens in Obsidian and other canvas tools)',
      hitIn: 'hit in',
      fieldContent: 'content',
      fieldTopic: 'topic',
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
      stickerAdd: 'Add',
      stickerAddFile: 'Image',
      stickerAddFileHint: 'PNG / JPEG / WebP / GIF, up to 5 MiB each',
      stickerAddPick: 'Choose file',
      stickerAddNoFile: 'No image chosen',
      stickerAddLabel: 'Label',
      stickerAddLabelPlaceholder: 'e.g. Pouty',
      stickerAddWhen: 'When to use',
      stickerAddWhenPlaceholder: 'e.g. idea rejected, wants to sulk but not quite give up',
      stickerAddWhenHint: 'Required. This line is how the model decides which sticker to attach.',
      stickerAddNote: 'Appearance',
      stickerAddNotePlaceholder: 'Optional. What the picture looks like.',
      stickerAddSave: 'Save',
      stickerAddCancel: 'Cancel',
      stickerAddErrFile: 'Choose an image first',
      stickerAddErrLabel: 'Label cannot be empty',
      stickerAddErrWhen: '"When to use" cannot be empty',
      stickerAddDone: 'Added; available from the next turn',
      stickerAddHint: 'New stickers take effect immediately, no dsh restart',
      personaDiary: 'Diary',
      diaryTabJournal: 'Daily',
      diaryTabEvents: 'Changes',
      diaryJournalEmpty: 'No daily recaps yet. They are written automatically after the configured time; run memory_journal to backfill a day.',
      diaryJournalHint: 'One entry per day; takes effect without review',
      personaDiaryHint: 'Only records how I became this: when persona/identity entries were approved or rejected',
      personaDiaryEmpty: 'No records yet.',
      colWhen: 'Time',
      colStickerWhen: 'When to use',
      colKind: 'Kind',
      colState: 'State',
      colContent: 'Content',
      colLabel: 'Label',
      colFile: 'File',
      colPreview: 'Preview',
      kindPersona: 'Persona',
      kindIdentity: 'Identity',
      stateActive: 'active',
      stateArchived: 'rejected',
      tabSearchLog: 'Search log',
      slDays: 'Range',
      slDays7: 'Last 7 days',
      slDays30: 'Last 30 days',
      slDays90: 'Last 90 days',
      slTotal: 'Searches',
      slClusters: 'Question clusters',
      slMiss: 'Never answered',
      slLowCount: 'Low confidence / missed',
      slMissingTitle: 'Gaps (asked, never matched)',
      slTopTitle: 'Most-used memories',
      colMemory: 'Memory',
      slLowTitle: 'Low confidence and misses',
      slRecentTitle: 'Recent searches',
      slEmpty: 'No searches in this range',
      slLegacyHint: 'Coverage counts only searches recorded after the field upgrade; older rows have no cluster key.',
      slUsedIn: 'Matched by which searches',
      fbUseful: '👍 Useful',
      fbWrong: '👎 Wrong',
      fbDone: 'Recorded',
      fbCounts: 'Feedback: 👍 {up} / 👎 {down}',
      fbEmpty: 'No feedback yet',
      slUsedInEmpty: 'No search has matched this memory yet',
      slStatusMiss: 'never',
      slStatusMixed: 'missed some',
      slStatusLow: 'low conf',
      slStatusHit: 'matched',
      colCount: 'count',
      colLast: 'last',
      colQuery: 'question',
      colHitsN: 'hits',
      colMs: 'ms',
      colNote: 'note',
      noData: '—',
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
      cardAuditNA: 'needs consolidator identity',
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
      statusQuarantine: 'Quarantined',
      includePending: 'Include pending',
      colContent: 'Content',
      colScope: 'Index',
      colDomain: 'Domain',
      colType: 'Type',
      colStatus: 'Status',
      colOrigin: 'Origin',
      quarantineReason: 'Quarantine reason',
      quarantineNoReason: '(no reason recorded)',
      restoreBtn: 'Restore',
      restoreDone: 'Restored',
      restoreDoneNoVector: 'Restored (no vector; keyword search only)',
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
      stQuarantine: 'quarantined',
      stMood: 'mood',
      maintCliMissing: 'CLI sources were not shipped with the panel',
      configTitle: 'Configuration',
      configSave: 'Save',
      configSaved: 'Saved to the profile configuration',
      configRestart: '⚠️ Restart dsh for it to take effect (the ES client is built when the plugin loads). In a container: docker restart <container>',
      configReadonly: 'Read-only info (passwords hidden)',
      configNoChange: 'No changes',
      configDefault: 'default',
      configChanged: 'Unsaved changes',
      indexNames: 'Indexes',
      backendTitle: 'Memory backend',
      backendUrl: 'Endpoint',
      backendScope: 'Global',
      storageTitle: 'Storage',
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
      wrapMain: { padding: 0 },
      // 主区全局面板的骨架：照 DSH 官方页面（插件管理 / 计划任务）的尺寸。
      //
      // 注意这里**不写 background**：底色由注入的 WORKSPACE_CSS 按主题给实色。
      // 原因见 WORKSPACE_CSS 上方的注释（皮肤会把这个 token 改成透明或 initial）。
      workspace: {
        width: '100%', minWidth: 0, height: '100%', minHeight: 0,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 14, lineHeight: 1.6,
      },
      // 顶部工具条：← 返回会话 | 记忆库 | ……… | ES 状态 · 版本
      // 照 dsh-mnemon 的「记忆系统」页：返回在左、标题紧随，状态靠右，一条 44px 的带子。
      topbar: {
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap',
        height: 44, flex: 'none', minWidth: 0,
        padding: '0 clamp(20px, 2.5vw, 32px)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      backLink: {
        appearance: 'none', background: 'transparent', border: 'none', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
        padding: '4px 6px 4px 0', marginLeft: -4,
        color: 'var(--dsw-alias-label-secondary)', fontSize: 13,
      },
      backChevron: { fontSize: 17, lineHeight: 1, marginTop: -1 },
      topbarDivider: { width: 1, height: 16, background: 'var(--dsw-alias-border-l2)', flex: 'none' },
      topbarTitle: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '44px', whiteSpace: 'nowrap' },
      topbarSpacer: { flex: 1, minWidth: 0 },
      topbarMeta: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      workspaceScroll: { scrollbarGutter: 'stable', flex: 1, minHeight: 0, overflow: 'auto' },
      // 铺满：主区现在是"外面的空间"，960 居中会显得像设置页。
      // 与 mnemon 一致——全宽、左右 20~32px，宽屏靠 maxWidth 兜住阅读行长。
      workspaceContent: {
        maxWidth: 1280, margin: '0 auto',
        padding: '18px clamp(20px, 2.5vw, 32px) 48px',
      },
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
      // 概览的状态卡：一行五列（个人/团队/文档/待裁决/审计），照「记忆系统」页那排状态卡。
      // 不用 auto-fit：五张要等宽对齐，窗口窄了整体收缩比折行好看。
      statGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        gap: 10,
        marginBottom: 12,
      },
      statCard: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        minWidth: 0,
      },
      statHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 },
      statValue: { fontSize: 22, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.2 },
      statLabel: {
        fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      statHint: {
        fontSize: 11, color: 'var(--dsw-alias-label-secondary)', opacity: 0.85, marginTop: 3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      // 卡片左上角那颗小圆点：健康=绿、需要注意=橙。与「记忆系统」页的状态灯同一个记号。
      dot: (tone) => ({
        width: 6, height: 6, borderRadius: 999, flex: 'none',
        // idle = 这一格拿不到数据（例如没有整理身份时的审计计数）：
        // 用灰点而不是绿点，绿点会被读成「一切正常」，那是在替不存在的检查背书。
        background:
          tone === 'warn' ? '#c98a3f' : tone === 'idle' ? 'var(--dsw-alias-border-l3, rgba(127,127,127,.4))' : '#4c9a6a',
      }),
      // 卡片区块头：左标题 + 右动作（对应 mnemon 每张卡右上角的计数/链接）
      sectionHead: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 10, marginBottom: 10, flexWrap: 'wrap',
      },
      sectionTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      // 概览第二排：左边「记忆后端」占主位，右边心情小卡（用户 2026-11-01 定：
      // 心情原来独占一行太占地方，收成右栏小卡）
      splitRow: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12, alignItems: 'stretch' },
      splitMain: { flex: '1 1 420px', minWidth: 0, display: 'flex' },
      splitSide: { flex: '0 1 300px', minWidth: 240, display: 'flex' },
      // 存储域：三个索引并列
      storeGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 10,
      },
      storeCell: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '10px 12px',
        minWidth: 0,
      },
      storeHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minWidth: 0 },
      storeName: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 },
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
      // 表情包缩略图：正方形、不裁切（表情包常有透明边与不规则构图，contain 比 cover 更忠实）
      stickerThumb: {
        width: 48,
        height: 48,
        objectFit: 'contain',
        borderRadius: 8,
        display: 'block',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
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
      quarantine: 'stQuarantine',
      mood: 'stMood',
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

    /**
     * 状态卡：绿点 + 小标题在上，大数值在中，副说明在下。
     * `tone='warn'` 用来让「待裁决」在非零时亮橙——不是错误，只是提醒该去看一眼。
     */
    function StatCard({ label, value, hint, tone }) {
      return h('div', { style: S.statCard },
        h('div', { style: S.statHead },
          h('span', { style: S.dot(tone) }),
          h('span', { style: S.statLabel }, label),
        ),
        h('div', { style: S.statValue }, value),
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

    /**
     * 心情小卡：放在概览右栏。
     *
     * 原来它独占一整行，内容只有个位数事件，右边大片空白——用户 2026-11-01 定：
     * 收成小卡并到「状态」区右侧，概览的横向空间让给「记忆后端」和「存储域」。
     */
    function MoodCard({ mood, t }) {
      const exists = Boolean(mood && mood.exists)
      const valence = exists ? Number(mood.valence) || 0 : 0
      const events = exists && Array.isArray(mood.events) ? mood.events : []
      // -1..1 映射成 0..100% 的填充：左负右正，视觉上"往哪边偏"一眼能看出
      const pct = Math.round(((valence + 1) / 2) * 100)
      const strong = Math.abs(valence) >= 0.12
      const tone = !exists ? t('moodNeutral') : strong ? moodLabelOf(valence, t) : t('moodCalm')
      return h('div', { style: { ...S.card, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
        h('div', { style: S.sectionHead },
          h('span', { style: S.sectionTitle }, t('moodTitle')),
          h('span', { style: { ...S.mono, ...S.muted } },
            exists ? `${valence >= 0 ? '+' : ''}${valence.toFixed(2)}` : '—'),
        ),
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, tone),
        h('div', {
          style: { height: 5, borderRadius: 999, background: 'var(--dsw-alias-fill-2, rgba(127,127,127,.18))', overflow: 'hidden' },
        }, h('div', {
          style: {
            width: `${exists ? pct : 50}%`,
            height: '100%',
            borderRadius: 999,
            background: !exists ? 'var(--dsw-alias-border-l3)' : valence >= 0 ? '#4c9a6a' : '#b8623f',
          },
        })),
        events.length === 0
          ? h('p', { style: { ...S.muted, marginTop: 10, fontSize: 11.5, lineHeight: 1.7 } },
              exists ? t('moodNote') : `${mood && mood.note ? String(mood.note).slice(0, 120) : t('moodNeutral')}`)
          : h('div', { style: { marginTop: 10, minWidth: 0 } },
              h('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 3 } }, `${t('moodEvents')}（${events.length}）`),
              events.slice(0, 3).map((event, index) =>
                h('div', { key: `${index}:${event.at ?? ''}`, style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `· ${String(event.kind ?? '?')}${event.note ? `（${event.note}）` : ''} · ${String(event.at ?? '').replace('T', ' ').slice(5, 16)}`),
              ),
            ),
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
      const chunkHint =
        counts.docChunks === undefined || counts.docChunks === null || counts.docChunks <= 0
          ? ''
          : `${counts.docChunks} ${t('cardDocChunks')}`
      // 存储域三列：个人库 / 团队库 / 文档库。名字都从 overview 的 config.indexes 来，
      // 不在这里拼——索引名跟着 identity.userId 走，拼错就是"看着像"而不是"真的"。
      const storeCells = [
        { name: t('cardPersonal'), value: show(counts.personal), index: data.config.indexes.personal },
        { name: t('cardTeam'), value: show(counts.team), index: data.config.indexes.team },
        { name: t('cardDocs'), value: show(counts.docs), index: data.config.indexes.docs, hint: chunkHint },
      ]
      return h('div', null,
        // 一行五张状态卡（照「记忆系统」页那排）：个人 / 团队 / 文档 / 待裁决 / 审计
        h('div', { style: S.statGrid },
          h(StatCard, { label: t('cardPersonal'), value: show(counts.personal) }),
          h(StatCard, { label: t('cardTeam'), value: show(counts.team) }),
          h(StatCard, { label: t('cardDocs'), value: show(counts.docs), hint: chunkHint }),
          h(StatCard, {
            label: t('cardPending'),
            value: show(counts.pending),
            hint: counts.pending > 0 ? '→ ' + t('tabBrowse') : '',
            tone: counts.pending > 0 ? 'warn' : undefined,
          }),
          h(StatCard, {
            label: t('cardAudit'),
            value: counts.audit === null || counts.audit === undefined ? '—' : counts.audit,
            // 副文案用短句：卡片宽度只有五分之一，长句会被省略号吃掉（2026-11-01 test 截图）
            hint:
              counts.auditLast7d === null || counts.auditLast7d === undefined
                ? t('cardAuditNA')
                : `${t('cardAudit7d')} ${counts.auditLast7d}`,
            tone: counts.audit === null || counts.audit === undefined ? 'idle' : undefined,
          }),
        ),

        // 第二排：记忆后端（主位）+ 心情（右栏小卡）
        h('div', { style: S.splitRow },
          h('div', { style: S.splitMain },
            h('div', { style: { ...S.card, flex: 1, minWidth: 0 } },
              h('div', { style: S.sectionHead },
                h('span', { style: S.sectionTitle }, t('backendTitle')),
                h('span', { style: S.pill(data.es.reachable ? 'ok' : 'warn') },
                  data.es.reachable ? t('esOk') : t('esDown')),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                // 三个索引各占一行：挤成「a / b / c」一条长串既读不出归属，也把卡片撑得很空
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
                  h('span', { style: { ...S.muted, fontSize: 12, width: 56, flex: 'none', lineHeight: '20px' } }, t('indexNames')),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                    [
                      [t('cardPersonal'), data.config.indexes.personal],
                      [t('cardTeam'), data.config.indexes.team],
                      [t('cardDocs'), data.config.indexes.docs],
                    ].map(([scope, name]) =>
                      h('div', { key: name, style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 } },
                        h('span', { style: { ...S.muted, fontSize: 11.5, width: 56, flex: 'none' } }, scope),
                        h('span', { style: { ...S.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
                      ),
                    ),
                  ),
                ),
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
                  h('span', { style: { ...S.muted, fontSize: 12, width: 56, flex: 'none' } }, t('backendUrl')),
                  h('span', { style: S.mono, children: data.config.url }),
                ),
              ),
              data.es.reachable ? null : h('p', { style: { ...S.err, marginTop: 8 } }, data.es.error),
            ),
          ),
          h('div', { style: S.splitSide }, MoodCard({ mood, t })),
        ),

        // 存储域：三个索引并列
        h('div', { style: { ...S.card, marginBottom: 12 } },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('storageTitle')),
            h('span', { style: { ...S.muted, fontSize: 12 } }, t('backendScope')),
          ),
          h('div', { style: S.storeGrid },
            storeCells.map((cell) =>
              h('div', { key: cell.index, style: S.storeCell },
                h('div', { style: S.storeHead },
                  h('span', { style: S.dot() }),
                  h('span', { style: { ...S.muted, fontSize: 12 } }, cell.name),
                ),
                h('div', { style: { fontSize: 18, fontWeight: 600, lineHeight: 1.3 } }, cell.value),
                cell.hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, cell.hint) : null,
                h('div', { style: { ...S.mono, ...S.muted, marginTop: 6, fontSize: 11 } }, cell.index),
              ),
            ),
          ),
        ),

        // 最近更新
        h('div', { style: S.card },
          h('div', { style: S.sectionHead },
            h('span', { style: S.sectionTitle }, t('recent')),
            h('button', { type: 'button', style: S.btn, onClick: onOpenBrowse }, `${t('tabBrowse')} →`),
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
                  h('span', { style: { flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--dsw-alias-label-primary)' } },
                    row.content.length > 96 ? `${row.content.slice(0, 96)}…` : row.content),
                  h('span', { style: { ...S.mono, ...S.muted, flex: 'none' } }, shortTime(row.updatedAt)),
                ),
              ),
        ),
      )

    }

    /**
     * 命中片段：把 ES highlight 里的哨兵字符（\u0001 … \u0002）渲染成高亮词。
     *
     * 为什么不用 ES 自带的 `<mark>`：那是把正文当 HTML 插进页面，记忆内容里
     * 什么字符都可能有。这里只认两个哨兵，其余一律按文本节点渲染。
     */
    function HighlightText({ text, style }) {
      const parts = []
      const pattern = /\u0001([\s\S]*?)\u0002/g
      let last = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) parts.push({ text: text.slice(last, match.index), mark: false })
        parts.push({ text: match[1], mark: true })
        last = match.index + match[0].length
      }
      if (last < text.length) parts.push({ text: text.slice(last), mark: false })
      return h('span', { style },
        parts.map((part, index) =>
          part.mark
            ? h('mark', {
                key: index,
                style: {
                  background: 'var(--dsw-alias-state-business-primary, #6b8cff)',
                  color: '#fff',
                  padding: '0 2px',
                  borderRadius: 3,
                },
              }, part.text)
            : h('span', { key: index }, part.text),
        ),
      )
    }

    // ── 星图（阶段 8 第六个页签）──────────────────────────────────────────

    /** 领域 → 颜色：同一个领域同一个色，图例与节点用它认亲。 */
    // 星等色：抄的是参考图那种亮色（青绿/暖金/蓝/紫/粉/橙），不是暗色图表色
    const GRAPH_PALETTE = [
      '#96beff', '#82e6c8', '#ffd28c', '#c0a5ff',
      '#ffa0d2', '#ffcd78', '#7fd8e0', '#ffb08a',
    ]
    function colorOfDomain(domain, clusters) {
      const index = clusters.findIndex((cluster) => cluster.domain === domain)
      return GRAPH_PALETTE[(index < 0 ? 0 : index) % GRAPH_PALETTE.length]
    }

    /** FNV-1a：给节点算一个 0~1 的稳定伪随机数，用于位置抖动（同一 id 永远同一个值）。 */
    function hashUnit(text) {
      let hash = 2166136261
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0) / 4294967295
    }

    /** 旋臂参数：布局与背景旋臂共用同一条曲线，节点才会真的"贴"在臂上 */
    const GALAXY_ARMS = 3
    const GALAXY_R0 = 90 // 盘心半径
    const GALAXY_R1 = 520 // 盘面外缘

    /** 第 arm 条臂在半径 r 处的角度（对数螺旋，越往外臂越"甩"开） */
    function galaxyArmAngle(arm, r) {
      return (arm / GALAXY_ARMS) * Math.PI * 2 - 2.6 * Math.log(r / 420 + 1)
    }

    /**
     * 星尘：纯装饰的微点，不参与交互、不对应任何记忆。
     *
     * 参考图之所以"协调"，很大原因是它有几万条消息铺成的小点当底噪；
     * 我们只有 268 个节点，光靠节点铺不出密度层次，就补一层确定性的星尘。
     */
    const DUST_TONES = ['rgba(200,220,255,1)', 'rgba(160,230,220,1)', 'rgba(255,224,190,1)', 'rgba(212,192,255,1)']
    const GALAXY_DUST = []
    function galaxyDust(count) {
      if (GALAXY_DUST.length === count) return GALAXY_DUST
      GALAXY_DUST.length = 0
      for (let i = 0; i < count; i += 1) {
        const t = (i + 0.5) / count
        const reach = GALAXY_R1 * (0.55 + hashUnit(`dust-r-${i}`) * 0.85)
        const r = Math.max(24, GALAXY_R0 * 0.35 + Math.sqrt(t) * reach)
        const free = hashUnit(`dust-a-${i}`) * Math.PI * 2
        const pull = Math.pow(hashUnit(`dust-p-${i}`), 2.1) * 0.9
        const arm = Math.floor(hashUnit(`dust-arm-${i}`) * GALAXY_ARMS) % GALAXY_ARMS
        const theta = free + wrapAngle(galaxyArmAngle(arm, r) - free) * pull
        GALAXY_DUST.push({
          x: Math.cos(theta) * r,
          y: (hashUnit(`dust-y-${i}`) - 0.5) * 46,
          z: Math.sin(theta) * r,
          size: 0.6 + hashUnit(`dust-s-${i}`) * 1.4,
          alpha: 0.12 + hashUnit(`dust-b-${i}`) * 0.38,
          tone: DUST_TONES[Math.floor(hashUnit(`dust-c-${i}`) * DUST_TONES.length) % DUST_TONES.length],
        })
      }
      return GALAXY_DUST
    }

    /** 角度差归一到 [-π, π]：两角之间走"近的那一侧" */
    function wrapAngle(angle) {
      const ring = Math.PI * 2
      let value = angle % ring
      if (value > Math.PI) value -= ring
      if (value < -Math.PI) value += ring
      return value
    }

    /**
     * 银河盘布局（世界坐标 3D，确定性）。
     *
     * 节点**沿旋臂铺开**，不是摊成一个圆饼：每条臂按 domain 分段落，
     * 同一领域成片、相邻领域首尾相接，整体顺着 `galaxyArmAngle` 的曲线走。
     *
     *  · 臂内位置 `t ∈ [0,1]`：半径 R0→R1，`t^0.85` 让内圈稍密；
     *  · 臂宽随半径变大（外圈更蓬松），径向偏移用节点 id 哈希抖动；
     *  · 角度再加一点抖动，臂才不会像画出来的细线；
     *  · y 轴给厚度，中心厚、外缘薄；
     *  · 最大连通分量之外的碎点（孤点）放到盘外的"晕"里。
     *
     * 全程用排序 + 哈希，所以同一份数据每次都是同一张盘。
     */
    function layoutGalaxy(graph) {
      const positions = new Map()
      const nodes = graph.nodes
      if (nodes.length === 0) return { positions, radius: 0 }

      const adj = new Map()
      for (const node of nodes) adj.set(node.id, [])
      for (const edge of graph.edges) {
        adj.get(edge.source)?.push(edge.target)
        adj.get(edge.target)?.push(edge.source)
      }
      for (const list of adj.values()) list.sort()

      const seen = new Set()
      const components = []
      for (const node of nodes) {
        if (seen.has(node.id)) continue
        const queue = [node.id]
        seen.add(node.id)
        const members = []
        while (queue.length > 0) {
          const id = queue.shift()
          members.push(id)
          for (const next of adj.get(id) ?? []) {
            if (seen.has(next)) continue
            seen.add(next)
            queue.push(next)
          }
        }
        components.push(members)
      }
      components.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1))

      const byId = new Map(nodes.map((node) => [node.id, node]))
      const GOLDEN = Math.PI * (3 - Math.sqrt(5))

      // ── 主盘：最大连通分量沿三条臂铺开 ──────────────────────────────
      const core = components[0]
      const byDomain = new Map()
      for (const id of core) {
        const domain = byId.get(id)?.domain ?? 'general'
        if (!byDomain.has(domain)) byDomain.set(domain, [])
        byDomain.get(domain).push(id)
      }
      // domain 按大小降序、同大小按名字，保证每次分组一致
      const domains = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      const domainIndex = new Map(domains.map(([domain], index) => [domain, index]))
      const domainSize = new Map(domains.map(([domain, ids]) => [domain, ids.length]))
      // 一个 domain 就占了小半张图时，不能整条臂都给它——否则三条臂里只有一条有东西。
      // 超过这个比例就按 id 哈希打散到各臂，保证每条臂的星量接近。
      const heavy = core.length * 0.22

      // 核球：度数最高的一小撮压在盘心，给整张图一个"亮核"
      const degreeOf = (id) => byId.get(id)?.degree ?? 0
      const corePick = core.slice().sort((a, b) => degreeOf(b) - degreeOf(a) || (a < b ? -1 : 1))
        .slice(0, Math.max(3, Math.round(core.length * 0.05)))
      const coreSet = new Set(corePick)
      corePick.forEach((id, k) => {
        const rr = Math.sqrt((k + 0.5) / corePick.length) * GALAXY_R0 * 0.9
        const theta = k * Math.PI * (3 - Math.sqrt(5))
        positions.set(id, {
          x: Math.cos(theta) * rr,
          y: (hashUnit(id + '#y') - 0.5) * 92,
          z: Math.sin(theta) * rr,
        })
      })

      const armBuckets = Array.from({ length: GALAXY_ARMS }, () => [])
      for (const id of core) {
        if (coreSet.has(id)) continue
        const domain = byId.get(id)?.domain ?? 'general'
        const size = domainSize.get(domain) ?? 0
        const arm = size > heavy
          ? Math.floor(hashUnit(id + '#arm') * GALAXY_ARMS) % GALAXY_ARMS
          : (domainIndex.get(domain) ?? 0) % GALAXY_ARMS
        armBuckets[arm].push(id)
      }

      armBuckets.forEach((ids, arm) => {
        // 臂内按度数降序：hub 靠近盘心，叶子甩到盘的外段
        const ordered = ids.slice().sort((a, b) => {
          const da = byId.get(a)?.degree ?? 0
          const db = byId.get(b)?.degree ?? 0
          return db - da || (a < b ? -1 : 1)
        })
        const total = ordered.length
        ordered.forEach((id, k) => {
          const t = (k + 0.5) / Math.max(1, total)
          // 半径按面积均匀（sqrt），再给 ±17% 抖动——星点应该铺满盘面，不是排在一条弧上
          const radial = Math.sqrt(t)
          const baseR = GALAXY_R0 + radial * (GALAXY_R1 - GALAXY_R0)
          const r = Math.max(32, baseR * (0.84 + hashUnit(id + '#r') * 0.34))
          // 自由角度：整张盘铺开
          const free = k * Math.PI * (3 - Math.sqrt(5)) + hashUnit(id + '#a') * Math.PI * 2
          // 朝所属臂拉：pull 用高次幂压小，多数节点保持散开，只有少数贴到臂上。
          // 这样臂是"统计上更密"，而不是一条珠子串。
          const pull = Math.pow(hashUnit(id + '#pull'), 2.6) * 0.92
          const target = galaxyArmAngle(arm, r)
          const theta = free + wrapAngle(target - free) * pull
          positions.set(id, {
            x: Math.cos(theta) * r,
            // 中心厚、外缘薄：给出"盘"的轮廓
            y: (hashUnit(id + '#y') - 0.5) * 66 * (1 - radial * 0.55),
            z: Math.sin(theta) * r,
          })
        })
      })

      // ── 晕：主盘之外的碎点，散在盘外一圈 ───────────────────────────
      let haloR = GALAXY_R1 + 70
      components.slice(1).forEach((members, index) => {
        const angle = index * GOLDEN + hashUnit(members[0]) * 0.6
        const dist = GALAXY_R1 + 60 + (index % 4) * 46
        const cx = Math.cos(angle) * dist
        const cz = Math.sin(angle) * dist
        members.forEach((id, k) => {
          const rr = members.length > 1 ? Math.sqrt((k + 0.5) / members.length) * 26 : 0
          const theta = k * GOLDEN
          positions.set(id, {
            x: cx + Math.cos(theta) * rr,
            y: (hashUnit(id + '#y') - 0.5) * 24,
            z: cz + Math.sin(theta) * rr,
          })
        })
        haloR = Math.max(haloR, dist + 30)
      })

      return { positions, radius: haloR }
    }

    /**
     * 取以 `centerId` 为中心、`depth` 跳以内的子图。
     *
     * 用已取到的全局图算，不再打接口：图里已经有 300 个节点和它们的边，
     * 两跳足够看清「这条记忆挨着谁」。缺点是邻居若不在 top-300 里会缺——
     * 所以界面上会标明这是「当前视图内的两跳」。
     */
    function subgraphOf(graph, centerId, depth) {
      const adj = new Map()
      for (const node of graph.nodes) adj.set(node.id, [])
      for (const edge of graph.edges) {
        adj.get(edge.source)?.push(edge.target)
        adj.get(edge.target)?.push(edge.source)
      }
      const level = new Map([[centerId, 0]])
      const queue = [centerId]
      while (queue.length > 0) {
        const id = queue.shift()
        const d = level.get(id)
        if (d >= depth) continue
        for (const next of adj.get(id) ?? []) {
          if (level.has(next)) continue
          level.set(next, d + 1)
          queue.push(next)
        }
      }
      const nodes = graph.nodes.filter((node) => level.has(node.id))
      const edges = graph.edges.filter((edge) => level.has(edge.source) && level.has(edge.target))
      return {
        nodes,
        edges,
        clusters: graph.clusters.filter((cluster) => nodes.some((node) => node.domain === cluster.domain)),
        stats: graph.stats,
        level,
      }
    }

    /**
     * 聚焦布局：中心节点在原点，1 跳 / 2 跳各一层球壳。
     *
     * 用球面均匀分布（黄金角 + 余弦分层）而不是同心环：3D 视线下
     * 同心环转起来会像两个亮圈套在一起，球壳看起来才像"周围一圈邻居"。
     */
    function layoutFocusGalaxy(subgraph) {
      const positions = new Map()
      const rings = new Map()
      for (const node of subgraph.nodes) {
        const d = subgraph.level.get(node.id) ?? 0
        if (!rings.has(d)) rings.set(d, [])
        rings.get(d).push(node.id)
      }
      const GOLDEN = Math.PI * (3 - Math.sqrt(5))
      const SHELL = [0, 250, 490]
      for (const [d, ids] of rings) {
        ids.sort()
        if (d === 0) {
          positions.set(ids[0], { x: 0, y: 0, z: 0 })
          continue
        }
        const radius = SHELL[Math.min(d, SHELL.length - 1)]
        const count = ids.length
        ids.forEach((id, i) => {
          const v = count === 1 ? 0 : 1 - (i / (count - 1)) * 2
          const ring = Math.sqrt(Math.max(0, 1 - v * v))
          const theta = i * GOLDEN + d * 0.7
          const jitter = 0.86 + hashUnit(id) * 0.28
          positions.set(id, {
            x: Math.cos(theta) * ring * radius * jitter,
            y: v * radius * 0.7 * jitter,
            z: Math.sin(theta) * ring * radius * jitter,
          })
        })
      }
      return { positions, radius: 540 }
    }

    /** JSON Canvas 的六种颜色编号（1 红 / 2 橙 / 3 黄 / 4 绿 / 5 青 / 6 紫） */
    function canvasColor(domain, clusters) {
      const index = clusters.findIndex((cluster) => cluster.domain === domain)
      return String(((index < 0 ? 0 : index) % 6) + 1)
    }

    /**
     * 导出 JSON Canvas 1.0（obsidian.md/canvas 的开放格式）。
     *
     * 坐标直接取当前布局：用户在屏幕上看到的就是他导出得到的，不需要再跑一遍布局
     * （重算反而会得到另一个形状，因为布局虽然确定性，但依赖画布尺寸）。
     * 坐标乘 2 是为了在 canvas 里留出间距——我们的布局是"屏幕像素"，canvas 里节点更大。
     */
    function buildCanvasJson(graph, layout) {
      const points = []
      for (const node of graph.nodes) {
        const point = layout.positions.get(node.id)
        if (point !== undefined) points.push({ node, point })
      }
      if (points.length === 0) return null
      let minX = Infinity
      let minY = Infinity
      for (const { point } of points) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
      }
      const nodes = points.map(({ node, point }) => ({
        id: node.id,
        type: 'text',
        // 正文放摘要，元信息单独一行——canvas 里节点就是一张小卡片
        text: `${node.label}\n\n${node.domain} · ${node.type} · ${t_degree(node)}`,
        x: Math.round((point.x - minX) * 2),
        y: Math.round((point.y - minY) * 2),
        width: 280,
        height: 90,
        color: canvasColor(node.domain, graph.clusters),
      }))
      const edges = graph.edges.map((edge, index) => ({
        id: `edge-${index}`,
        fromNode: edge.source,
        toNode: edge.target,
        label: edge.weight.toFixed(2),
      }))
      return { nodes, edges }
    }

    /** 只有一处用到度数文案，单独抽出来免得混进闭包里的 t */
    function t_degree(node) {
      return `度 ${node.degree}`
    }

    /** 触发浏览器下载一个 JSON 文件（不引任何依赖）。 */
    function downloadJson(filename, data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    /**
     * 星图页：Canvas 2D + 手写 3D 投影。
     *
     * 视觉参考了 dsh-Memory-Galaxy（MIT，Derpyu520 & 大肥鱼）的银河风格，
     * 但布局、投影、交互都是这里自己的实现：数据仍然是我们自己的记忆边，
     * 相机只在渲染层转，不动任何业务。
     *
     * 做法：世界坐标 3D → yaw/pitch 旋转 → 透视 → 屏幕。
     * 不引 three.js：300 个点和 600 条边用不着渲染管线，手写这套更轻。
     */
    const GALAXY_CAM = { yaw: -0.55, pitch: -1.05, dist: 1040, focal: 1600 }
    const GALAXY_ORBIT_SPEED = 0.0009 // 每帧 0.0009 rad ≈ 两分钟一圈

    /** 光晕贴图缓存：每种颜色预渲染一张径向渐变，绘制时 drawImage 缩放 */
    const GLOW_SPRITES = new Map()
    function glowSprite(color) {
      const cached = GLOW_SPRITES.get(color)
      if (cached !== undefined) return cached
      const size = 64
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const g = canvas.getContext('2d')
      if (g !== null) {
        const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
        gradient.addColorStop(0, hexToRgba(color, 1))
        gradient.addColorStop(0.28, hexToRgba(color, 0.5))
        gradient.addColorStop(0.62, hexToRgba(color, 0.13))
        gradient.addColorStop(1, hexToRgba(color, 0))
        g.fillStyle = gradient
        g.fillRect(0, 0, size, size)
      }
      GLOW_SPRITES.set(color, canvas)
      return canvas
    }

    /** #rrggbb → rgba(r,g,b,a)：画布渐变的色标只认 rgba 字符串 */
    function hexToRgba(hex, alpha) {
      const value = String(hex).replace('#', '')
      const r = parseInt(value.slice(0, 2), 16) || 0
      const g = parseInt(value.slice(2, 4), 16) || 0
      const b = parseInt(value.slice(4, 6), 16) || 0
      return `rgba(${r},${g},${b},${alpha})`
    }

    /** 深空背景：渐变 + 中心核辉光 + 远景散星，只在画布尺寸变化时重画一次 */
    function buildGalaxyBackdrop(width, height, dpr) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      const ctx = canvas.getContext('2d')
      if (ctx === null) return { canvas, width, height }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.72)
      bg.addColorStop(0, '#0e1730')
      bg.addColorStop(0.45, '#070c18')
      bg.addColorStop(1, '#03050b')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, width, height)

      // 核心辉光：暖金色，模仿银河核球
      const coreRadius = Math.max(120, Math.min(width, height) * 0.46)
      const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, coreRadius)
      glow.addColorStop(0, 'rgba(255,246,225,.12)')
      glow.addColorStop(0.16, 'rgba(255,232,190,.07)')
      glow.addColorStop(0.46, 'rgba(255,205,140,.022)')
      glow.addColorStop(1, 'rgba(255,190,120,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, width, height)

      // 远景散星：确定性（同一个位置永远是同一颗星）
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 220; i += 1) {
        const x = hashUnit(`bg-x-${i}`) * width
        const y = hashUnit(`bg-y-${i}`) * height
        const r = 0.35 + hashUnit(`bg-r-${i}`) * 1.15
        const warm = hashUnit(`bg-w-${i}`) > 0.72
        ctx.globalAlpha = 0.1 + hashUnit(`bg-a-${i}`) * 0.34
        ctx.fillStyle = warm ? 'rgba(255,225,180,1)' : 'rgba(170,195,255,1)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      return { canvas, width, height }
    }

    function GraphView({ t }) {
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      // 个人库与团队库分开画：默认团队，看个人要显式切换
      const [scope, setScope] = React.useState('team')
      const [hover, setHover] = React.useState(null)
      const [size, setSize] = React.useState({ width: 900, height: 560 })
      const [focusId, setFocusId] = React.useState(null)
      // 自转默认开：转起来才有"星图"的感觉；切走页签会自动停
      const [orbit, setOrbit] = React.useState(true)
      const wrapRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const backdropRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const camRef = React.useRef({ ...GALAXY_CAM })
      // 投影用的画布尺寸：每帧从容器实时读，避免 state 落后于真实布局（画布比容器小一圈）
      const viewportRef = React.useRef({ width: 900, height: 560 })
      const sceneRef = React.useRef({ hits: [], screen: new Map() })
      const drawRef = React.useRef(() => {})
      const orbitRef = React.useRef(true)
      const visibleRef = React.useRef(true)
      const rafRef = React.useRef(null)
      const loopRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        setState({ loading: true, error: '', data: null })
        apiGet('/graph', { limit: 300, scope })
          .then((data) => {
            if (alive) setState({ loading: false, error: '', data })
          })
          .catch((error) => {
            if (alive) setState({ loading: false, error: String(error.message ?? error), data: null })
          })
        return () => {
          alive = false
        }
      }, [scope])

      // 尺寸跟随容器。布局与画布尺寸无关（世界坐标），这里只影响投影与画布像素。
      React.useEffect(() => {
        const element = wrapRef.current
        if (element === null) return
        const measure = () => {
          const rect = element.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      // 页签切走 / 滚出视口时停掉动画：星图不该在后台一直烧 CPU
      React.useEffect(() => {
        const element = wrapRef.current
        if (element === null) return
        const observer = new IntersectionObserver((entries) => {
          const entry = entries[0]
          visibleRef.current = entry?.isIntersecting === true
          if (visibleRef.current) {
            // 重新可见：先把循环拉起来，再补画一帧（避免「切回来不自转」）
            loopRef.current?.()
            drawRef.current()
          }
        }, { threshold: 0.02 })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        orbitRef.current = orbit
      }, [orbit])

      // 预设相机：聚焦时拉近，返回全图时退回
      React.useEffect(() => {
        camRef.current = {
          ...GALAXY_CAM,
          dist: focusId === null ? GALAXY_CAM.dist : 880,
        }
        drawRef.current()
      }, [focusId])

      const model = React.useMemo(() => {
        if (state.data === null) return null
        if (focusId === null) return { graph: state.data, layout: layoutGalaxy(state.data), focused: null }
        const sub = subgraphOf(state.data, focusId, 2)
        return { graph: sub, layout: layoutFocusGalaxy(sub), focused: focusId }
      }, [state.data, focusId])

      const colorMap = React.useMemo(() => {
        const map = new Map()
        const clusters = model?.graph.clusters ?? []
        for (const node of model?.graph.nodes ?? []) map.set(node.id, colorOfDomain(node.domain, clusters))
        return map
      }, [model])

      /** 世界坐标 → 屏幕坐标。focal/dist 是透视，unit 让盘在任意画布上都差不多大。 */
      const pickAt = (mx, my) => {
        let best = null
        let bestScore = Infinity
        for (const hit of sceneRef.current.hits) {
          const dist = Math.hypot(hit.x - mx, hit.y - my)
          const reach = Math.max(16, hit.r + 11)
          if (dist > reach) continue
          // 近的（z 小）优先：重叠处点最前面的那颗
          const score = dist - hit.z * 0.0004
          if (score < bestScore) {
            bestScore = score
            best = hit
          }
        }
        return best
      }

      drawRef.current = () => {
        const canvas = canvasRef.current
        const wrap = wrapRef.current
        if (canvas === null || wrap === null || model === null || !visibleRef.current) return
        // 容器尺寸每帧现读：ResizeObserver 的回调可能还没到，
        // 用 state 里的旧值会让画布停在上一档尺寸、右下留一大块空
        const rect = wrap.getBoundingClientRect()
        const width = Math.max(1, Math.round(rect.width))
        const height = Math.max(1, Math.round(rect.height))
        viewportRef.current = { width, height }
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const pixelW = Math.max(1, Math.round(width * dpr))
        const pixelH = Math.max(1, Math.round(height * dpr))
        if (canvas.width !== pixelW || canvas.height !== pixelH) {
          canvas.width = pixelW
          canvas.height = pixelH
          canvas.style.width = `${width}px`
          canvas.style.height = `${height}px`
          backdropRef.current = null
        }
        const ctx = canvas.getContext('2d')
        if (ctx === null) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'

        // 背景：尺寸不变就复用离屏缓存，不每帧重画渐变
        let backdrop = backdropRef.current
        if (backdrop === null || backdrop.width !== width || backdrop.height !== height) {
          backdrop = buildGalaxyBackdrop(width, height, dpr)
          backdropRef.current = backdrop
        }
        ctx.drawImage(backdrop.canvas, 0, 0, width, height)

        // 投影：三角函数一帧算一次。星尘有两千多个，逐点算 cos/sin 会明显掉帧。
        const cam = camRef.current
        const cy = Math.cos(cam.yaw)
        const sy = Math.sin(cam.yaw)
        const cp = Math.cos(cam.pitch)
        const sp = Math.sin(cam.pitch)
        const unit = Math.min(width, height) / 900
        const project = (px, py, pz) => {
          const x1 = px * cy - pz * sy
          const z1 = px * sy + pz * cy
          const y2 = py * cp - z1 * sp
          const z2 = py * sp + z1 * cp
          const persp = cam.focal / Math.max(120, cam.focal + z2 + cam.dist * 0.35)
          const k = persp * unit
          return { x: width / 2 + x1 * k, y: height / 2 + y2 * k, z: z2, k }
        }

        // 星尘：铺底噪。极小的点，不参与拾取，也不连任何记忆
        const dust = galaxyDust(3800)
        ctx.globalCompositeOperation = 'lighter'
        for (const mote of dust) {
          const projected = project(mote.x, mote.y, mote.z)
          const size = Math.max(0.4, mote.size * projected.k * 1.7)
          ctx.globalAlpha = mote.alpha * Math.min(1, projected.k * 1.15)
          ctx.fillStyle = mote.tone
          ctx.fillRect(projected.x, projected.y, size, size)
        }

        const graph = model.graph
        const now = Date.now()
        const points = []
        for (const node of graph.nodes) {
          const world = model.layout.positions.get(node.id)
          if (world === undefined) continue
          const projected = project(world.x, world.y, world.z)
          points.push({ node, world, screen: projected, color: colorMap.get(node.id) ?? '#6b8cff' })
        }
        // 远的先画，近的盖上去
        points.sort((a, b) => b.screen.z - a.screen.z)

        const screenOf = new Map()
        for (const item of points) screenOf.set(item.node.id, item.screen)

        // 旋臂薄雾：跟着相机转，所以每帧重画（只有两条曲线，很便宜）
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'
        // 雾带只求隐约可见：这里是 lighter 叠加，两层会累加，过亮会盖过星点
        for (const pass of [{ color: 'rgba(120,165,255,1)', width: 66, alpha: 0.02 }, { color: 'rgba(255,170,205,1)', width: 28, alpha: 0.011 }]) {
          ctx.globalAlpha = pass.alpha
          ctx.strokeStyle = pass.color
          ctx.lineWidth = pass.width * unit
          for (let arm = 0; arm < GALAXY_ARMS; arm += 1) {
            ctx.beginPath()
            for (let i = 0; i <= 64; i += 1) {
              // 与布局共用 galaxyArmAngle：雾带和节点才会贴在同一条曲线上
              const rr = GALAXY_R0 * 0.55 + (i / 64) * (GALAXY_R1 + 70 - GALAXY_R0 * 0.55)
              const theta = galaxyArmAngle(arm, rr)
              const projected = project(Math.cos(theta) * rr, 0, Math.sin(theta) * rr)
              if (i === 0) ctx.moveTo(projected.x, projected.y)
              else ctx.lineTo(projected.x, projected.y)
            }
            ctx.stroke()
          }
        }

        // 边：加色混合，弱边压得很低，避免 600 条线糊成一片
        ctx.lineCap = 'round'
        for (const edge of graph.edges) {
          const a = screenOf.get(edge.source)
          const b = screenOf.get(edge.target)
          if (a === undefined || b === undefined) continue
          const active = hover !== null && (hover === edge.source || hover === edge.target)
          const fog = Math.max(0.18, Math.min(1, 0.95 - (a.z + b.z) * 0.00035))
          // 边的亮度按屏幕长度衰减：同臂的短边清楚，跨臂的长线自然淡掉。
          // 否则 601 条长线叠起来会变成一层网，把星点和旋臂全盖住。
          const span = Math.hypot(a.x - b.x, a.y - b.y)
          // 跨臂的长边全局不画：601 条叠起来就是一层网。鼠标悬停某个节点时
          // 才把它的全部边（含长边）亮出来，结构信息不丢，画面先干净。
          if (!active && span > 170) continue
          const near = Math.max(0.2, Math.min(1, 1 - span / 220))
          ctx.globalAlpha = (active ? 0.62 : 0.01 + edge.weight * 0.035) * fog * (active ? 1 : near)
          ctx.strokeStyle = active ? 'rgba(190,215,255,1)' : 'rgba(96,130,190,1)'
          ctx.lineWidth = (active ? 1.7 : 0.45 + edge.weight * 0.45) * Math.min(1.6, (a.k + b.k) * 1.4)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }

        // 节点：本体用正常混合保住领域色，只有光晕是半透明的径向渐变
        ctx.globalCompositeOperation = 'source-over'
        const hits = []
        const labels = []
        for (const item of points) {
          const node = item.node
          const screen = item.screen
          const age = node.updatedAt === '' ? 365 : Math.min(365, (now - Date.parse(node.updatedAt)) / 86400000)
          const fresh = 1 - Math.min(1, age / 120)
          const depth = Math.min(1.6, Math.max(0.55, screen.k * 1.15))
          const isHover = hover === node.id
          const isFocus = model.focused === node.id
          // 半径拉开层次：度数取 0.75 次幂后差距更明显，再叠 id 哈希（0.72~1.32），
          // 少数大亮星 + 大量小点才像星图，全都一样大就成撒豆子了
          const sizeJitter = 0.8 + hashUnit(node.id + '#sz') * 0.5
          const radius = (1.35 + Math.pow(Math.min(8, node.degree), 0.7) * 0.95) * sizeJitter * depth * (isHover || isFocus ? 1.3 : 1)
          // 亮度再按 id 抖一点：同一领域全一样亮会像一排灯，星点该有明暗层次
          const twinkle = 0.78 + hashUnit(node.id + '#b') * 0.4
          const alpha = Math.min(1, (0.42 + fresh * 0.58) * (0.6 + depth * 0.5) * twinkle * (isHover ? 1.35 : 1))

          hits.push({ id: node.id, x: screen.x, y: screen.y, r: radius, z: screen.z })

          // 光晕用预渲染的径向渐变贴图：实心圆即使 alpha 很低，在暗背景上也能看到硬边，
          // 会变成一颗颗"圆盘"。贴图边缘是真渐变到 0，叠多少层都不会有轮廓。
          const sprite = glowSprite(item.color)
          const glowSize = radius * (isHover || isFocus ? 9.5 : node.degree >= 8 ? 7 : 5.2)
          ctx.globalAlpha = Math.min(1, alpha * (isHover || isFocus ? 1.05 : 0.72))
          ctx.drawImage(sprite, screen.x - glowSize / 2, screen.y - glowSize / 2, glowSize, glowSize)

          ctx.globalAlpha = alpha
          ctx.fillStyle = item.color
          ctx.beginPath()
          ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
          ctx.fill()

          // 团队记忆一圈白描边（个人 = 实心），两库不再同图混画但各自仍要能认
          if (node.scope === 'team') {
            ctx.globalAlpha = Math.min(1, alpha + 0.15)
            ctx.strokeStyle = 'rgba(235,245,255,.7)'
            ctx.lineWidth = Math.min(1.4, radius * 0.16)
            ctx.beginPath()
            ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
            ctx.stroke()
          }
          if (isHover || isFocus) {
            ctx.globalAlpha = 0.95
            ctx.strokeStyle = '#ffffff'
            ctx.lineWidth = 1.3
            ctx.beginPath()
            ctx.arc(screen.x, screen.y, radius + 3.5, 0, Math.PI * 2)
            ctx.stroke()
          }

          // 标签候选：悬停 / 选中 / 度数高的前几颗
          if (isHover || isFocus || node.degree >= 6) labels.push({ item, radius, score: node.degree + fresh * 2 })
        }

        // 标签：白字 + 深底衬，按分数取前 10 个并做碰撞剔除，否则会糊成一团
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
        const placed = []
        labels.sort((a, b) => b.score - a.score)
        ctx.font = '12px "Microsoft YaHei", system-ui, sans-serif'
        for (const entry of labels.slice(0, 8)) {
          const text = String(entry.item.node.label).slice(0, 14)
          const widthText = Math.min(150, ctx.measureText(text).width)
          const boxX = entry.item.screen.x + entry.radius + 6
          const boxY = entry.item.screen.y - 9
          const box = [boxX - 4, boxY - 2, widthText + 10, 16]
          if (box[0] + box[2] > width - 6 || box[1] < 2 || box[1] + box[3] > height - 2) continue
          const collide = placed.some((other) => !(box[0] > other[0] + other[2] || box[0] + box[2] < other[0] || box[1] > other[1] + other[3] || box[1] + box[3] < other[1]))
          if (collide) continue
          placed.push(box)
          ctx.globalAlpha = 0.82
          ctx.fillStyle = 'rgba(5,9,18,.88)'
          ctx.beginPath()
          const rr = 4
          const [bx, by, bw, bh] = box
          ctx.moveTo(bx + rr, by)
          ctx.lineTo(bx + bw - rr, by)
          ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr)
          ctx.lineTo(bx + bw, by + bh - rr)
          ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh)
          ctx.lineTo(bx + rr, by + bh)
          ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr)
          ctx.lineTo(bx, by + rr)
          ctx.quadraticCurveTo(bx, by, bx + rr, by)
          ctx.closePath()
          ctx.fill()
          ctx.globalAlpha = 0.92
          ctx.fillStyle = '#dce8ff'
          ctx.fillText(text, boxX, entry.item.screen.y + 3)
        }
        ctx.globalAlpha = 1

        sceneRef.current = { hits, screen: screenOf }
      }

      // 渲染循环：只有「自转开 + 页签可见」才持续跑，其余时候按需重画一帧
      React.useEffect(() => {
        const tick = () => {
          rafRef.current = null
          // 不可见就停下、不再调度；重新可见时由 IntersectionObserver 把循环拉起来
          if (!visibleRef.current) return
          if (orbitRef.current && dragRef.current === null) camRef.current.yaw += GALAXY_ORBIT_SPEED
          drawRef.current()
          if (orbitRef.current) rafRef.current = window.requestAnimationFrame(tick)
        }
        loopRef.current = () => {
          if (rafRef.current === null && visibleRef.current) rafRef.current = window.requestAnimationFrame(tick)
        }
        if (orbit) {
          loopRef.current()
        } else {
          drawRef.current()
        }
        return () => {
          loopRef.current = null
          if (rafRef.current !== null) {
            window.cancelAnimationFrame(rafRef.current)
            rafRef.current = null
          }
        }
      }, [orbit])

      // 任何依赖变化（数据 / 尺寸 / 悬停 / 聚焦）都重画一帧；自转时循环会自己画
      React.useEffect(() => {
        drawRef.current()
      }, [model, size, hover, colorMap, focusId])

      // 拖动旋转 / 滚轮推拉都挂在 window 上：鼠标划出画布时不该断
      React.useEffect(() => {
        let frame = null
        const flush = () => {
          frame = null
          const drag = dragRef.current
          if (drag === null) return
          const cam = camRef.current
          const dx = drag.pendingX - drag.lastX
          const dy = drag.pendingY - drag.lastY
          drag.lastX = drag.pendingX
          drag.lastY = drag.pendingY
          cam.yaw += dx * 0.006
          cam.pitch = Math.max(-1.42, Math.min(0.42, cam.pitch + dy * 0.005))
          drawRef.current()
        }
        const onMove = (event) => {
          const drag = dragRef.current
          if (drag === null) return
          if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true
          if (!drag.moved) return
          drag.pendingX = event.clientX
          drag.pendingY = event.clientY
          if (frame === null) frame = window.requestAnimationFrame(flush)
        }
        const onUp = () => {
          if (frame !== null) {
            window.cancelAnimationFrame(frame)
            frame = null
          }
          dragRef.current = null
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        window.addEventListener('blur', onUp)
        return () => {
          if (frame !== null) window.cancelAnimationFrame(frame)
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          window.removeEventListener('blur', onUp)
        }
      }, [])

      const resetCamera = () => {
        camRef.current = { ...GALAXY_CAM, dist: focusId === null ? GALAXY_CAM.dist : 880 }
        drawRef.current()
      }

      // 团队 / 个人切换（默认团队）。放在工具栏首位，加载态也保留，切换时控件不会闪没
      const scopeSwitch = h('div', { style: S.seg },
        [['team', t('scopeTeam')], ['personal', t('scopePersonal')]].map(([value, label]) =>
          h('button', {
            key: value,
            type: 'button',
            style: S.segBtn(scope === value),
            onClick: () => {
              if (scope === value) return
              setScope(value)
              setFocusId(null)
              setHover(null)
              camRef.current = { ...GALAXY_CAM }
            },
          }, label),
        ),
      )

      if (state.loading) {
        return h('div', null, h('div', { style: S.toolbar }, scopeSwitch),
          h('p', { style: S.muted }, t('loading')))
      }
      if (state.error) {
        return h('div', null, h('div', { style: S.toolbar }, scopeSwitch),
          h('p', { style: S.err }, `${t('error')}: ${state.error}`))
      }
      if (model === null) {
        return h('div', null, h('div', { style: S.toolbar }, scopeSwitch),
          h('p', { style: S.muted }, t('empty')))
      }

      const graph = model.graph
      const stats = graph.stats
      const focusNode = model.focused === null ? null : graph.nodes.find((node) => node.id === model.focused) ?? null
      const hoverNode = hover === null ? null : graph.nodes.find((node) => node.id === hover) ?? null
      const inFocus = model.focused !== null

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 180px)', minHeight: 420 } },
        h('div', { style: S.toolbar },
          inFocus
            ? h('span', { style: { ...S.muted, fontSize: 12 } },
                `${t('graphFocus')}：${String(focusNode?.label ?? '').slice(0, 22)} · ` +
                  `${graph.nodes.length} ${t('graphNodes')} · ${graph.edges.length} ${t('graphEdges')}`)
            : h('span', { style: S.muted, fontSize: 12 },
                `${graph.nodes.length} ${t('graphNodes')} · ${graph.edges.length} ${t('graphEdges')} · ` +
                  `${graph.clusters.length} ${t('graphClusters')}` +
                  (stats.orphans > 0 ? ` · ${stats.orphans} ${t('graphOrphans')}` : '') +
                  (stats.unresolved > 0 ? ` · ${stats.unresolved} ${t('graphUnresolved')}` : '')),
          scopeSwitch,
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, ...S.muted } },
            h('span', {
              style: {
                width: 8, height: 8, borderRadius: 999, background: '#6b8cff',
                ...(scope === 'team' ? { border: '1px solid rgba(255,255,255,.7)' } : {}),
              },
            }),
            scope === 'team' ? t('scopeTeam') : t('scopePersonal')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.muted, fontSize: 12 }, inFocus ? t('graphFocusHint') : t('graphGlobalHint')),
          h('button', {
            type: 'button',
            style: orbit ? { ...S.btn, borderColor: 'rgba(120,200,255,.6)', color: '#cfe8ff' } : S.btn,
            onClick: () => setOrbit((prev) => !prev),
            title: t('graphOrbitHint'),
          }, t('graphOrbit')),
          inFocus
            ? h('button', {
                type: 'button',
                style: S.btn,
                onClick: () => {
                  setFocusId(null)
                  setHover(null)
                },
              }, t('graphBack'))
            : null,
          h('button', {
            type: 'button',
            style: S.btn,
            onClick: () => {
              const payload = buildCanvasJson(graph, { positions: sceneRef.current.screen })
              if (payload === null) return
              console.info('[memory-es] canvas export ' + JSON.stringify({
                nodes: payload.nodes.length,
                edges: payload.edges.length,
                sample: payload.nodes[0],
                sampleEdge: payload.edges[0],
              }))
              const stamp = new Date().toISOString().slice(0, 10)
              downloadJson(`memory-graph-${stamp}.canvas`, payload)
            },
            title: t('graphExportHint'),
          }, t('graphExport')),
          h('button', { type: 'button', style: S.btn, onClick: resetCamera }, t('graphReset')),
        ),
        h('div', {
          ref: wrapRef,
          style: {
            ...S.card, padding: 0, overflow: 'hidden', position: 'relative',
            width: '100%', flex: 1, minHeight: 0,
            cursor: hover === null ? 'grab' : 'pointer',
            background: '#03050b',
          },
          onMouseMove: (event) => {
            if (dragRef.current !== null) return
            const rect = event.currentTarget.getBoundingClientRect()
            const hit = pickAt(event.clientX - rect.left, event.clientY - rect.top)
            setHover(hit === null ? null : hit.id)
          },
          onMouseDown: (event) => {
            if (event.button !== 0) return
            event.preventDefault()
            dragRef.current = {
              startX: event.clientX, startY: event.clientY,
              lastX: event.clientX, lastY: event.clientY,
              pendingX: event.clientX, pendingY: event.clientY,
              moved: false,
            }
          },
          onMouseUp: (event) => {
            // 点击判定在 React 侧做（早于 window 的 mouseup），拖动结束的清理交给 window
            const drag = dragRef.current
            if (drag === null || drag.moved) return
            dragRef.current = null
            const rect = event.currentTarget.getBoundingClientRect()
            const hit = pickAt(event.clientX - rect.left, event.clientY - rect.top)
            if (hit === null) {
              if (inFocus) setFocusId(null)
              return
            }
            setFocusId(hit.id)
          },
          onMouseLeave: () => {
            setHover(null)
          },
          onWheel: (event) => {
            event.preventDefault()
            const cam = camRef.current
            const next = cam.dist * (event.deltaY > 0 ? 1.12 : 0.89)
            cam.dist = Math.max(620, Math.min(5200, next))
            if (!orbit) drawRef.current()
          },
        },
          h('canvas', { ref: canvasRef, style: { display: 'block' } }),
          hoverNode === null
            ? null
            : h('div', {
                style: {
                  position: 'absolute', left: 12, bottom: 12, maxWidth: '62%',
                  background: 'rgba(8,13,24,.9)',
                  border: '1px solid rgba(120,160,255,.22)', borderRadius: 10,
                  padding: '8px 11px', fontSize: 12, lineHeight: 1.6,
                  backdropFilter: 'blur(6px)',
                },
              },
                h('div', { style: { color: '#93a2c0', fontSize: 11 } },
                  `${hoverNode.domain} · ${hoverNode.type} · ${t('graphDegree')} ${hoverNode.degree}`),
                h('div', { style: { color: '#e3ecff' } },
                  String(hoverNode.label).slice(0, 120)),
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
              field.isDefault
                ? h('span', { style: { fontSize: 11, ...S.muted, whiteSpace: 'nowrap' } }, t('configDefault'))
                : null,
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
      // 添加表情包：null = 表单收起，否则是草稿。浏览器读不了宿主目录，图只能 base64 交给宿主落盘
      const [stickerDraft, setStickerDraft] = React.useState(null)
      const [stickerBusy, setStickerBusy] = React.useState(false)
      const [stickerMsg, setStickerMsg] = React.useState('')
      const stickerFileRef = React.useRef(null)

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

      /**
       * 添加表情包：读图 → base64 → 宿主落盘。
       * 前端只做「早失败」的那几项（没选图 / 必填为空 / 超大），真正的大小、扩展名、
       * 重名与 JSON 结构校验全在宿主侧再做一遍——浏览器这层随时可以被绕过。
       */
      const submitSticker = () => {
        const draft = stickerDraft
        if (!draft) return
        if (!draft.file) return setStickerMsg(t('stickerAddErrFile'))
        if (draft.label.trim() === '') return setStickerMsg(t('stickerAddErrLabel'))
        if (draft.when.trim() === '') return setStickerMsg(t('stickerAddErrWhen'))
        setStickerBusy(true)
        setStickerMsg('')
        const reader = new FileReader()
        reader.onerror = () => {
          setStickerBusy(false)
          setStickerMsg(`${t('error')}: ${t('stickerAddErrFile')}`)
        }
        reader.onload = () => {
          apiPost('/stickers/add', {
            label: draft.label.trim(),
            when: draft.when.trim(),
            note: draft.note.trim(),
            file: { name: draft.file.name, dataUrl: String(reader.result || '') },
          })
            .then(() => {
              setStickerDraft(null)
              setStickerMsg(t('stickerAddDone'))
              load()
            })
            .catch((error) => setStickerMsg(`${t('error')}: ${String(error.message ?? error)}`))
            .finally(() => setStickerBusy(false))
        }
        reader.readAsDataURL(draft.file)
      }

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
      // 添加表单：宿主把图落到表情包目录并追加 stickers.json，下一轮提示词就能看到。
      // 输入控件的点击要拦冒泡——卡片标题整行是折叠开关，不拦会「点保存顺便把卡片收起来」。
      const stickerField = (label, control, hint) =>
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
          h('span', { style: { ...S.muted, fontSize: 11.5 } }, label),
          control,
          hint ? h('span', { style: { ...S.muted, fontSize: 11, opacity: 0.75 } }, hint) : null)

      const stickerForm = stickerDraft === null
        ? null
        : h('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 10,
              marginBottom: 10,
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-l2)',
            },
          },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp,image/gif',
                ref: stickerFileRef,
                style: { display: 'none' },
                onChange: (event) => {
                  const picked = event.target.files && event.target.files[0]
                  // 前端先挡超大图：传上去也会被宿主退回，白等一次往返
                  if (picked && picked.size > 5 * 1024 * 1024) {
                    setStickerMsg(`${t('error')}: ${t('stickerAddFileHint')}`)
                    return
                  }
                  setStickerDraft((prev) => (prev ? { ...prev, file: picked || null } : prev))
                },
              }),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: (event) => {
                  event.stopPropagation()
                  if (stickerFileRef.current) stickerFileRef.current.click()
                },
              }, t('stickerAddPick')),
              h('span', {
                style: { ...S.muted, fontSize: 11.5 },
                children: stickerDraft.file ? stickerDraft.file.name : t('stickerAddNoFile'),
              }),
              h('span', {
                style: { ...S.muted, fontSize: 11, opacity: 0.75 },
                children: t('stickerAddFileHint'),
              }),
            ),
            stickerField(t('stickerAddLabel'), h('input', {
              value: stickerDraft.label,
              placeholder: t('stickerAddLabelPlaceholder'),
              onChange: (event) => {
                const next = event.target.value
                setStickerDraft((prev) => (prev ? { ...prev, label: next } : prev))
              },
              style: { ...S.input, fontSize: 12 },
            })),
            stickerField(t('stickerAddWhen'), h('input', {
              value: stickerDraft.when,
              placeholder: t('stickerAddWhenPlaceholder'),
              onChange: (event) => {
                const next = event.target.value
                setStickerDraft((prev) => (prev ? { ...prev, when: next } : prev))
              },
              style: { ...S.input, fontSize: 12 },
            }), t('stickerAddWhenHint')),
            stickerField(t('stickerAddNote'), h('input', {
              value: stickerDraft.note,
              placeholder: t('stickerAddNotePlaceholder'),
              onChange: (event) => {
                const next = event.target.value
                setStickerDraft((prev) => (prev ? { ...prev, note: next } : prev))
              },
              style: { ...S.input, fontSize: 12 },
            })),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                disabled: stickerBusy,
                style: { ...S.btn, opacity: stickerBusy ? 0.6 : 1 },
                onClick: (event) => {
                  event.stopPropagation()
                  submitSticker()
                },
              }, stickerBusy ? '…' : t('stickerAddSave')),
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: (event) => {
                  event.stopPropagation()
                  setStickerDraft(null)
                  setStickerMsg('')
                },
              }, t('stickerAddCancel')),
              h('span', { style: { ...S.muted, fontSize: 11 }, children: t('stickerAddHint') }),
            ),
          )

      const missing = stickerRows.filter((item) => !item.exists).length
      const stickerListBody = !stickers
        ? h('div', { style: S.muted, children: t('personaStickerNone') })
        : stickerRows.length === 0
          ? h('div', { style: S.muted, children: stickers.error || t('personaStickerNone') })
          : h('div', { style: { maxHeight: 260, overflow: 'auto' } },
              h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th }, t('colLabel')),
                  h('th', { style: S.th }, t('colStickerWhen')),
                  h('th', { style: S.th }, t('colPreview')),
                  h('th', { style: S.th }, ''))),
                h('tbody', null,
                  stickerRows.map((item) => h('tr', { key: item.id || item.file },
                    h('td', { style: S.td, children: item.label }),
                    h('td', { style: S.td, children: item.when }),
                    // 预览走宿主接口：浏览器读不了 ~/.dsh/stickers。
                    // 文件名留在 title/alt 里，悬停仍能看到是哪个文件。
                    h('td', { style: S.td },
                      item.exists
                        ? h('img', {
                            src: `${API}/sticker?file=${encodeURIComponent(item.file)}`,
                            alt: item.file,
                            title: item.file,
                            loading: 'lazy',
                            style: S.stickerThumb,
                          })
                        : h('span', { style: { ...S.mono, opacity: 0.75 }, children: item.file })),
                    h('td', { style: S.td },
                      h('span', { style: S.pill(item.exists ? 'ok' : 'warn') },
                        item.exists ? '✓' : t('personaStickerMissing'))))))))
      const stickersCard = card(
        t('personaStickers'),
        stickers
          ? `${t('personaStickerDir')} ${stickers.dir} · ${t('personaStickerLimit')} ${stickers.maxPerTurn}${missing > 0 ? ` · ${missing} 个${t('personaStickerMissing')}` : ''}`
          : t('personaStickerNone'),
        h('div', null,
          stickerForm,
          stickerMsg === ''
            ? null
            : h('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 8 }, children: stickerMsg }),
          stickerListBody),
        {
          key: 'stickers',
          expandable: true,
          open: openKeys.stickers,
          count: stickerRows.length,
          extra: h('button', {
            type: 'button',
            style: { ...S.btn, flexShrink: 0 },
            onClick: (event) => {
              // 拦冒泡：否则点「添加」会顺手触发标题行的折叠开关
              event.stopPropagation()
              setStickerMsg('')
              setStickerDraft((prev) => (prev ? null : { file: null, label: '', when: '', note: '' }))
              setOpenKeys((prev) => ({ ...prev, stickers: true }))
            },
          }, stickerDraft === null ? t('stickerAdd') : t('stickerAddCancel')),
        },
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

    // ── 检索日志与覆盖率（阶段 11）──────────────────────────────────────

    /**
     * 「检索」页：这周问过什么、哪些没答上、哪条被用得最多。
     *
     * 口径全部来自 `search_log_<uid>`（埋点本来就写，不额外请求 ES 之外的系统）；
     * 簇由后端按 `query_norm` 聚合，前端只负责展示与分档着色。
     * 呈现纪律：没有数据就显示「—」，不要把 0 当成"有人问过但没答案"。
     */
    function SearchLog({ t }) {
      const [days, setDays] = React.useState(7)
      const [state, setState] = React.useState({ loading: true, error: '', data: null })
      const load = React.useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: '' }))
        apiGet('/search-log', { days: String(days), limit: '50' })
          .then((data) => setState({ loading: false, error: '', data }))
          .catch((error) => setState({ loading: false, error: String(error.message ?? error), data: null }))
      }, [days])
      React.useEffect(() => {
        load()
      }, [load])

      const data = state.data
      const summary = data?.summary ?? null
      const value = (item) => (item === undefined || item === null ? t('noData') : String(item))
      const statusPill = (status) => {
        const tone = status === 'hit' ? 'ok' : 'warn'
        const label =
          { miss: t('slStatusMiss'), mixed: t('slStatusMixed'), low: t('slStatusLow'), hit: t('slStatusHit') }[status] ?? status
        return h('span', { style: S.pill(tone) }, label)
      }
      const head = (cells, width) =>
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: width,
            gap: 10,
            fontSize: 11,
            ...S.muted,
            padding: '6px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))',
          },
        }, cells.map((cell) => h('span', { key: cell }, cell)))
      const line = (key, cells, width) =>
        h('div', {
          key,
          style: {
            display: 'grid',
            gridTemplateColumns: width,
            gap: 10,
            fontSize: 12.5,
            padding: '6px 0',
            alignItems: 'center',
            color: 'var(--dsw-alias-label-primary)',
          },
        }, cells)

      const clusterTable = (rows, emptyText) =>
        rows.length === 0
          ? h('p', { style: { ...S.muted, fontSize: 12, margin: '6px 0' } }, emptyText)
          : h('div', null,
              head([t('colQuery'), t('colCount'), t('colLast'), t('colStatus')], '1fr 60px 150px 90px'),
              rows.map((item, index) =>
                line(`c-${index}-${item.key}`, [
                  h('span', { key: 'q', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                    item.query || item.key),
                  h('span', { key: 'n', style: S.mono }, String(item.count)),
                  h('span', { key: 'l', style: S.mono }, shortTime(item.lastAt)),
                  h('span', { key: 's' }, statusPill(item.status)),
                ], '1fr 60px 150px 90px'),
              ),
            )

      return h('div', null,
        h('div', { style: S.toolbar },
          h('div', { style: S.seg },
            [[7, t('slDays7')], [30, t('slDays30')], [90, t('slDays90')]].map(([value_, label]) =>
              h('button', {
                key: value_,
                type: 'button',
                style: S.segBtn(days === value_),
                onClick: () => setDays(value_),
              }, label),
            ),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: S.btn, onClick: load }, t('retry')),
        ),
        state.loading && data === null
          ? h('p', { style: S.muted }, t('loading'))
          : state.error
            ? h('p', { style: S.err }, `${t('error')}: ${state.error}`)
            : h('div', null,
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 } },
                  [
                    [t('slTotal'), summary?.total],
                    [t('slClusters'), summary?.clusters],
                    [t('slMiss'), summary?.miss],
                    [t('slLowCount'), (summary?.low ?? 0) + (summary?.mixed ?? 0)],
                  ].map(([label, number]) =>
                    h('div', { key: label, style: S.card },
                      h('div', { style: { ...S.muted, fontSize: 11 } }, label),
                      h('div', { style: { fontSize: 22, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, value(number)),
                    ),
                  ),
                ),
                h('div', { style: S.card },
                  h('h3', { style: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 } }, t('slMissingTitle')),
                  clusterTable(data?.missing ?? [], t('slEmpty')),
                ),
                h('div', { style: S.card },
                  h('h3', { style: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 } }, t('slTopTitle')),
                  (data?.topMemories ?? []).length === 0
                    ? h('p', { style: { ...S.muted, fontSize: 12, margin: '6px 0' } }, t('slEmpty'))
                    : h('div', null,
                        head([t('colMemory'), t('colCount'), t('colContent')], '110px 60px 1fr'),
                        (data?.topMemories ?? []).map((item, index) =>
                          line(`t-${index}`, [
                            h('span', { key: 'm', style: S.mono }, String(item.memory_id ?? '').slice(0, 8)),
                            h('span', { key: 'c', style: S.mono }, String(item.count)),
                            h('span', {
                              key: 'p',
                              style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                            }, item.preview || t('noData')),
                          ], '110px 60px 1fr'),
                        ),
                      ),
                ),
                h('div', { style: S.card },
                  h('h3', { style: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 } }, t('slLowTitle')),
                  clusterTable(data?.low ?? [], t('slEmpty')),
                ),
                h('div', { style: S.card },
                  h('h3', { style: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 } }, t('slRecentTitle')),
                  (data?.recent ?? []).length === 0
                    ? h('p', { style: { ...S.muted, fontSize: 12, margin: '6px 0' } }, t('slEmpty'))
                    : h('div', null,
                        head([t('colLast'), t('colQuery'), t('colHitsN'), t('colMs'), t('colNote')], '150px 1fr 60px 70px 110px'),
                        (data?.recent ?? []).map((item, index) =>
                          line(`r-${index}`, [
                            h('span', { key: 'a', style: S.mono }, shortTime(item.at)),
                            h('span', { key: 'q', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.query),
                            h('span', { key: 'h', style: S.mono }, String(item.hits)),
                            h('span', { key: 'm', style: S.mono }, item.ms > 0 ? String(item.ms) : t('noData')),
                            h('span', { key: 'n', style: S.mono }, item.note),
                          ], '150px 1fr 60px 70px 110px'),
                        ),
                      ),
                  h('p', { style: { ...S.muted, fontSize: 11, margin: '8px 0 0' } }, t('slLegacyHint')),
                ),
              ),
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
      // 阶段 9：隔离条目可以在面板上直接恢复（只能让模型用工具恢复的话，审完也处理不掉）
      const [restoreBusy, setRestoreBusy] = React.useState(false)
      const [restoreResult, setRestoreResult] = React.useState(null)
      // 阶段 11：反查「这条记忆被哪些检索命中过」（按需拉，不随列表一起取）
      const [usedIn, setUsedIn] = React.useState(null)
      // 阶段 11 批 B：👍/👎 结果提示（成功/失败都显示，避免「点了没反应」）
      const [feedbackResult, setFeedbackResult] = React.useState(null)
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

      // 详情换了一条就清掉上一条的反查结果，避免张冠李戴
      React.useEffect(() => {
        setUsedIn(null)
        setFeedbackResult(null)
      }, [selected === null ? '' : selected.esId])

      const doRestore = () => {
        if (!selected || restoreBusy) return
        setRestoreBusy(true)
        apiPost('/memories/restore', { esId: selected.esId, scope: selected.scope })
          .then((value) => {
            setRestoreResult({
              ok: true,
              text: value?.embeddingMissing ? t('restoreDoneNoVector') : t('restoreDone'),
            })
            setSelected(null)
            load()
          })
          .catch((error) => setRestoreResult({ ok: false, error: String(error.message ?? error) }))
          .finally(() => setRestoreBusy(false))
      }

      const doFeedback = (verdict) => {
        if (!selected) return
        apiPost('/memories/feedback', { esId: selected.esId, verdict, scope: selected.scope })
          .then((value) => {
            setFeedbackResult({ ok: true, text: `${t('fbDone')} · ${value?.verdict ?? verdict}` })
            // 本地先加一，避免整页刷新；下次 load 会以 ES 为准
            setSelected((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    confirmedUse: (prev.confirmedUse ?? 0) + (verdict === 'useful' ? 1 : 0),
                    corrections: (prev.corrections ?? 0) + (verdict === 'wrong' ? 1 : 0),
                  },
            )
          })
          .catch((error) => setFeedbackResult({ ok: false, error: String(error.message ?? error) }))
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
            h('option', { value: 'quarantine' }, t('statusQuarantine')),
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
                      // 搜索时补一行「命中在哪、命中了什么词」——这是 P1 要的理由
                      row.highlights !== undefined && row.highlights.length > 0
                        ? h('div', { style: { ...S.rowMeta, paddingTop: 0 } },
                            h('span', { style: { ...S.muted, fontSize: 11.5 } },
                              `${t('hitIn')} ${row.highlights[0].field === 'topic_key' ? t('fieldTopic') : t('fieldContent')}：`),
                            h(HighlightText, {
                              text: row.highlights[0].text,
                              style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                            }),
                            row.score === undefined
                              ? null
                              : h('span', { style: { ...S.mono, ...S.muted, fontSize: 11, flex: 'none' } }, ` · ${row.score}`),
                          )
                        : null,
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
                  [t('colOrigin'), selected.origin || '-'],
                  ['confirmed_use / corrections',
                    `${selected.confirmedUse ?? 0} / ${selected.corrections ?? 0}`],
                  ['feedback_at', selected.feedbackAt ? shortTime(selected.feedbackAt) : t('fbEmpty')],
                  ['promote_state', selected.promoteState || '-'],
                  ...(selected.status === 'quarantine'
                    ? [[t('quarantineReason'), selected.quarantineReason || t('quarantineNoReason')]]
                    : []),
                  [t('colUpdated'), shortTime(selected.updatedAt)],
                ].map(([label, value]) =>
                  h('div', { key: label, style: { display: 'flex', gap: 6 } },
                    h('span', { style: { ...S.muted, minWidth: 110 } }, label),
                    h('span', { style: S.mono }, String(value ?? '-')),
                  ),
                ),
              ),
              restoreResult
                ? h('div', {
                    style: {
                      marginTop: 8,
                      fontSize: 12,
                      color: restoreResult.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)',
                    },
                  }, restoreResult.ok ? restoreResult.text : `${t('error')}: ${restoreResult.error}`)
                : null,
              h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
                h(CopyButton, { text: selected.content, t, label: t('copyContent') }),
                h(CopyButton, { text: selected.id, t, label: t('copyId') }),
                selected.status === 'quarantine'
                  ? h('button', {
                      type: 'button',
                      style: { ...S.btn, opacity: restoreBusy ? 0.6 : 1 },
                      disabled: restoreBusy,
                      onClick: doRestore,
                    }, restoreBusy ? '…' : t('restoreBtn'))
                  : null,
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    apiGet('/search-log/used-in', { memory_id: selected.id })
                      .then((value) => setUsedIn(value))
                      .catch((error) => setUsedIn({ rows: [], error: String(error.message ?? error) }))
                  },
                }, t('slUsedIn')),
                // 阶段 11 批 B：只有个人库能反馈（团队库的正确性归审核台）
                selected.scope === 'personal'
                  ? h('button', { type: 'button', style: S.btn, onClick: () => doFeedback('useful') }, t('fbUseful'))
                  : null,
                selected.scope === 'personal'
                  ? h('button', { type: 'button', style: S.btn, onClick: () => doFeedback('wrong') }, t('fbWrong'))
                  : null,
              ),
              feedbackResult
                ? h('div', {
                    style: {
                      marginTop: 8,
                      fontSize: 12,
                      color: feedbackResult.ok
                        ? 'var(--dsw-alias-label-secondary)'
                        : 'var(--dsw-alias-state-error-primary)',
                    },
                  }, feedbackResult.ok ? feedbackResult.text : `${t('error')}: ${feedbackResult.error}`)
                : null,
              usedIn
                ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                    usedIn.error
                      ? `${t('error')}: ${usedIn.error}`
                      : (usedIn.rows ?? []).length === 0
                        ? t('slUsedInEmpty')
                        : [
                            h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 4 } },
                              `${t('slUsedIn')}（${usedIn.rows.length}）`),
                            ...usedIn.rows.slice(0, 10).map((item, index) =>
                              h('div', { key: `u-${index}`, style: { ...S.mono, fontSize: 11.5, lineHeight: 1.7 } },
                                `${shortTime(item.at)} · ${item.query} · ${item.hits} 条`),
                            ),
                          ],
                  )
                : null,
            )
          : null,
      )
    }

    // ── 页面主体 ─────────────────────────────────────────────────────────

    /**
     * 记忆库主体。
     *
     * `mode` 决定这一页看哪一块（阶段 8 面板搬家）：
     *  - `main`（主区全局面板）：看东西的地方——概览 / 记忆浏览 / 审核台 / 自述 / 人格；
     *  - `settings`（设置里的「记忆库」节）：改东西的地方——配置 / 维护。
     * 两边共用同一份组件与同一套数据接口，只是页签不同，所以搬动没有第二套实现。
     */
    function MemoryPanel({ t, onStatus }) {
      const [tab, setTab] = React.useState('overview')
      // 工具条要显示 ES 状态与版本：由这里回报（它本来就要拉 overview），
      // 用 ref 存回调，免得把 onStatus 塞进 loadOverview 的依赖里导致重复请求。
      const statusRef = React.useRef(onStatus)
      statusRef.current = onStatus
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
          .then((data) => {
            setOverview({ loading: false, error: '', data })
            statusRef.current?.({ reachable: Boolean(data.es?.reachable), version: data.version })
          })
          .catch((error) => {
            setOverview({ loading: false, error: String(error.message ?? error), data: null })
            statusRef.current?.({ reachable: false, version: '' })
          })
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

      return h('div', { style: S.wrapMain },
        h('div', { style: S.tabs, [TABS_ATTR]: '' },
          [
            ['overview', t('tabOverview')],
            ['browse', t('tabBrowse')],
            ['searchlog', t('tabSearchLog')],
            ['graph', t('tabGraph')],
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
          : tab === 'searchlog'
          ? h(SearchLog, { t })
          : tab === 'graph'
          ? h(GraphView, { t })
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

    // ── 主区外壳（阶段 8：整页搬到主区）─────────────────────────────────

    /** 侧栏面板 id：同时用作 `main` 的 key 与 `sidebar.panellist` 的 id，两者必须一致。 */
    const PANEL_ID = 'memory-es'

    /** 主区外壳上的标记属性：样式钩子，也方便排查时在 DOM 里认出来。 */
    const WORKSPACE_ATTR = 'data-memory-workspace'
    /** 页签条的标记属性：主区里让它滚动时粘住顶部（设置在设置页里不粘）。 */
    const TABS_ATTR = 'data-memory-tabs'
    const WORKSPACE_STYLE_ID = 'dsh-memory-es-workspace-style'

    /**
     * 主区外壳的底色（注入一次）。
     *
     * 为什么不用 `--dsw-alias-bg-base`：皮肤会把这个 token 改成「不是实色」——
     * orca-link 在亮色主题下把它设成 `#faf7f13d`（24% alpha），暗色主题下设成 `initial`
     * （自定义属性取 initial 等于未定义 → `background: var(--dsw-alias-bg-base)` 整条声明失效）。
     * 两种情况下主区都会透出皮肤的插画背景，正文压在漫画上根本看不清（2026-11-01 在 test 实例上复现）。
     *
     * 办法：拿 DSH 的静态中性色（皮肤没有改这两个）当画布，按明暗主题各取一档。
     * 亮色是纯白、暗色是 #151517，与侧栏一致；比跟着皮肤转透明更能保证可读性。
     * 想以后跟随皮肤？改这一个常量即可，别再回到 `--dsw-alias-bg-*`。
     */
    const WORKSPACE_CSS = [
      `[${WORKSPACE_ATTR}] { background-color: var(--dsw-static-neutral-bluish-00, #fff); }`,
      `body[data-ds-dark-theme] [${WORKSPACE_ATTR}] { background-color: var(--dsw-static-neutral-bluish-950, #151517); }`,
      // 页签在主区滚动时粘顶：底色必须与画布同色，否则内容会从下面透上来。
      `[${WORKSPACE_ATTR}] [${TABS_ATTR}] { position: sticky; top: 0; z-index: 2; background-color: var(--dsw-static-neutral-bluish-00, #fff); }`,
      `body[data-ds-dark-theme] [${WORKSPACE_ATTR}] [${TABS_ATTR}] { background-color: var(--dsw-static-neutral-bluish-950, #151517); }`,
    ].join('\n')

    /**
     * 主区壳：官方全局面板骨架 + 「返回会话」。
     *
     * 回滚方式：摘掉 `main` 那一组注册即可，设置里的「记忆库」节一行没动、照旧可用。
     */
    function MemoryWorkspace({ t, close }) {
      // 工具条上的状态徽标：由 MemoryPanel 在 overview 拉回来后回报。
      // 不在这里自己再拉一次——overview 是重查询，重复发一遍只为了让标题栏显示两个字段不划算。
      const [status, setStatus] = React.useState(null)
      return h('div', { style: S.workspace, [WORKSPACE_ATTR]: '' },
        h('div', { style: S.topbar },
          typeof close === 'function'
            ? h('button', { type: 'button', style: S.backLink, onClick: close },
                h('span', { style: { ...S.backChevron, 'aria-hidden': 'true' } }, '‹'),
                t('backToConversation'),
              )
            : null,
          typeof close === 'function' ? h('span', { style: S.topbarDivider }) : null,
          h('h1', { style: S.topbarTitle }, t('sectionLabel')),
          h('span', { style: S.topbarSpacer }),
          status
            ? h('span', { style: S.pill(status.reachable ? 'ok' : 'warn') },
                status.reachable ? t('esOk') : t('esDown'))
            : null,
          status && status.version ? h('span', { style: S.topbarMeta }, `v${status.version}`) : null,
        ),
        h('div', { style: S.workspaceScroll },
          h('div', { style: S.workspaceContent },
            h(MemoryPanel, { t, onStatus: setStatus }),
          ),
        ),
      )
    }

    /** 侧栏图标：数据库圆柱 + 底部那颗金点（与 panel/icon.svg 同一个记号，跟随 currentColor）。 */
    function MemoryIcon({ size = 18 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('ellipse', { cx: 12, cy: 5.5, rx: 6.5, ry: 2.6 }),
        h('path', { d: 'M5.5 5.5v6c0 1.44 2.91 2.6 6.5 2.6s6.5-1.16 6.5-2.6v-6' }),
        h('path', { d: 'M5.5 11.5v6c0 1.44 2.91 2.6 6.5 2.6s6.5-1.16 6.5-2.6v-6', opacity: 0.72 }),
        h('circle', { cx: 12, cy: 17.6, r: 1.25, fill: 'currentColor', stroke: 'none' }),
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

        // 主区外壳的底色样式：注入一次，卸载时摘掉（见 WORKSPACE_CSS 的说明）
        ctx.effect(() => {
          if (typeof document === 'undefined') return
          if (document.getElementById(WORKSPACE_STYLE_ID) !== null) return
          const style = document.createElement('style')
          style.id = WORKSPACE_STYLE_ID
          style.textContent = WORKSPACE_CSS
          document.head.appendChild(style)
          return () => style.remove()
        })

        // 主区全局面板 + 侧栏入口（order 31：紧跟 dsh-mnemon 的「记忆系统」30）
        //
        // 用 `slots.inject('main')` 等槽位，而不是先 `ctx.get('layout')` 判一下：
        // layout 服务由 ui-layout 插件在它自己的 apply 里 provide，和本插件没有依赖关系，
        // 谁先跑不定 —— 2026-11-01 实测这里 ctx.get 拿到 undefined，整组注册被跳过，
        // 页面上就只剩设置里那节、侧栏没有入口。槽位存在意味着布局已经装好，
        // 这比服务查询更能表达「我要的是一个能挂面板的布局」。
        //
        // close 用惰性取值：点按钮那一刻 layout 必然已在，取不到就当没有返回按钮。
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ close: () => ctx.get('layout')?.selectPanel(null) }),
          }, MemoryWorkspace)
          const stopIcon = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 31,
            label: () => t('sectionLabel'),
            locale: NS,
          }, MemoryIcon)
          return () => {
            stopIcon?.()
            stopMain()
          }
        })))
      },
    }
  },
})
