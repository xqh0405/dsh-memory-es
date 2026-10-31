/**
 * 阶段 9.3：人格表层学习。
 *
 * 与 7.2 的 `traits` 的区别（别混）：
 *  - `traits` 从**记忆条目**里归纳**用户**的稳定模式 → `identity`；
 *  - 这里从**会话记录**里归纳**我自己**的行为倾向 → `persona`。
 * 前者答「你是谁」，后者答「我该怎么和你相处」。
 *
 * 三条硬规则：
 *  1. **只写候选**：产出 `status=pending`，approve 之后才进提示段（注入走 persona 段）。
 *  2. **必须带证据**：每条候选给出它依据的片段编号，审核时能回看原话。
 *  3. **素材只读本机、只读本人**：只扫 `~/.dsh/sessions/`，不碰别的机器。
 *
 * 会话文件是 `session.v4.jsonl.zstd`：一行一个事件，我们要的是
 * `assistant/message`（my text，**不含 reasoning**）与 `user/message`（且 `source.kind==='user'`，
 * 否则会把 runtime context、技能注入这些系统文本当成"用户反馈"）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { knnBody } from '../es/dsl.ts'
import type { EsClient } from '../es/http.ts'
import { personalIndexFor } from './common.ts'
import { hashContent } from './traits.ts'

/** 人格条目的类型；与 `identity`（用户画像）严格区分 */
export const PERSONA_MEMORY_TYPE = 'persona' as const
/** 候选状态：检索只认 active，所以 pending 天然不进结果 */
export const PERSONA_PENDING_STATUS = 'pending' as const

/** 一条素材：我说的话 + 你随后说的话（可能是纠正、偏好或表扬） */
export interface PersonaSource {
  /** 片段编号，作为 evidence 引用（s0、s1…） */
  ref: string
  session: string
  assistant: string
  feedback: string
}

export interface PersonaCandidate {
  content: string
  evidence: string[]
}

/** 素材条数上限（提示词与成本的上界） */
export const PERSONA_MAX_SOURCES = 40
/** 一次最多接受几条候选 */
export const PERSONA_MAX_OUTPUT = 6
/** 一条候选的字符上限 */
export const PERSONA_MAX_CHARS = 200
/** 我的回复太短的没信息量，太长的不适合放进提示 */
const ASSISTANT_MIN = 40
const ASSISTANT_MAX = 1200
const FEEDBACK_MAX = 300

/** 把 content 数组里的文本拼起来（跳过 reasoning / tool 等非 text 块） */
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
 * 从一份已解压的会话日志里抽素材（纯函数，便于单测）。
 *
 * 配对规则：一条 assistant 文本 + **紧随其后的第一条真人用户消息**。
 * 中间隔了工具调用不算断——工具是过程，反馈才是信号。
 */
export function extractFromSessionLog(logText: string, sessionId: string): PersonaSource[] {
  const out: PersonaSource[] = []
  let pending: string | null = null

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
    const data = (rec.data ?? {}) as Record<string, unknown>

    if (type === 'assistant/message') {
      const message = (data.message ?? {}) as Record<string, unknown>
      const text = joinTextBlocks(message.content)
      if (text !== '') pending = text
      continue
    }

    if (type === 'user/message') {
      // 系统注入的文本不是"你"说的话：只看 source.kind === 'user'
      const source = (data.source ?? {}) as Record<string, unknown>
      if (source.kind !== 'user') continue
      const text = joinTextBlocks(data.content)
      if (text === '' || pending === null) continue
      if (pending.length < ASSISTANT_MIN || pending.length > ASSISTANT_MAX) {
        pending = null
        continue
      }
      if (text.length > FEEDBACK_MAX) {
        pending = null
        continue
      }
      out.push({ ref: `s${out.length}`, session: sessionId, assistant: pending, feedback: text })
      pending = null
    }
  }
  return out
}

/**
 * 解压并读取一份会话日志；读不了返回空串（会话可能正在写、或格式升级）。
 *
 * ⚠️ 会话文件是**多帧追加**的 zstd：每批事件一个 frame 拼在同一个文件里。
 * Node 的 `zstdDecompressSync` / `createZstdDecompress` 只解出**第一帧**
 * （实测 2.3 MB 的文件只得到 203 字节，日志主体全丢），所以这里优先调系统的
 * `zstd -dc`（它会连续解完整条链）；命令不可用时才退回 Node 实现——
 * 那种情况只能拿到开头一小段，属于降级而不是崩溃。
 */
export function readSessionLog(file: string): string {
  try {
    return execFileSync('zstd', ['-dc', file], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    })
  } catch {
    try {
      return zstdDecompressSync(readFileSync(file)).toString('utf8')
    } catch {
      return ''
    }
  }
}

/**
 * 扫 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，取最近 N 天的片段。
 *
 * 按文件 mtime 粗筛（避免解压所有历史会话），再按时间倒序截断——
 * 最近说的话更能代表"现在的我"。
 */
export function collectPersonaSources(
  root = join(homedir(), '.dsh', 'sessions'),
  days = 14,
  maxSources = PERSONA_MAX_SOURCES,
): PersonaSource[] {
  if (!existsSync(root)) return []
  const since = Date.now() - days * 86_400_000
  const files: Array<{ file: string; mtime: number }> = []

  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let sessions: string[]
    try {
      sessions = readdirSync(wsDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(wsDir, session, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(file)
        if (st.mtimeMs >= since) files.push({ file, mtime: st.mtimeMs })
      } catch {
        // 没有这个文件就是没有，静默跳过
      }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime)
  const picked: PersonaSource[] = []
  for (const { file } of files) {
    const sessionId = file.split('/').slice(-2, -1)[0] ?? ''
    for (const src of extractFromSessionLog(readSessionLog(file), sessionId)) {
      picked.push(src)
      if (picked.length >= maxSources) break
    }
    if (picked.length >= maxSources) break
  }
  // ref 重新编号，保证与提示词里的编号一致
  return picked.map((s, i) => ({ ...s, ref: `s${i}` }))
}

export const PERSONA_SYSTEM = [
  '你在做一件很谨慎的事：帮助一个 AI 助手认识**它自己**说话做事的习惯，用于日后微调它的人格。',
  '',
  '素材是真实会话片段。每段里：',
  '- 【我的发言】= **这个 AI 助手自己说的话**（不是用户说的）；',
  '- 【用户的回复】= 用户紧接着说的话。',
  '',
  '你要归纳的是【我的发言】暴露出的、**它自己**的稳定行为倾向，例如：',
  '- 「习惯先给结论，再补一句为什么」',
  '- 「面对不确定的事实，先说不知道，再给验证路径」',
  '- 「收尾时把没做完的事明确列出来」',
  '',
  '**不要**归纳：',
  '- 用户是谁、用户的项目与偏好（那是另一套记忆，不归这里）',
  '- 一次性事件、具体任务内容',
  '- 只出现一次的措辞',
  '',
  '硬性要求：',
  '1. **每条都不要写人称**：不写「我」，也不写「你」；要指代对话方时写「对方」。',
  '   直接以动词或状语开头，例如「习惯先给结论，再展开依据」「收尾时把没做完的事列出来」。',
  '   （系统会自动补成「我…」，所以你不需要、也不应该写「我」。）',
  '2. 每条独立成立，不写「上面」「这些片段」。',
  '3. 每条必须由至少 1 个片段支撑，并给出片段编号（s0、s1…）。',
  `4. 每条不超过 ${PERSONA_MAX_CHARS} 字，一次最多 ${PERSONA_MAX_OUTPUT} 条。`,
  '5. 看不出稳定模式就输出空数组 []。**宁可空，不要凑**。',
  '',
  '输出格式（只输出 JSON，不要解释）：',
  '[',
  '  {"content": "我习惯先给结论，再补一句为什么", "evidence": ["s0", "s3"]}',
  ']',
].join('\n')

/** 单个片段的展示上限：40 条全量正文会到 30K+，判断力被细节冲淡 */
const ASSISTANT_EXCERPT = 280

/** 把素材拼成 prompt 正文 */
export function buildPersonaPrompt(sources: readonly PersonaSource[], days: number): string {
  const lines = sources.map((s) => {
    const excerpt = s.assistant.length > ASSISTANT_EXCERPT
      ? `${s.assistant.slice(0, ASSISTANT_EXCERPT)}…`
      : s.assistant
    return `### [${s.ref}]\n【我的发言】${excerpt}\n【用户的回复】${s.feedback}`
  })
  return [
    `下面是最近 ${days} 天里，**我**（这个 AI 助手）在 ${sources.length} 个会话片段中的表现。`,
    '请归纳出**我自己**的稳定倾向。',
    '',
    '人称对照（这一点很容易搞反，务必看清）：',
    '- 【我的发言】是**我自己**说的话，不是用户说的；',
    '- 在【我的发言】正文里出现的「你」，指的是**用户**；出现「我」，才指我自己；',
    '- 【用户的回复】是用户说的话。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 解析模型输出。容忍 ```json 围栏与前后废话。
 *
 * `allowedRefs` 用来挡编造的编号：模型很爱引用不存在的 s99。
 * 证据全都不存在的条目整条丢弃（不是"裁掉证据"，那等于放过一条无据的结论）。
 */
export function parsePersonaOutput(text: string, allowedRefs?: ReadonlySet<string>): PersonaCandidate[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: PersonaCandidate[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { content?: unknown; evidence?: unknown; evidence_ids?: unknown }
    if (typeof record.content !== 'string') continue
    const content = record.content.trim()
    if (content === '' || content.length > PERSONA_MAX_CHARS) continue
    /**
     * 视角校验：条目必须以「我」的口吻描述自己。
     * 实测模型会把【我的发言】当成用户说的话，于是写出「你习惯先给结论…」——
     * 这种条目一旦进人格段就是「我的人格 / 你习惯…」，自相矛盾，直接丢弃。
     */
    /**
     * 人称统一：**把「你」替换成「我」，必要时补开头**。
     *
     * 试过四版「不让它写错」，都不成立：要求写「我」→ 它写「你」；
     * 要求不许出现「你」→ 它还是写「你」；要求无人称 → 它照样写「你」。
     * 证据（evidence_ids）逐条指向【我的发言】，说明它描述的确实是我自己的行为，
     * 只是把「你」当成了「被描述者」的代词。所以这里不跟它较劲，直接归一：
     * 判定交给人工审核（pending → approve），代词交给代码。
     */
    let normalized = content.replaceAll('你', '我').replaceAll('我我', '我')
    // 通篇无人称（模型按「不要写人称」照做）时补上主语
    if (!normalized.includes('我')) normalized = `我${normalized}`
    /**
     * 宽容两种证据字段名：prompt 里要求 `evidence`，但实测模型会写成
     * `evidence_ids`（跟 memory_traits 那套字段混了）。只认一个的话，
     * 输出明明是对的却会整批解析成 0 条——2026-10-31 踩过一次。
     */
    const rawEvidence = record.evidence ?? record.evidence_ids
    if (!Array.isArray(rawEvidence)) continue
    const refs = rawEvidence
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim())
    const unique = [...new Set(refs)]
    if (unique.length === 0) continue
    if (allowedRefs !== undefined && unique.some((r) => !allowedRefs.has(r))) continue
    out.push({ content: normalized, evidence: unique })
    if (out.length >= PERSONA_MAX_OUTPUT) break
  }
  return out
}

/** 与 traits 一致的判重阈值：同义换句的余弦相似度实测在 0.94 以上 */
const PERSONA_DEDUP_MIN_SCORE = 0.9
const PERSONA_DEDUP_TOPK = 5

export interface PersonaDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'search'>
  writer: Pick<EsClient, 'index'>
  embed?: { embed(text: string, call?: { signal?: AbortSignal }): Promise<number[]> }
  dims?: number
  now?: () => Date
  log?: (event: Record<string, unknown>) => void
}

/**
 * 查是否已有意思相近的人格条目（pending 或 active）。
 * 失败一律当「没有重复」——判重是省人工，不能把学习流程卡死。
 */
export async function findPersonaDuplicate(
  deps: PersonaDeps,
  content: string,
): Promise<{ memory_id: string; score: number } | null> {
  const embed = deps.embed
  const dims = deps.dims
  if (embed === undefined || dims === undefined) return null
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  let vector: number[]
  try {
    vector = await embed.embed(content)
  } catch {
    return null
  }
  try {
    const res = await deps.reader.search(
      index,
      knnBody(vector, dims, { status: null, memory_type: PERSONA_MEMORY_TYPE }, PERSONA_DEDUP_TOPK),
    )
    for (const hit of res.hits) {
      const src = hit.source as Record<string, unknown>
      const status = typeof src.status === 'string' ? src.status : ''
      if (status !== PERSONA_PENDING_STATUS && status !== 'active') continue
      if (!(hit.score >= PERSONA_DEDUP_MIN_SCORE)) continue
      return { memory_id: typeof src.memory_id === 'string' ? src.memory_id : hit.id, score: hit.score }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 写一条人格候选（pending）。
 *
 * 证据存进 `evidence_ids` 的**结构化对象**（该字段 mapping 是 `object, enabled:false`，
 * 不索引但原样保留），审核时能直接看到原话，而不是一串 ref 编号。
 */
export async function writePersonaCandidate(
  deps: PersonaDeps,
  cand: PersonaCandidate,
  sources: readonly PersonaSource[],
  days: number,
): Promise<{ written: boolean; memory_id: string }> {
  const now = deps.now?.() ?? new Date()
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const memoryId = `persona-${hashContent(cand.content)}`
  const byRef = new Map(sources.map((s) => [s.ref, s]))
  const evidence = cand.evidence
    .map((ref) => byRef.get(ref))
    .filter((s): s is PersonaSource => s !== undefined)
    .map((s) => ({
      ref: s.ref,
      session: s.session,
      assistant: s.assistant.slice(0, 200),
      feedback: s.feedback.slice(0, 120),
    }))

  const doc: Record<string, unknown> = {
    memory_id: memoryId,
    user_id: deps.userId,
    content: cand.content,
    memory_type: PERSONA_MEMORY_TYPE,
    domain: 'general',
    privacy: 'private',
    importance: 'normal',
    status: PERSONA_PENDING_STATUS,
    promote_state: 'none',
    distill_state: 'persona',
    evidence_ids: evidence,
    traits_window_days: days,
    content_sha256: hashContent(cand.content),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }

  if (deps.embed !== undefined && deps.dims !== undefined) {
    try {
      doc.embedding = await deps.embed.embed(cand.content)
    } catch (err) {
      deps.log?.({ tool: 'persona', event: 'candidate_embedding_failed', error: String(err).slice(0, 160) })
    }
  }

  try {
    await deps.writer.index(index, doc, { id: memoryId, refresh: 'wait_for', opType: 'create' })
    return { written: true, memory_id: memoryId }
  } catch (err) {
    if ((err as { status?: unknown }).status === 409) return { written: false, memory_id: memoryId }
    throw err
  }
}

/**
 * 读生效（active）的人格条目，供提示段注入。
 * 按 updated_at 倒序：最近确认的倾向更贴近「现在的我」。
 */
export async function loadActivePersona(deps: PersonaDeps, max = 12): Promise<string[]> {
  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const res = await deps.reader.search(index, {
    size: max,
    _source: ['content'],
    sort: [{ updated_at: 'desc' }],
    query: {
      bool: {
        filter: [
          { term: { status: 'active' } },
          { term: { memory_type: PERSONA_MEMORY_TYPE } },
        ],
      },
    },
  })
  const out: string[] = []
  for (const hit of res.hits) {
    const src = hit.source as Record<string, unknown>
    if (typeof src.content === 'string' && src.content.trim() !== '') out.push(src.content.trim())
  }
  return out
}

/** `memory_persona` 工具：从会话里归纳「我自己」的行为倾向，默认干跑。 */
export function definePersonaTool(deps: PersonaDeps & {
  summarize?: (prompt: string) => Promise<string>
  collect?: (days: number) => PersonaSource[]
}) {
  return defineTool({
    name: 'memory_persona',
    description: [
      '从最近的**会话记录**里归纳「我自己的行为倾向」候选（memory_type=persona），**只写候选不生效**。',
      '与 memory_traits 的区别：那个归纳的是**用户**（identity），这个归纳的是**我**（persona）。',
      '默认 dry_run=true，先看产出再决定是否落库；落库的条目 status=pending，approve 之后才进提示段。',
      '素材只读本机会话目录，不碰其他机器。',
    ].join(''),
    parameters: {
      days: {
        type: 'number',
        description: '回看最近多少天的会话（默认 14，上限 90）。',
      },
      dry_run: {
        type: 'boolean',
        description: 'true（默认）= 只返回候选不落库；false = 写成 status=pending 的候选。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: { type: 'number', required: true },
          candidates: { type: 'number', required: true },
          written: { type: 'number', required: true },
          duplicates: { type: 'number', required: true },
          skipped: { type: 'string', required: true },
          // 干跑且 0 条时带上模型原话：空数组（真看不出）与解析失败必须能区分
          rawPreview: { type: 'string' },
          rawLength: { type: 'number' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 180_000,
    async execute(input) {
      const days = clampDays(input.days)
      const dryRun = input.dry_run !== false
      const sources = (deps.collect ?? ((d: number) => collectPersonaSources(undefined, d)))(days)
      if (sources.length === 0) {
        return {
          sources: 0, candidates: 0, written: 0, duplicates: 0, skipped: 'no_sources',
          text: `最近 ${days} 天没有找到可用的会话片段（需要「我的回复 + 你随后的话」成对出现）。`,
        }
      }
      const summarize = deps.summarize
      if (summarize === undefined) {
        return {
          sources: sources.length, candidates: 0, written: 0, duplicates: 0, skipped: 'no_llm_service',
          text: '没有可用的模型服务，本次没有归纳（记忆库本身不受影响）。',
        }
      }

      const raw = await summarize(buildPersonaPrompt(sources, days))
      const allowed = new Set(sources.map((s) => s.ref))
      const candidates = parsePersonaOutput(raw, allowed)
      if (dryRun) {
        const base = `最近 ${days} 天共 ${sources.length} 个会话片段，模型给出 ${candidates.length} 条人格候选（干跑，未落库）。`
        // 0 条时把模型原话带出来：空数组与「格式没解析出来」在结果上一模一样
        const extra = candidates.length === 0
          ? `\n\n模型原始输出（共 ${raw.length} 字符，前 300）：\n${raw.slice(0, 300) === '' ? '(空)' : raw.slice(0, 300)}`
          : ''
        return {
          sources: sources.length, candidates: candidates.length, written: 0, duplicates: 0, skipped: 'dry_run',
          rawPreview: raw.slice(0, 300),
          rawLength: raw.length,
          text: base + extra,
        }
      }

      let written = 0
      let duplicates = 0
      for (const cand of candidates) {
        const dup = await findPersonaDuplicate(deps, cand.content)
        if (dup !== null) {
          duplicates += 1
          deps.log?.({ tool: 'persona', event: 'skipped_duplicate', existing: dup.memory_id })
          continue
        }
        const result = await writePersonaCandidate(deps, cand, sources, days)
        if (result.written) written += 1
        else duplicates += 1
      }
      const dupNote = duplicates > 0 ? `，跳过 ${duplicates} 条与已有条目同义` : ''
      return {
        sources: sources.length, candidates: candidates.length, written, duplicates, skipped: '',
        text: `最近 ${days} 天共 ${sources.length} 个会话片段，模型给出 ${candidates.length} 条候选，`
          + `新写入 ${written} 条（pending，待审核）${dupNote}。`,
      }
    },
  })
}

function clampDays(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 14
  return Math.max(1, Math.min(90, n))
}
