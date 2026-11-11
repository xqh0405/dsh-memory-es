/**
 * `dynamic:strict` 的**写入闸**（2026-11-11 审查 #31）。
 * 索引全是 `dynamic: strict`：代码写一个映射里没有的字段，真 ES 直接 400
 * `strict_dynamic_mapping_exception`、整条 memory_save 失败。但 fake-es 从不
 * 校验 mapping，写路径测试天然测不出 400 —— 历史 19 个字段缺口就是这么漏的。
 * 这里现解析 init-indices.sh 的模板（与 check-index-fields.py 同源），供 fake-es 上闸。
 *
 * 数据源只有 `scripts/init-indices.sh` 一份（**不另存副本**）：脚本里喂给 curl 的
 * JSON 都是 `<<'JSON'` … 单独一行 `JSON` 的 heredoc，抽出来逐段 parse 即可。
 * 两种形态：
 *   1. index_template：`{index_patterns:[...], template:{mappings:{dynamic:'strict', properties:{...}}}}`
 *   2. 裸 mapping：`{mappings:{dynamic:'strict', properties:{...}}}`，索引名从 heredoc
 *      上文约 400 字的 shell 文本里找 `put_index <名字>`；`$VAR` 再查脚本里的
 *      `VAR="..."` 定义，把其中的 `$WORD` 段换成 `*` 当通配。
 * 只收 `dynamic === 'strict'` 的；`ruleCount` 为 0 说明解析坏了（闸会静默失效，必须能被发现）。
 * @module dsh-memory-es/tests/helpers/mapping-gate
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const INIT_SH = fileURLToPath(new URL('../../scripts/init-indices.sh', import.meta.url))

/** heredoc 起止标记：`<<'JSON'` 后紧跟内容，以单独一行 `JSON` 收尾 */
const HEREDOC_RE = /<<'JSON'\n([\s\S]*?)\nJSON/g

/** 裸 mapping 取索引名时往前看的上文窗口（字符数） */
const CONTEXT_WINDOW = 400

/** 一条 strict 映射规则（按模式匹配） */
export interface PatternRule {
  patterns: string[]
  properties: Set<string>
  /** 来源：该 heredoc 前面那行 shell 命令原文，便于排查解析错了哪一段 */
  source: string
}

export interface TemplateIndex {
  byPattern: PatternRule[]
  /** 按字面索引名精确匹配（裸 mapping 且名字不含 `$` 时进这里） */
  byName: Map<string, Set<string>>
  /** 解析到的规则数；0 说明解析坏了 —— 那样闸会静默失效，必须有人发现 */
  ruleCount: number
}

/** 模块级缓存：脚本只在进程里读一次 */
let cached: TemplateIndex | null = null

/** JSON 对象（排除 null / 数组） */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 解析失败返回 null（调用方跳过该段） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 取 heredoc 标记所在那一行的 shell 命令（作为 source） */
function commandLineOf(script: string, markerStart: number): string {
  const lineStart = script.lastIndexOf('\n', markerStart - 1) + 1
  return script.slice(lineStart, markerStart).trim()
}

/** 从 heredoc 上文里取最后一个 `put_index <名字>`（剥掉引号）；找不到返回 '' */
function indexNameFromContext(context: string): string {
  const re = /put_index\s+("[^"]*"|[^\s]+)/g
  let last = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(context)) !== null) {
    last = m[1].replace(/^"|"$/g, '')
  }
  return last
}

/**
 * `$VAR` 形态：查脚本里的 `VAR="value"` 定义，把 value 里的 `$WORD` 段换成 `*`。
 * 查不到定义（或定义里没有 `$`）时原样返回，由调用方按字面名处理。
 */
function resolveShellVar(script: string, name: string): string {
  if (!name.startsWith('$')) return name
  const varName = name.slice(1)
  if (varName === '') return name
  const def = new RegExp(`^${varName}="([^"]*)"`, 'm').exec(script)
  if (!def) return name
  // `personal_memory_$USER_ID` → `personal_memory_*`（`$USER_ID` 这种变量段当通配）
  return def[1].replace(/\$\w+/g, '*')
}

/** 把 `personal_memory_*` 这样的通配转成整串匹配的正则（只让 `*` 当通配） */
function wildcardToRegExp(pattern: string): RegExp {
  const src = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${src}$`)
}

/**
 * 解析 `scripts/init-indices.sh` 里的全部 strict 映射规则（带模块级缓存）。
 * 读不到脚本 / 某段 JSON 解析失败 → 该段跳过；全坏时 `ruleCount` 为 0。
 */
export function loadTemplates(): TemplateIndex {
  if (cached) return cached

  const byPattern: PatternRule[] = []
  const byName = new Map<string, Set<string>>()
  let ruleCount = 0
  let script = ''
  try {
    script = readFileSync(INIT_SH, 'utf8')
  } catch {
    // 读不到数据源：返回空规则集，ruleCount=0 让调用方能发现
    cached = { byPattern, byName, ruleCount }
    return cached
  }

  HEREDOC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEREDOC_RE.exec(script)) !== null) {
    const parsed = parseJson(m[1])
    if (!isRecord(parsed)) continue

    const markerStart = m.index
    const source = commandLineOf(script, markerStart)

    // 形态 1：index_template（index_patterns + template.mappings）
    const tmpl = isRecord(parsed.template) ? parsed.template : null
    const mappings1 = tmpl && isRecord(tmpl.mappings) ? tmpl.mappings : null
    if (Array.isArray(parsed.index_patterns) && mappings1) {
      if (mappings1.dynamic !== 'strict' || !isRecord(mappings1.properties)) continue
      const patterns = parsed.index_patterns.filter((p): p is string => typeof p === 'string')
      if (patterns.length === 0) continue
      byPattern.push({ patterns, properties: new Set(Object.keys(mappings1.properties)), source })
      ruleCount += 1
      continue
    }

    // 形态 2：裸 mapping（顶层直接 mappings），索引名从上文的 `put_index <名字>` 取
    const mappings2 = isRecord(parsed.mappings) ? parsed.mappings : null
    if (mappings2) {
      if (mappings2.dynamic !== 'strict' || !isRecord(mappings2.properties)) continue
      const context = script.slice(Math.max(0, markerStart - CONTEXT_WINDOW), markerStart)
      const rawName = indexNameFromContext(context)
      if (rawName === '') continue
      const name = resolveShellVar(script, rawName)
      const properties = new Set(Object.keys(mappings2.properties))
      if (name.includes('*')) {
        // 变量段换成了 `*`（如 personal_memory_*）→ 只能当模式匹配
        byPattern.push({ patterns: [name], properties, source })
      } else {
        byName.set(name, properties)
      }
      ruleCount += 1
    }
  }

  cached = { byPattern, byName, ruleCount }
  return cached
}

/**
 * 查某个索引的顶层字段集合：先精确匹配 byName，再按模式（`*` 转通配）匹配 byPattern。
 * 没有映射返回 undefined —— 调用方据此**跳过不判**（映射未知时不能瞎报违规）。
 */
export function propertiesFor(index: string): Set<string> | undefined {
  const { byPattern, byName } = loadTemplates()
  const exact = byName.get(index)
  if (exact) return exact
  for (const rule of byPattern) {
    for (const pattern of rule.patterns) {
      if (wildcardToRegExp(pattern).test(index)) return rule.properties
    }
  }
  return undefined
}

/**
 * 写入闸：返回 doc 顶层里**不在映射中**的键（就是真 ES 会 400 的那些字段）。
 * 映射未知、或 doc 不是普通对象（null / 数组 / 原始值）时返回 `[]`（不判）。
 */
export function strictViolations(index: string, doc: unknown): string[] {
  const props = propertiesFor(index)
  if (!props) return []
  if (!isRecord(doc)) return []
  const missing: string[] = []
  for (const key of Object.keys(doc)) {
    if (!props.has(key)) missing.push(key)
  }
  return missing
}

/** 从请求里解析出的写操作：一次写 = 一个目标索引 + 一份顶层文档 */
export interface WriteOp {
  index: string
  doc: Record<string, unknown>
}

/** 安全 JSON.parse：失败返回 null */
function tryParseObj(text: string): Record<string, unknown> | null {
  const v = parseJson(text)
  return isRecord(v) ? v : null
}

/** NDJSON action 行里允许带 source 的三种动作（delete 没有 source 行） */
const BULK_SOURCE_ACTIONS = new Set(['index', 'create', 'update'])

/**
 * 从一次 HTTP 写请求里抽出「写了哪个索引的哪些顶层字段」。
 *
 * 支持三种形态：
 *  · `POST|PUT /<idx>/_doc[/<id>]` —— body 就是文档本身；
 *  · `POST|PUT /<idx>/_update/<id>` —— 文档在 body 的 `.doc` 里；
 *  · `POST /_bulk` —— NDJSON：action 行带 `index|create|update` 与 `_index`，
 *    下一行是 source；`update` 动作取 `source.doc`，其余取 source 本身。
 * 其余请求（查询、建索引、delete 等）返回 `[]`。
 */
export function extractWrites(method: string, path: string, body: string): WriteOp[] {
  const verb = method.toUpperCase()
  const segs = path.split('?')[0]!.split('/').filter(Boolean)
  const out: WriteOp[] = []
  if (segs.length === 0) return out

  // POST|PUT /<idx>/_doc[/<id>]
  if (segs[1] === '_doc') {
    if (verb !== 'POST' && verb !== 'PUT') return out
    const doc = tryParseObj(body)
    if (doc) out.push({ index: segs[0]!, doc })
    return out
  }

  // POST|PUT /<idx>/_update/<id> —— 文档在 .doc 里
  if (segs[1] === '_update') {
    if (verb !== 'POST' && verb !== 'PUT') return out
    const bodyObj = tryParseObj(body)
    if (bodyObj && isRecord(bodyObj.doc)) out.push({ index: segs[0]!, doc: bodyObj.doc })
    return out
  }

  // POST /_bulk（也兼容 /<idx>/_bulk：没带 _index 的 action 行回落到路径里的索引）
  const isRootBulk = segs[0] === '_bulk'
  const bulkIndex = !isRootBulk && segs.length === 2 && segs[1] === '_bulk' ? segs[0]! : undefined
  if (isRootBulk || bulkIndex !== undefined) {
    if (verb !== 'POST' && verb !== 'PUT') return out
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line === '') continue
      const action = tryParseObj(line)
      if (!action) continue
      // 找 action 行里的 index|create|update（delete 等没有 source 行，直接跳过）
      const actionKey = Object.keys(action).find((k) => BULK_SOURCE_ACTIONS.has(k))
      if (actionKey === undefined) continue
      const meta = action[actionKey]
      const index = isRecord(meta) && typeof meta._index === 'string' ? meta._index : bulkIndex
      // 无论 source 是否有效，都要消费掉这一行（它属于当前 action）
      const srcLine = lines[i + 1]
      i += 1
      if (index === undefined || srcLine === undefined) continue
      const source = tryParseObj(srcLine)
      if (!source) continue
      const doc = actionKey === 'update' ? (isRecord(source.doc) ? source.doc : null) : source
      if (doc) out.push({ index, doc })
    }
    return out
  }

  return out
}

/**
 * 造一份与真 ES **同形**的 400 响应体（fake-es 用它回 `strict_dynamic_mapping_exception`）。
 * reason 文案对齐真 ES：`mapping set to strict, dynamic introduction of fields [a, b] within [<index>] is not allowed`
 */
export function strictErrorBody(missing: string[], index: string): Record<string, unknown> {
  const type = 'strict_dynamic_mapping_exception'
  const reason = `mapping set to strict, dynamic introduction of fields [${missing.join(', ')}] within [${index}] is not allowed`
  return {
    error: { type, reason, root_cause: [{ type, reason }] },
    status: 400,
  }
}
