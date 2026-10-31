/**
 * 系统提示片段：告诉模型「记忆库里有什么、什么时候存、什么时候查、怎么改」。
 *
 * 位置选择：`order = 3200`，落在宿主的工具引导区间（各 `TOOL_*` 是 1000~3000、`MCP_SERVERS` 3100）
 * **之后**、生成的工具 SDK 块（`TOOLS_SDK` 5000）**之前**。理由：这段讲的是「怎么用 memory_* 这几个工具」，
 * 跟工具引导同类；放在 SDK 之前，模型先读到策略再读到函数签名。
 *
 * 硬约束：**正文里不能出现 `{{` / `}}`**——宿主会对段文本做变量插值，未知引用会让整个提示词组装失败
 * （失败方式是「模型连启动都收不到提示词」，不是少一句话）。有测试守着这一条。
 *
 * @module dsh-memory-es/prompt
 */

/** 段名：全局唯一，重复注册会抛 */
export const PROMPT_SECTION_NAME = 'dsh-memory-es'

/** 见文件头的排序理由 */
export const PROMPT_SECTION_ORDER = 3200

export const MEMORY_PROMPT = [
  '## 记忆库（dsh-memory-es）',
  '',
  '你有一个跨会话的记忆库：个人库（本部署可见）与团队知识库，用 `memory_search` 查、`memory_save` 存。',
  '',
  '**什么时候存**：用户明确要求记住；做了一个非显然的决定（尤其是被否掉的方案与原因）；踩到可复现的坑；约定、口径或路径发生变化。',
  '**什么时候不存**：临时进度、会话摘要、能从代码或文档直接读到的东西、凭证与个人隐私。',
  '**一条一句**：`content` 写一句可独立成立的事实，不要贴整段对话；相同内容重复存会命中去重，不会产生第二份。',
  '',
  '**什么时候查**：动手前查「这个项目以前怎么定的」；用户提到「之前说过 / 记过」；遇到似曾相识的报错。',
  '**别反复查**：同一个问题最多查一次，拿到结果就往前走；查不到就问人，不要凭印象编。',
  '',
  '**修正而不是覆盖**：记忆过时了就用 `memory_update_status`——被新版本取代用 `supersede`（要给出新版本 id），',
  '已经作废用 `expire`，涉及个人隐私用 `mark_private`。不要靠重复写同内容来「覆盖」，那只会命中去重。',
  '',
  '**团队化要克制**：只有确实对别人有用的经验（接口契约、踩坑、口径）才用 `memory_promote` 标候选；',
  '它只是标记，不会直接进团队库——去重与敏感扫描由整理任务负责。',
  '',
  '**文档另有一套**：`doc_search` 查个人文档库（方案、复盘、开发文档等长文），结果按文档聚合、带命中的小节路径与片段；',
  '`memory_search` 只返回「一句事实」。要查「某个项目的方案细节 / 踩坑记录」时先用 `doc_search`。',
].join('\n')

/**
 * 心情段：紧跟记忆段之后（3201）。
 *
 * `text` 是**函数**而不是常量——心情随时间衰减，每次组装提示词都要求值。
 * 平静时返回空串，宿主会把空段丢掉，等于不注入。
 */
export const MOOD_SECTION_NAME = 'dsh-memory-es-mood'
export const MOOD_SECTION_ORDER = 3201

/** 注册用的段对象（形状对齐宿主的 `PromptSection`） */
export const MEMORY_PROMPT_SECTION = {
  name: PROMPT_SECTION_NAME,
  order: PROMPT_SECTION_ORDER,
  text: MEMORY_PROMPT,
} as const

/**
 * 阶段 9.1：人格段（内核）。
 *
 * 排在记忆段**之前**（3199）：先讲「我是谁、用什么口吻」，再讲「我知道什么」。
 * 反过来的话，模型容易把人格读成检索结果的一部分。
 *
 * `text` 写成函数：配置热重载后下一轮就能拿到新 seed，不必重启进程。
 * 空段返回空串，宿主会整段丢掉——**不要**注入一个只有标题的空壳。
 */
export const PERSONA_SECTION_NAME = 'dsh-memory-es-persona'
export const PERSONA_SECTION_ORDER = 3199

/**
 * 宿主会对段文本做变量插值，正文里出现 `{{` / `}}` 会让整个提示词组装失败
 * （失败方式是「模型收不到任何提示词」，不是少一句话——见文件头）。
 * seed 是部署者手写的自由文本，这里把它换成全角括号兜住。
 */
function escapeBraces(text: string): string {
  return text.replaceAll('{{', '｛｛').replaceAll('}}', '｝｝')
}

/**
 * 组装人格段：内核 seed + 已生效的表层条目（阶段 9.3）。
 *
 * 两层缺一不可判断：都空时整段不注入（不产生只有标题的空壳）；
 * 只有一层时也要正常输出——比如部署者没写 seed、但已经审过几条学到的倾向。
 */
export function buildPersonaSection(
  seed: string,
  enabled: boolean,
  entries: readonly string[] = [],
): string {
  if (!enabled) return ''
  const body = escapeBraces(seed.trim())
  const list = entries.map((e) => e.trim()).filter((e) => e !== '')
  if (body === '' && list.length === 0) return ''

  const parts = ['# 我的人格']
  if (body !== '') parts.push(body)
  if (list.length > 0) {
    // 表层标注来源，免得和内核混成一团、也方便你上溯是哪次审核放进来的
    parts.push(`## 我学到的倾向\n\n${list.map((e) => `- ${escapeBraces(e)}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * 阶段 9.2：表情包段。
 *
 * 放在心情段之后（3202）：它是「怎么说话」的装饰，排在人格与记忆之后即可。
 *
 * **图片不进仓库**：`dir` 由部署者给（默认 `~/.dsh/stickers`），里面放 `stickers.json`
 * 与图片。解析失败一律当「没有表情包」，返回空串——装饰能力不能影响启动。
 */
export const STICKERS_SECTION_NAME = 'dsh-memory-es-stickers'
export const STICKERS_SECTION_ORDER = 3202

export interface StickerItem {
  id: string
  label: string
  /** 相对 `dir` 的文件路径 */
  file: string
  /** 什么时候用（给模型看的判断依据） */
  when: string
}

export interface StickerPack {
  dir: string
  items: StickerItem[]
}

/**
 * 解析 `stickers.json`。结构不对返回 null。
 *
 * 逐项校验而不是整体信任：少一个 `when` 就少一个判断依据，宁可丢掉那一张，
 * 也不要把半截信息喂给模型（它会照着错误描述乱贴）。
 */
export function parseStickerPack(json: string, dir: string): StickerPack | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rawItems = (parsed as { items?: unknown }).items
  if (!Array.isArray(rawItems)) return null

  const items: StickerItem[] = []
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    const file = typeof r.file === 'string' ? r.file.trim() : ''
    const when = typeof r.when === 'string' ? r.when.trim() : ''
    if (id === '' || label === '' || file === '' || when === '') continue
    items.push({ id, label, file, when })
  }
  if (items.length === 0) return null
  return { dir, items }
}

/** 把目录与相对路径拼成绝对路径（不做 fs 校验——提示段里只负责给出路径文本） */
function joinPath(dir: string, file: string): string {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return `${base}/${file}`
}

export function buildStickersSection(
  pack: StickerPack | null,
  maxPerTurn: number,
  enabled: boolean,
): string {
  if (!enabled || pack === null || pack.items.length === 0) return ''
  const lines = [
    '## 表情包',
    '',
    `我有一套表情包可用。**一次回复最多贴 ${maxPerTurn} 张**；只在情绪真的到了的时候贴`
      + '（事情做成了、想鼓励对方、想撒个娇、要道歉、被夸了）。'
      + '代码、命令、报错信息和**技术结论旁边不要贴**；拿不准就不贴。',
    '',
    '贴法：在回复最后**单独占一行**，原样写下面对应的整行（路径连尖括号一起复制，不要改写、不要自己拼）：',
    '',
  ]
  for (const item of pack.items) {
    lines.push(`- ${item.label}｜${item.when} → ![${item.label}](<${joinPath(pack.dir, item.file)}>)`)
  }
  return escapeBraces(lines.join('\n'))
}
