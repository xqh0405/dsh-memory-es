/**
 * `memory_get` —— 按 id 取全文（阶段 12 分级读取的「展开动作」）。
 *
 * 为什么需要它：`memory_search` 在 `detail=summary` 时只给摘要 + 120 字正文，
 * 省下的是 context，代价是模型拿不到细节。没有「展开」这个动作，模型要么猜、
 * 要么重新检索一遍——两种都比直接按 id 取全文贵。
 *
 * 只读个人库、只按 id 取（不做检索）：它是 `memory_search` 的补充，
 * 不是第二个检索入口。归属校验（F3）照旧——拿别人的 id 取不到，这是设计。
 *
 * @module dsh-memory-es/memory/get
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { EsClient } from '../es/http.ts'
import { EsError } from '../es/http.ts'
import { assertDocOwner, personalIndexFor } from './common.ts'

/** 一次最多取这么多条：批量展开是给"看清细节"用的，不是给"导库"用的 */
export const MAX_GET_IDS = 20

export interface GetInput {
  memory_ids: string[]
}

export interface GetItem {
  memory_id: string
  content: string
  memory_type: string
  domain: string
  updated_at: string
  status: string
  origin: string
  /** 有 summary 字段时一并给出（早期条目没有） */
  summary?: string
  confirmed_use?: number
  corrections?: number
}

export interface GetResult {
  hits: GetItem[]
  /** 取不到的 id（不存在 / 不属于本用户）；不抛错，整批仍可用 */
  missing: string[]
  text: string
}

export interface GetDeps {
  userId: string
  personalPrefix: string
  reader: Pick<EsClient, 'get'>
  signal?: AbortSignal
  log?: (event: Record<string, unknown>) => void
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/**
 * 编排：逐条按 id 取。**不并发**是故意的——一次最多 20 条、低频调用，
 * 顺序取更容易在日志里对上号；并发 20 个请求对 ES 也不友好。
 */
export async function getMemories(deps: GetDeps, input: GetInput): Promise<GetResult> {
  const ids = (Array.isArray(input.memory_ids) ? input.memory_ids : [])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => id !== '')
  if (ids.length === 0) throw new Error('memory_get: memory_ids 不能为空')
  if (ids.length > MAX_GET_IDS) throw new Error(`memory_get: 一次最多 ${MAX_GET_IDS} 条（收到 ${ids.length}）`)

  const index = personalIndexFor(deps.personalPrefix, deps.userId)
  const hits: GetItem[] = []
  const missing: string[] = []

  for (const id of [...new Set(ids)]) {
    try {
      const doc = await deps.reader.get(index, id, { signal: deps.signal })
      // 归属不符说明这个 id 来自别处：不抛错毁掉整批，但也绝不返回别人的内容
      try {
        assertDocOwner(doc.source, deps.userId)
      } catch {
        missing.push(id)
        continue
      }
      const src = doc.source
      hits.push({
        memory_id: str(src.memory_id) || doc.id,
        content: str(src.content),
        memory_type: str(src.memory_type),
        domain: str(src.domain),
        updated_at: str(src.updated_at),
        status: str(src.status),
        origin: str(src.origin),
        ...(str(src.summary) === '' ? {} : { summary: str(src.summary) }),
        ...(num(src.confirmed_use) === undefined ? {} : { confirmed_use: num(src.confirmed_use) }),
        ...(num(src.corrections) === undefined ? {} : { corrections: num(src.corrections) }),
      })
    } catch (err) {
      if (err instanceof EsError && err.kind === 'not_found') {
        missing.push(id)
        continue
      }
      throw err
    }
  }

  deps.log?.({ tool: 'get', user: deps.userId, requested: ids.length, found: hits.length, missing: missing.length })

  const body =
    hits.length === 0
      ? '没有取到任何记忆。'
      : hits
          .map((item) => {
            const meta = [item.memory_type, item.domain, item.updated_at.slice(0, 10)].filter((x) => x !== '').join(' · ')
            return `【${item.memory_id}】${meta}\n${item.content}`
          })
          .join('\n\n')
  const tail =
    missing.length === 0
      ? ''
      : `\n\n没找到：${missing.join(', ')}（可能不属于当前用户，或已被删除）`

  return { hits, missing, text: `${body}${tail}` }
}

const DESCRIPTION = [
  '按 memory_id 取记忆全文（分级读取的展开动作）。',
  '什么时候用：memory_search 用 detail=summary 只给了摘要、需要看细节时；或已知 id 要复核一条记忆。',
  `一次最多 ${MAX_GET_IDS} 条；只读个人库，不属于自己的 id 会返回在 missing 里。`,
  '它是检索的补充，不是第二个检索入口——不知道 id 时请先用 memory_search。',
].join(' ')

export function defineGetTool(deps: GetDeps) {
  return defineTool({
    name: 'memory_get',
    description: DESCRIPTION,
    parameters: {
      memory_ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `要展开的 memory_id 列表（从 memory_search 的结果里拿，一次最多 ${MAX_GET_IDS} 条）。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                memory_id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                memory_type: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                updated_at: { type: 'string', required: true },
                status: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                summary: { type: 'string' },
                confirmed_use: { type: 'number' },
                corrections: { type: 'number' },
              },
            },
          },
          missing: { type: 'array', required: true, items: { type: 'string' } },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // 最多 20 次单文档读，顺序执行；给 15 s 兜住
    timeoutMs: 15_000,
    async execute(args, exec) {
      return await getMemories({ ...deps, signal: exec.signal }, args)
    },
  })
}
