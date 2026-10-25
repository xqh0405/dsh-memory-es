/**
 * Markdown 镜像（文档附录 C / §16 S10）：把团队库按 domain 导出成 `knowledge/<domain>.md`。
 *
 * 三条硬约束，写在最前面免得后人好心办坏事：
 *  1. **只读视图**：md 不反向写 ES（避免双写漂移）。要改知识走 ES + 审核台，md 是给人看的。
 *  2. **只导出"可检索"的条目**：`status=active` 且 `review_state ∈ {auto,approved}`——
 *     和 memory_search 的审核闸保持一致，否则镜像里会出现检索根本查不到的 pending 条目，
 *     形成"文档说有、实际查不到"的第二种真相。
 *  3. **每条必须带来源**（source_user / source_memory_id / promoted_at / doc_id），
 *     这是 §10 的可追溯要求，也是 md 能当备份用的前提。
 *
 * 生成的每个文件首行都有 `<!-- generated-by: dsh-memory-es -->` 标记：清理旧文件时只删带标记的，
 * 绝不碰人写的 md。
 *
 * @module dsh-memory-es/consolidate/export
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EsClient } from '../src/es/http.ts'

/** 生成标记：清理 scope 只认这个前缀 */
export const GENERATED_MARKER = '<!-- generated-by: dsh-memory-es -->'

export interface TeamDocForExport {
  doc_id: string
  content: string
  memory_type: string
  domain: string
  topic_key: string
  source_user: string
  source_memory_id: string
  promoted_at: string
  updated_at: string
}

export interface ExportMeta {
  generatedAt: Date
  /** 团队库索引名 + 地址，写进文件头便于回溯 */
  teamIndex: string
  endpoint: string
}

/** domain 变成文件名：路径分隔符/空白/控制字符一律换成 `-`，保留中文 */
export function safeFileName(domain: string): string {
  const cleaned = domain
    .trim()
    .replace(/[/\\:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned === '' ? 'general' : cleaned
}

/** 按 domain 分组（空 domain 归到 general） */
export function groupByDomain(docs: readonly TeamDocForExport[]): Map<string, TeamDocForExport[]> {
  const groups = new Map<string, TeamDocForExport[]>()
  for (const doc of docs) {
    const domain = doc.domain.trim() === '' ? 'general' : doc.domain.trim()
    const bucket = groups.get(domain)
    if (bucket) bucket.push(doc)
    else groups.set(domain, [doc])
  }
  // 稳定的顺序：domain 名字母序，方便 diff
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function oneLine(text: string, maxChars = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}

/** 渲染单个 domain 文件 */
export function renderDomainMarkdown(
  domain: string,
  docs: readonly TeamDocForExport[],
  meta: ExportMeta,
): string {
  const lines: string[] = [
    GENERATED_MARKER,
    `<!-- 由 consolidate/cli.ts --export 生成，请勿手改（只读镜像，改 md 不会回流 ES） -->`,
    '',
    `# ${domain}`,
    '',
    `> 生成时间 ${meta.generatedAt.toISOString()} · 来源 \`${meta.endpoint}\` 的 \`${meta.teamIndex}\` · ${docs.length} 条`,
    `> 只含 \`status=active\` 且 \`review_state ∈ {auto, approved}\` 的条目（与检索口径一致）`,
    '',
  ]
  const ordered = [...docs].sort((a, b) => (a.promoted_at < b.promoted_at ? -1 : a.promoted_at > b.promoted_at ? 1 : 0))
  ordered.forEach((doc, index) => {
    lines.push(`## ${index + 1}. ${oneLine(doc.content, 40)}`)
    lines.push('')
    lines.push(doc.content.trim())
    lines.push('')
    lines.push(`- 类型：\`${doc.memory_type}\` · topic_key：\`${doc.topic_key}\` · doc_id：\`${doc.doc_id}\``)
    lines.push(
      `- 来源：${doc.source_user} / \`${doc.source_memory_id}\` @ ${doc.promoted_at}（内容更新于 ${doc.updated_at}）`,
    )
    lines.push('')
  })
  return `${lines.join('\n')}\n`
}

/** 渲染 `knowledge/INDEX.md` */
export function renderIndex(groups: Map<string, TeamDocForExport[]>, meta: ExportMeta): string {
  const lines: string[] = [
    GENERATED_MARKER,
    '',
    '# 团队知识索引',
    '',
    `> 生成时间 ${meta.generatedAt.toISOString()} · 来源 \`${meta.endpoint}\` 的 \`${meta.teamIndex}\``,
    `> 全量共 ${[...groups.values()].reduce((sum, docs) => sum + docs.length, 0)} 条，${groups.size} 个 domain`,
    '',
    '| domain | 条目 | 文件 |',
    '|---|---|---|',
  ]
  for (const [domain, docs] of groups) {
    lines.push(`| ${domain} | ${docs.length} | [\`${safeFileName(domain)}.md\`](./${safeFileName(domain)}.md) |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export interface ExportDeps {
  /** read 团队库的身份（consolidator） */
  client: Pick<EsClient, 'search'>
  teamIndex: string
  endpoint: string
}

/** 分页读团队库（search_after，避免 from+size 的 10000 上限） */
export async function listExportable(deps: ExportDeps, pageSize = 200): Promise<TeamDocForExport[]> {
  const out: TeamDocForExport[] = []
  let after: unknown[] | undefined
  for (;;) {
    const body: Record<string, unknown> = {
      size: pageSize,
      _source: { excludes: ['embedding'] },
      query: {
        bool: {
          filter: [
            { term: { status: 'active' } },
            { terms: { review_state: ['auto', 'approved'] } },
          ],
        },
      },
      sort: [{ promoted_at: 'asc' }, { doc_id: 'asc' }],
      ...(after ? { search_after: after } : {}),
    }
    const page = await deps.client.search(deps.teamIndex, body)
    for (const hit of page.hits) {
      const source = hit.source
      out.push({
        doc_id: str(source.doc_id) ?? hit.id,
        content: str(source.content) ?? '',
        memory_type: str(source.memory_type) ?? 'fact',
        domain: str(source.domain) ?? 'general',
        topic_key: str(source.topic_key) ?? '',
        source_user: str(source.source_user) ?? 'unknown',
        source_memory_id: str(source.source_memory_id) ?? '',
        promoted_at: str(source.promoted_at) ?? '',
        updated_at: str(source.updated_at) ?? '',
      })
    }
    if (page.hits.length < pageSize) break
    const last = page.hits[page.hits.length - 1]
    // search_after 需要与 sort 同形的值；ES 不返回 sort 时退化成用字段值组
    after = (last as unknown as { sort?: unknown[] }).sort ?? [
      str(last.source.promoted_at) ?? '',
      str(last.source.doc_id) ?? last.id,
    ]
  }
  return out
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export interface ExportResult {
  outDir: string
  files: Array<{ domain: string; file: string; count: number }>
  /** 本次删掉的旧文件（只删带生成标记的） */
  pruned: string[]
  total: number
}

/**
 * 导出到目录。`dryRun` 时只算不写（便于先看会产出什么）。
 * 重跑幂等：同名文件覆盖，且**清掉本轮已不存在 domain 的旧文件**（否则已撤回的知识会残留在镜像里）。
 */
export function writeMirror(
  outDir: string,
  groups: Map<string, TeamDocForExport[]>,
  meta: ExportMeta,
  options: { dryRun?: boolean } = {},
): ExportResult {
  const dryRun = options.dryRun === true
  const result: ExportResult = { outDir, files: [], pruned: [], total: 0 }
  const wanted = new Set<string>(['INDEX.md'])

  for (const [domain, docs] of groups) {
    const file = `${safeFileName(domain)}.md`
    wanted.add(file)
    result.files.push({ domain, file, count: docs.length })
    result.total += docs.length
    if (!dryRun) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, file), renderDomainMarkdown(domain, docs, meta), 'utf8')
    }
  }
  if (!dryRun) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'INDEX.md'), renderIndex(groups, meta), 'utf8')
  }

  if (!dryRun && existsSync(outDir)) {
    for (const entry of readdirSync(outDir)) {
      if (!entry.endsWith('.md') || wanted.has(entry)) continue
      const full = join(outDir, entry)
      const head = readFileSync(full, 'utf8').slice(0, 200)
      if (!head.includes(GENERATED_MARKER)) continue // 人写的文件一律不碰
      rmSync(full)
      result.pruned.push(entry)
    }
  }
  return result
}

/** 一步到位：读库 → 分组 → 写文件 */
export async function exportMirror(
  deps: ExportDeps,
  options: { outDir: string; dryRun?: boolean; now?: Date },
): Promise<ExportResult> {
  const docs = await listExportable(deps)
  const groups = groupByDomain(docs)
  const meta: ExportMeta = {
    generatedAt: options.now ?? new Date(),
    teamIndex: deps.teamIndex,
    endpoint: deps.endpoint,
  }
  return writeMirror(options.outDir, groups, meta, { dryRun: options.dryRun === true })
}
