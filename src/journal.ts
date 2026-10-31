/**
 * 阶段 9.5：每日回顾（「日记」里记日子的那部分）。
 *
 * 与 `persona.ts` 的分工（别混）：
 *  - persona：从「我说过什么 + 你纠正过什么」归纳**我的倾向** → 改行为，必须人工审核；
 *  - journal：把**某一天**的对话压成一段回顾 → 只是记录，不改行为，直接生效。
 *
 * 所以 journal 不进审核队列，也不该被当成记忆证据参与检索排序（面板单独一栏看）。
 * 存储用 `memory_id = journal-<YYYY-MM-DD>`，同一天重复跑是覆盖而不是追加。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { EsClient } from './es/http.ts'
import { personalIndexFor } from './memory/common.ts'

export const JOURNAL_MEMORY_TYPE = 'journal'
/** 一段回顾的字符上限（模型偶尔会写长，截断而不是丢） */
export const JOURNAL_MAX_CHARS = 2400
/** 素材少于这么多轮，不值得为它调一次模型 */
export const JOURNAL_MIN_TURNS = 3
/** 喂给模型的最大轮数（超了取最近的） */
export const JOURNAL_MAX_TURNS = 80
const USER_MAX = 400
const ASSISTANT_MAX = 500

export interface DayTurn {
  session: string
  user: string
  assistant: string
  at: number
}

export interface JournalDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'search'>
  writer: Pick<EsClient, 'index'>
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}

/** `YYYY-MM-DD` → 当地时区的当天毫秒区间（左闭右开） */
export function dayRange(date: string): { start: number; end: number } {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10))
  return {
    start: new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    end: new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime(),
  }
}

/** 本地时区的 `YYYY-MM-DD`（不用 toISOString：那是 UTC，凌晨会串天） */
export function dateKey(at: Date): string {
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function joinTextBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type !== 'text') continue
    if (typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/**
 * 从一份已解压的会话日志里抽「当天的对话配对」。
 *
 * 配对方向与 persona 相反：这里是**用户先说、我后答**（日记关心"今天发生了什么"），
 * 所以先挂住用户那半句，等我的回复来了再配对。工具调用不打断配对。
 * 行上的 `time` 才是准的，文件 mtime 只用于粗筛。
 */
export function extractDayTurns(
  logText: string,
  sessionId: string,
  start: number,
  end: number,
): DayTurn[] {
  const out: DayTurn[] = []
  let pendingUser: string | null = null
  let pendingAt = 0

  for (const line of logText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const type = rec.type
    if (typeof type !== 'string') continue
    const at = typeof rec.time === 'number' ? rec.time : 0
    const data = (rec.data ?? {}) as Record<string, unknown>

    if (type === 'user/message') {
      // 系统注入（runtime context、技能说明）不是人说的话
      const source = (data.source ?? {}) as Record<string, unknown>
      if (source.kind !== 'user') continue
      if (at < start || at >= end) continue
      // ⚠️ 两类消息结构不对称（实测）：user/message 的正文在 data.content，
      // assistant/message 才包一层 data.message.content。写错就是「一条都取不到」。
      const text = joinTextBlocks(data.content)
      if (text === '') continue
      // 子代理/巡检任务会以 "[dsh-mnemon:delegated review] …" 这类标记走 user/message，
      // 它不是人说的话，进日记会把总结带偏（实测 10-30 的首条就是它）
      if (/^\[[a-zA-Z0-9_-]+:/.test(text)) continue
      pendingUser = text
      pendingAt = at
      continue
    }

    if (type === 'assistant/message') {
      if (pendingUser === null) continue
      if (at < start || at >= end) continue
      const message = (data.message ?? {}) as Record<string, unknown>
      const text = joinTextBlocks(message.content)
      if (text === '') continue
      out.push({
        session: sessionId,
        user: pendingUser.slice(0, USER_MAX),
        assistant: text.slice(0, ASSISTANT_MAX),
        at: pendingAt,
      })
      pendingUser = null
    }
  }
  return out
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** 解压一份会话日志（与 persona.ts 同样用系统 zstd：多帧必须全解） */
function readLog(file: string): string {
  try {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
  } catch {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
}

/**
 * 收集某一天的全部对话。
 *
 * 用文件 mtime 预筛：mtime 早于当天开始的文件不可能含当天消息，直接跳过，
 * 免得每次都把几个月的会话全解一遍。
 */
export function collectDayTurns(
  root = join(homedir(), '.dsh', 'sessions'),
  date: string,
  options: { maxTurns?: number } = {},
): { date: string; turns: DayTurn[]; sessions: number } {
  const { start, end } = dayRange(date)
  const maxTurns = options.maxTurns ?? JOURNAL_MAX_TURNS
  const base = expandHome(root)
  const turns: DayTurn[] = []
  let sessions = 0
  if (!existsSync(base)) return { date, turns, sessions }

  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(full, depth + 1)
        continue
      }
      if (name !== 'session.v4.jsonl.zstd') continue
      if (st.mtimeMs < start) continue
      const text = readLog(full)
      if (text === '') continue
      const sessionId = full.split('/').slice(-2, -1)[0] ?? name
      const found = extractDayTurns(text, sessionId, start, end)
      if (found.length > 0) sessions += 1
      turns.push(...found)
    }
  }
  walk(base, 1)

  turns.sort((a, b) => a.at - b.at)
  return {
    date,
    // 太长就取最近的：日记要的是"今天最后推进到哪"，不是从头复述
    turns: turns.length > maxTurns ? turns.slice(-maxTurns) : turns,
    sessions,
  }
}

export const JOURNAL_SYSTEM = `你是一位工程助手的工作日志记录者。根据给定日期里用户与助手的对话片段，写一段当天的回顾。

要求：
- 中文，200~600 字；信息少就写短，不要凑字数。
- 写「今天推进了什么、卡在哪、定了什么结论」，不要按时间顺序复述每条消息。
- 有明确决定、踩过的坑、被否掉的方案就写出来；没有就直说今天没什么进展。
- 语气像写给自己的备忘，不是给领导看的汇报。
- 直接输出正文，不要标题、不要 Markdown 代码块、不要分点符号。

只输出回顾正文。`

/** 组装提示词。片段按时间正序，带序号便于模型说"第三步卡住" */
export function buildJournalPrompt(date: string, turns: readonly DayTurn[]): string {
  const lines: string[] = [`【日期】${date}`, `【对话轮数】${turns.length}`, '', '【对话片段】']
  turns.forEach((turn, index) => {
    const hhmm = new Date(turn.at).toTimeString().slice(0, 5)
    lines.push(`### [${index}] ${hhmm}`)
    lines.push(`【用户】${turn.user}`)
    lines.push(`【助手】${turn.assistant}`)
    lines.push('')
  })
  return lines.join('\n')
}

/** 模型输出就是正文：去围栏、去空行头尾，超长截断 */
export function parseJournalOutput(text: string): string | null {
  let body = text.trim()
  if (body === '') return null
  const fence = body.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fence) body = fence[1].trim()
  if (body.startsWith('[诊断]')) return null
  if (body.length > JOURNAL_MAX_CHARS) body = `${body.slice(0, JOURNAL_MAX_CHARS)}…`
  return body === '' ? null : body
}

/** 同一天固定一个 id：重跑覆盖，不会攒出一堆重复日记 */
export function journalMemoryId(date: string): string {
  return `journal-${date}`
}

export async function writeJournal(
  deps: JournalDeps,
  date: string,
  content: string,
): Promise<{ written: boolean; memory_id: string }> {
  const now = deps.now?.() ?? new Date()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const memoryId = journalMemoryId(date)
  const { start } = dayRange(date)
  const doc: Record<string, unknown> = {
    memory_id: memoryId,
    user_id: deps.userId,
    // 日记是「记录」，不是「证据」：不参与检索排序，panel 单独一栏读
    content,
    memory_type: JOURNAL_MEMORY_TYPE,
    domain: 'general',
    privacy: 'private',
    importance: 'low',
    status: 'active',
    promote_state: 'none',
    distill_state: 'journal',
    review_state: 'auto',
    created_at: new Date(start).toISOString(),
    updated_at: now.toISOString(),
    day: date,
  }
  // 用 id 覆盖写：同一天重跑是更新，不是新增一条
  await deps.writer.index(index, doc, { id: memoryId, refresh: 'wait_for' })
  deps.log?.({ event: 'journal.write', date, chars: content.length })
  return { written: true, memory_id: memoryId }
}

/** 某天是否已经写过（据此避免重复调模型） */
export async function hasJournal(deps: JournalDeps, date: string): Promise<boolean> {
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  try {
    const result = await deps.reader.search(index, {
      size: 1,
      query: { bool: { filter: [{ term: { memory_id: journalMemoryId(date) } }] } },
      _source: ['memory_id'],
    })
    return (result.hits ?? []).length > 0
  } catch {
    // 查不到就当没写过：重复写是覆盖，不会脏数据
    return false
  }
}

export async function readJournals(
  deps: JournalDeps,
  limit = 30,
): Promise<Array<{ date: string; content: string; updatedAt: string }>> {
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const result = await deps.reader.search(index, {
    size: limit,
    _source: ['memory_id', 'content', 'created_at', 'updated_at', 'day'],
    sort: [{ created_at: 'desc' }],
    query: { bool: { filter: [{ term: { memory_type: JOURNAL_MEMORY_TYPE } }] } },
  })
  return (result.hits ?? []).map((hit) => {
    const source = (hit.source ?? {}) as Record<string, unknown>
    const day = typeof source.day === 'string' && source.day !== ''
      ? source.day
      : String(source.created_at ?? '').slice(0, 10)
    return {
      date: day,
      content: typeof source.content === 'string' ? source.content : '',
      updatedAt: typeof source.updated_at === 'string' ? source.updated_at : '',
    }
  })
}

export interface JournalRunDeps extends JournalDeps {
  summarize: (prompt: string, system: string) => Promise<string>
  /** `HH:MM`，到点后才跑；过了点补跑也认（当天只跑一次） */
  at: string
  root?: string
}

/**
 * 到点就跑一次当天的回顾。
 *
 * 幂等靠 `day`：同一天已经写过就直接返回，不会重复调模型。
 * 由 index.ts 每小时调一次（不精确到分钟也没关系——日记不是定时任务）。
 */
export async function maybeRunDailyJournal(
  deps: JournalRunDeps,
  now = new Date(),
): Promise<{ ran: boolean; reason: string; date?: string; chars?: number }> {
  const date = dateKey(now)
  const [hh, mm] = deps.at.split(':').map((part) => Number.parseInt(part, 10))
  const dueAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 23, mm || 30, 0, 0)
  if (now.getTime() < dueAt.getTime()) return { ran: false, reason: 'not-due' }

  if (await hasJournal(deps, date)) return { ran: false, reason: 'already-done', date }

  const { turns, sessions } = collectDayTurns(deps.root, date)
  if (turns.length < JOURNAL_MIN_TURNS) {
    return { ran: false, reason: `too-few-turns(${turns.length}/${sessions})`, date }
  }
  const raw = await deps.summarize(buildJournalPrompt(date, turns), JOURNAL_SYSTEM)
  const content = parseJournalOutput(raw)
  if (content === null) return { ran: false, reason: 'empty-summary', date }
  await writeJournal(deps, date, content)
  return { ran: true, reason: 'ok', date, chars: content.length }
}

/** 工具 `memory_journal`：手动补跑某一天（默认昨天） */
export function defineJournalTool(deps: {
  journal: () => JournalRunDeps | null
  summarize?: (prompt: string, system: string) => Promise<string>
}) {
  return defineTool({
    name: 'memory_journal',
    description:
      '把某一天的对话压成一段回顾，写进记忆库（memory_type=journal），并在面板「人格 → 日记」的「每日回顾」栏显示。默认补跑昨天。已存在的同一天会覆盖，不会重复。',
    parameters: {
      date: {
        type: 'string',
        description: '要回顾的日期 YYYY-MM-DD；留空 = 昨天。',
      },
      dry_run: {
        type: 'boolean',
        description: 'true = 只取素材并生成，不写库（默认 false）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          date: { type: 'string', required: true },
          turns: { type: 'number' },
          sessions: { type: 'number' },
          chars: { type: 'number' },
          dryRun: { type: 'boolean' },
          memory_id: { type: 'string' },
          content: { type: 'string' },
          error: { type: 'string' },
          rawPreview: { type: 'string' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text?: string }) => [
        { type: 'text', text: typeof value.text === 'string' ? value.text : '' },
      ],
    },
    timeoutMs: 180_000,
    async execute(args: Record<string, unknown>) {
      const raw = typeof args.date === 'string' ? args.date.trim() : ''
      const target = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? raw
        : dateKey(new Date(Date.now() - 24 * 3600 * 1000))
      const runDeps = deps.journal()
      if (runDeps === null) {
        return {
          ok: false,
          date: target,
          error: 'journal 未启用或拿不到模型',
          text: '每日回顾未启用（配置 journal.enabled=false）',
        }
      }
      const { turns, sessions } = collectDayTurns((runDeps as { root?: string }).root, target)
      if (turns.length < JOURNAL_MIN_TURNS) {
        return {
          ok: false,
          error: `那天只有 ${turns.length} 轮对话（${sessions} 个会话），不够写一段回顾`,
          date: target,
          text: `${target}：只有 ${turns.length} 轮对话（${sessions} 个会话），不够写回顾（至少 ${JOURNAL_MIN_TURNS} 轮）。`,
        }
      }
      const summary = await runDeps.summarize(buildJournalPrompt(target, turns), JOURNAL_SYSTEM)
      const content = parseJournalOutput(summary)
      if (content === null) {
        return {
          ok: false,
          error: '模型没有产出正文',
          date: target,
          rawPreview: summary.slice(0, 400),
          text: `模型没产出正文，原话开头：${summary.slice(0, 200)}`,
        }
      }
      if (args.dry_run === true) {
        return {
          ok: true,
          date: target,
          dryRun: true,
          turns: turns.length,
          sessions,
          content,
          text: `[干跑] ${target}：${turns.length} 轮 / ${sessions} 个会话\n\n${content}`,
        }
      }
      const written = await writeJournal(runDeps, target, content)
      return {
        ok: true,
        date: target,
        turns: turns.length,
        sessions,
        chars: content.length,
        ...written,
        text: `已写入 ${target} 的回顾（${content.length} 字，${turns.length} 轮对话）`,
      }
    },
  })
}

