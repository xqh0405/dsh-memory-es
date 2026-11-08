/**
 * 阶段 29：文档归档与冷引用。
 *
 * 抄 mnemon 最关键的一手：**归档前留一条冷引用，归档才不是失踪**。
 * 只把 status 改成 archived 的归档，用户下次「我记得写过但搜不到」时无从下手——
 * 冷引用是一条普通记忆，能被 memory_search 命中，正文里带 doc_id，
 * 于是「搜记忆 → 看到指路条 → 用 doc_id + includeArchived 深查」成了闭环。
 *
 * 为什么归档用「该 doc_id 全部切片一起改」：文档是按 chunk 存的，
 * 只改一片会让同一篇文档一半出现一半不出现，比不归档更让人困惑。
 *
 * 为什么不用 `_update_by_query`：`EsClient` 没有这个能力（也不值得为它加一个只用于
 * 归档的方法）。这里先 search 拿全量 `_id`，再走既有的 `bulkUpdateScript` ——
 * 切片数按「篇 × 平均 chunk 数」算，单篇最多几百条，一次 bulk 足够。
 */

import type { EsClient } from '../es/http.ts'
import type { SaveResult } from './save.ts'

/** 归档/恢复要读元信息（标题、来源路径）+ 改状态 */
export interface DocArchiveDeps {
  userId: string
  docPrefix: string
  /** 读：search；写：bulkUpdateScript（缺 bulk 时退回逐条 updateScript） */
  reader: Pick<EsClient, 'search'>
  writer:
    | (Pick<EsClient, 'updateScript'> & { bulkUpdateScript?: EsClient['bulkUpdateScript'] })
    | null
  /** 写冷引用：与 memory_save 同构（受写开关、准入、去重约束） */
  saveColdRef?: (input: { content: string; domain: string }) => Promise<SaveResult>
  log?: (event: Record<string, unknown>) => void
}

export interface ArchiveResult {
  docId: string
  /** 被改状态的切片数 */
  chunks: number
  /** 冷引用记忆 id；没有写（例如 readonly 或没配 saveColdRef）时为 undefined */
  coldMemoryId?: string
  /** 冷引用为什么没写——给人看，不是错误 */
  note?: string
}

export interface RestoreResult {
  docId: string
  chunks: number
}

const ARCHIVE_SCRIPT = "ctx._source.status = 'archived'"
const RESTORE_SCRIPT = "ctx._source.status = 'active'"

/** 文档库的容量口径：只计 active 切片的正文长度（与 mnemon 同口径） */
export interface DocCapacity {
  /** active 切片的 content 总字节（UTF-8 估算：按字符数 × 3 上界） */
  usedBytes: number
  /** active 切片数 */
  activeChunks: number
  /** active 文档篇数（cardinality） */
  activeDocs: number
  limitBytes: number
  /** true = 已超限（写入应被拒） */
  overLimit: boolean
}

/**
 * 读文档库容量。
 *
 * 用 `sum` 聚合在 `content_sha256` 上算不出字节数（keyword 没有 doc_values 求和语义），
 * 而 `_source` 全量拉回来算成本太高。这里的做法：按 chunk 数的**实际**平均长度估算，
 * 用 `cardinality(doc_id)` 给篇数、`count` 给切片数，再乘以平均长度。
 * **它是提示性指标，不是计费口径**——真正要卡写入时用 `assertDocCapacity`，
 * 那个函数按同样口径判断，误差方向是「宁可早拦」。
 */
export async function readDocCapacity(
  deps: Pick<DocArchiveDeps, 'userId' | 'docPrefix' | 'reader'>,
  limitBytes: number,
): Promise<DocCapacity> {
  const index = `${deps.docPrefix}${deps.userId}`
  const res = await deps.reader.search(index, {
    size: 0,
    track_total_hits: true,
    query: { term: { status: 'active' } },
    aggs: {
      docs: { cardinality: { field: 'doc_id' } },
      // ⚠️ 不能用 `doc['content'].size()`：content 是 text（analyzed），没有 doc_values，
      // 脚本里取 doc[...] 会直接 400（search_phase_execution_exception）。
      // 只能读 `_source`——慢一些，但这是唯一准确的口径；容量统计不是高频操作。
      // ⚠️ Painless 不认可选链（`?.` 是 JS 语法，编译期就报 compile error），必须显式判空。
      chars: {
        sum: {
          script: {
            source:
              '(params._source != null && params._source.content != null)'
              + ' ? params._source.content.length() : 0',
          },
        },
      },
    },
  })
  const aggs = (res.aggregations ?? {}) as Record<string, { value?: number }>
  const activeChunks = typeof res.total === 'number' ? res.total : 0
  const activeDocs = Number(aggs.docs?.value ?? 0)
  const chars = Number(aggs.chars?.value ?? 0)
  // 中文字符 UTF-8 占 3 字节，英文 1 字节；按 3 折算 = 上界（宁可早拦）
  const usedBytes = Math.round(chars * 3)
  return {
    usedBytes,
    activeChunks,
    activeDocs,
    limitBytes,
    overLimit: limitBytes > 0 && usedBytes > limitBytes,
  }
}

/**
 * 容量闸：给「写入文档」的调用方用（脚本 / 将来的原生入口）。
 *
 * ⚠️ 当前主插件**没有文档写入路径**（只有检索与热度回写），所以这个函数
 * 目前只被 `scripts/migrate-docs.py` 与面板的用量展示用到。
 * 写出来是为了让「到限拒写」有一条可复用的实现，而不是等有入口了再临时加。
 */
export async function assertDocCapacity(
  deps: Pick<DocArchiveDeps, 'userId' | 'docPrefix' | 'reader'>,
  limitBytes: number,
): Promise<DocCapacity> {
  const cap = await readDocCapacity(deps, limitBytes)
  if (cap.overLimit) {
    const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MiB`
    throw new Error(
      `文档库已超限（${mb(cap.usedBytes)} / ${mb(limitBytes)}）——先归档旧文档再写入。`
        + '归档后原文档不删，可以通过 includeArchived 深查找回。',
    )
  }
  return cap
}

/** 取该 doc_id 的全部切片 _id 与元信息（取不到 = 文档不存在） */
async function loadSlices(
  deps: Pick<DocArchiveDeps, 'userId' | 'docPrefix' | 'reader'>,
  docId: string,
): Promise<{ ids: string[]; title: string; sourcePaths: string[]; domain: string; chunkTotal: number }> {
  const index = `${deps.docPrefix}${deps.userId}`
  const res = await deps.reader.search(index, {
    size: 1000, // 单篇文档的切片上限；超过 1000 切片的长文档本身就该拆分
    _source: ['doc_id', 'title', 'source_paths', 'source_path', 'domain', 'chunk_total'],
    query: { term: { doc_id: docId } },
  })
  const hits = res.hits ?? []
  if (hits.length === 0) {
    throw new Error(`文档不存在：doc_id=${docId}（索引 ${index}）`)
  }
  const src = (hits[0]!.source ?? {}) as Record<string, unknown>
  const paths = Array.isArray(src.source_paths)
    ? src.source_paths.map(String)
    : typeof src.source_path === 'string'
      ? [src.source_path]
      : []
  return {
    ids: hits.map((h) => h.id),
    title: typeof src.title === 'string' ? src.title : docId,
    sourcePaths: paths,
    domain: typeof src.domain === 'string' ? src.domain : 'general',
    chunkTotal: typeof src.chunk_total === 'number' ? src.chunk_total : hits.length,
  }
}

/** 批量改切片状态；没有 bulk 能力时退回逐条（语义一致，只是慢） */
async function setStatus(
  deps: DocArchiveDeps,
  index: string,
  ids: string[],
  script: string,
): Promise<number> {
  const writer = deps.writer
  if (writer === null) throw new Error('归档需要写权限（writer 未配置）')
  const updates = ids.map((id) => ({ index, id, script: { source: script } }))
  if (typeof writer.bulkUpdateScript === 'function') {
    const results = await writer.bulkUpdateScript(updates)
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      // 部分失败要显式报：一半归档一半没归档，比整篇失败更难查
      throw new Error(`归档部分失败：${failed.length}/${results.length} 条未更新（${failed[0]?.error ?? ''}）`)
    }
    return results.length
  }
  await Promise.all(ids.map((id) => writer.updateScript(index, id, { source: script })))
  return ids.length
}

/**
 * 归档一篇文档：全部切片 `status → archived`，再写一条冷引用记忆。
 *
 * 顺序是有意的：**先改状态、再写冷引用**。反过来的话，冷引用写成功但状态没改成，
 * 用户会搜到一条「指向仍在检索里的文档」的指路条——多余且误导。
 */
export async function archiveDoc(
  deps: DocArchiveDeps,
  input: { docId: string; reason?: string },
): Promise<ArchiveResult> {
  const log = deps.log ?? (() => {})
  const index = `${deps.docPrefix}${deps.userId}`
  const docId = input.docId.trim()
  if (docId === '') throw new Error('archiveDoc: docId 不能为空')

  const meta = await loadSlices(deps, docId)
  const chunks = await setStatus(deps, index, meta.ids, ARCHIVE_SCRIPT)

  let coldMemoryId: string | undefined
  let note: string | undefined
  if (!deps.saveColdRef) {
    note = '没有配置冷引用写入（saveColdRef），本次归档不留指路条'
  } else {
    const paths = meta.sourcePaths.length > 0 ? `\n源文件：${meta.sourcePaths.join('、')}` : ''
    const reason = input.reason ? `\n归档原因：${input.reason}` : ''
    const content =
      `【已归档文档】${meta.title}\n`
      + `doc_id: ${docId}\n`
      + `切片 ${meta.chunkTotal} 个已归档，日常检索不再出现。`
      + `需要正文时用 doc_search 加 includeArchived=true 按 doc_id 查。`
      + `${paths}${reason}`
    try {
      const saved = await deps.saveColdRef({ content, domain: meta.domain })
      if (saved.status === 'created' || saved.status === 'merged') {
        coldMemoryId = saved.memory_id
      } else {
        // rejected（写开关关着）不算错误：归档本身已经完成，只是没有指路条
        note = `冷引用未写入：${saved.reason ?? saved.status}`
      }
    } catch (err) {
      // 冷引用失败不回滚归档：状态已经改了，回滚会让「归档」变成半成品。
      // 但必须记日志——没有冷引用的归档是「失踪」，要让人知道。
      note = `冷引用写入失败：${String(err).slice(0, 160)}`
      log({ tool: 'doc_archive', doc_id: docId, event: 'cold_ref_failed', error: note })
    }
  }

  log({ tool: 'doc_archive', doc_id: docId, chunks, cold_ref: coldMemoryId ?? null })
  return { docId, chunks, coldMemoryId, note }
}

/** 恢复一篇文档：全部切片 `status → active`。冷引用留着（它仍是那条历史记录）。 */
export async function restoreDoc(
  deps: Pick<DocArchiveDeps, 'userId' | 'docPrefix' | 'reader' | 'writer' | 'log'>,
  input: { docId: string },
): Promise<RestoreResult> {
  const index = `${deps.docPrefix}${deps.userId}`
  const docId = input.docId.trim()
  if (docId === '') throw new Error('restoreDoc: docId 不能为空')
  const meta = await loadSlices(deps, docId)
  const chunks = await setStatus(deps as DocArchiveDeps, index, meta.ids, RESTORE_SCRIPT)
  ;(deps.log ?? (() => {}))({ tool: 'doc_restore', doc_id: docId, chunks })
  return { docId, chunks }
}