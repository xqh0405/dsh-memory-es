/**
 * 插件自更新：每天检查 GitHub Release，有新版本就「体检 → 安装 → 延迟重启」。
 *
 * 分工（2026-11-11 与用户确认的口径）：
 *  · ES 是**共享的**（125 上一套 dsh-es 服务全部容器），索引迁移只做一次；
 *  · 管理员实例（`update.migrate = true`）负责补字段，**先迁移、后换代码**；
 *  · 成员实例只换代码，升级前做一次**只读体检**：新模板要求的字段不在自己索引里就跳过，
 *    等下一轮（这时管理员多半已经迁完了）。
 *
 * 为什么不用模型现编迁移：字段的期望值只有一份来源（`scripts/init-indices.sh` 的模板），
 * 补字段就是 `PUT _mapping` 加缺的那些键——确定性、幂等、可复跑。模型只在失败时被叫一次做诊断。
 *
 * @module dsh-memory-es/update
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { minutesOfDay, zonedParts } from './timezone.ts'

/** 每天几点检查（配置 `update.at` 的默认值） */
export const DEFAULT_UPDATE_AT = '06:00'
/** 成员实例的默认仓库 */
export const DEFAULT_UPDATE_REPO = 'xqh0405/dsh-memory-es'
/** 安装成功到退出的等待：留时间把状态/日志落盘，也让当次对话先回一句 */
export const DEFAULT_RESTART_DELAY_MS = 60_000

/** 模板名 → 它管哪一类索引（个人库的四套模板） */
export const TEMPLATE_TO_INDEX_KIND = {
  personal_memory_template: 'memory',
  personal_doc_template: 'doc',
  search_log_template: 'searchLog',
  personal_audit_template: 'audit',
} as const

export type IndexKind = (typeof TEMPLATE_TO_INDEX_KIND)[keyof typeof TEMPLATE_TO_INDEX_KIND]

/** 一条字段定义（`{ "type": "keyword" }` 这种），值原样保留 */
export type FieldSpec = Record<string, unknown>
/** 模板名 → 字段名 → 定义 */
export type TemplateMap = Record<string, Record<string, FieldSpec>>

export interface MappingDiff {
  /** 模板要求、索引没有的字段 */
  additions: string[]
  /** 两边都有但定义不同（类型/分词器/维度）——这种**不能**自动改，必须人工 */
  typeChanges: Array<{ field: string; from: string; to: string }>
  /** 索引有、模板没有的字段：历史遗留，只用于展示，不阻塞 */
  extra: string[]
}

export type UpdatePlan =
  | { action: 'skip'; reason: string }
  | { action: 'wait-index'; additions: string[] }
  | { action: 'manual'; reason: string; additions: string[]; typeChanges: string[] }
  | { action: 'migrate-then-install'; additions: string[] }
  | { action: 'install' }

export interface UpdateState {
  lastCheckDate?: string
  lastCheckAt?: string
  lastResult?: string
  lastAction?: string
  localVersion?: string
  releaseVersion?: string
  additions?: string[]
  typeChanges?: string[]
  /** 防重启死循环：同一版本当天只尝试一次 */
  lastAttemptVersion?: string
  lastAttemptDate?: string
  diagnostics?: string
}

export interface UpdateOutcome {
  action: 'skipped' | 'wait-index' | 'manual' | 'updated' | 'failed'
  reason: string
  localVersion: string
  releaseVersion?: string
  additions?: string[]
  typeChanges?: string[]
  detail?: string
}

/** 三段版本比较：`0.6.54` > `0.6.9`（字符串比较会得出相反的错误结论） */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const clean = value.trim().replace(/^v/i, '')
    const parts = clean.split('.').map((part) => {
      const n = Number.parseInt(part, 10)
      return Number.isFinite(n) ? n : 0
    })
    while (parts.length < 3) parts.push(0)
    return parts.slice(0, 3)
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1
  }
  return 0
}

/**
 * 今天该不该检查：到点了吗、今天查过没有。
 *
 * 与 journal 同口径（按配置时区算，容器跑 UTC 也不会错位）：
 * 每 5 分钟醒一次，没到点直接 return，零网络请求。
 */
export function isDue(
  at: string,
  timeZone: string,
  lastCheckedDate: string | undefined,
  now: Date,
): boolean {
  const parts = zonedParts(now, timeZone)
  if (lastCheckedDate !== undefined && parts.date === lastCheckedDate) return false
  const due = minutesOfDay(at, { hour: 6, minute: 0 })
  return parts.hour * 60 + parts.minute >= due
}

/**
 * 从 `init-indices.sh` 里解析出各模板的字段定义。
 *
 * 格式固定：`es_quiet -X PUT "$ES/_index_template/<名字>" -d @- <<'JSON'` + JSON + 单独一行 `JSON`。
 * 解析失败（不是合法 JSON）就跳过那一段——解析是自更新的前置，宁可少判也不要误判。
 */
export function parseTemplates(script: string): TemplateMap {
  const out: TemplateMap = {}
  const parts = script.split("<<'JSON'\n")
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i]!
    const end = chunk.indexOf('\nJSON')
    if (end < 0) continue
    // 模板名写在 heredoc 前一行（属于上一个分片的尾部）
    const before = parts[i - 1] ?? ''
    const names = [...before.matchAll(/_index_template\/([A-Za-z0-9_]+)/g)]
    const name = names.at(-1)?.[1]
    if (name === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(chunk.slice(0, end))
    } catch {
      continue
    }
    const properties = (parsed as { template?: { mappings?: { properties?: unknown } } })
      ?.template?.mappings?.properties
    if (properties === null || typeof properties !== 'object') continue
    out[name] = properties as Record<string, FieldSpec>
  }
  return out
}

/** 字段定义里「真正影响写入兼容性」的那几项；空对象按 object 处理 */
function fieldSignature(spec: FieldSpec | undefined): string {
  if (spec === undefined) return 'object'
  const type = typeof spec.type === 'string' ? spec.type : 'object'
  const analyzer = typeof spec.analyzer === 'string' ? spec.analyzer : ''
  const searchAnalyzer = typeof spec.search_analyzer === 'string' ? spec.search_analyzer : ''
  const dims = spec.dims === undefined ? '' : String(spec.dims)
  return `${type}|${analyzer}|${searchAnalyzer}|${dims}`
}

/** 模板（期望）与索引（现状）逐字段比对 */
export function diffMapping(
  expected: Record<string, FieldSpec>,
  current: Record<string, FieldSpec>,
): MappingDiff {
  const additions: string[] = []
  const typeChanges: Array<{ field: string; from: string; to: string }> = []
  for (const [field, spec] of Object.entries(expected)) {
    const have = current[field]
    if (have === undefined) {
      additions.push(field)
      continue
    }
    const from = fieldSignature(have)
    const to = fieldSignature(spec)
    if (from !== to) typeChanges.push({ field, from, to })
  }
  const extra = Object.keys(current).filter((field) => expected[field] === undefined).sort()
  return { additions: additions.sort(), typeChanges, extra }
}

/** 决策：这一步该做什么（纯函数，便于把边界钉在测试里） */
export function planUpdate(input: {
  localVersion: string
  releaseVersion: string
  mode: 'member' | 'migrate'
  additions: string[]
  typeChanges: Array<{ field: string; from: string; to: string }>
}): UpdatePlan {
  if (compareVersions(input.releaseVersion, input.localVersion) <= 0) {
    return { action: 'skip', reason: `已是最新（本地 ${input.localVersion} ≥ Release ${input.releaseVersion}）` }
  }
  // 类型/分词器变化一律不自动处理：ES 不允许改已有字段类型，只能 reindex，风险太高
  if (input.typeChanges.length > 0) {
    return {
      action: 'manual',
      reason: '新版本改了已有字段的类型或分词器，需要人工 reindex',
      additions: input.additions,
      typeChanges: input.typeChanges.map((item) => item.field),
    }
  }
  if (input.mode === 'member') {
    if (input.additions.length > 0) return { action: 'wait-index', additions: input.additions }
    return { action: 'install' }
  }
  if (input.additions.length > 0) return { action: 'migrate-then-install', additions: input.additions }
  return { action: 'install' }
}

// ── 下面是 IO 编排：只做流程，判定都在上面的纯函数里 ───────────────────────────

interface ReleaseAsset {
  name: string
  url: string
}

export interface UpdateDeps {
  /** member = 只换代码；migrate = 管理员实例，负责补字段 */
  mode: 'member' | 'migrate'
  /** 状态与日志目录（`~/.dsh/memory-es/update`） */
  stateDir: string
  /** 已安装的插件目录（`<dshHome>/local-plugins/dsh-memory-es`） */
  pluginDir: string
  dshHome: string
  profile: string
  localVersion: string
  repo: string
  timeZone: string
  /** 管理员模式下的检查时间，只用于记录 */
  at: string
  restartDelayMs: number
  indexes: Record<IndexKind, string>
  es: {
    getMapping: (indexName: string) => Promise<Record<string, Record<string, unknown>>>
    putMapping: (indexName: string, properties: Record<string, unknown>) => Promise<void>
  }
  log: (message: string) => void
  now: () => Date
  /** 让进程退出、由 systemd / 容器策略拉起新代码 */
  exit: (code: number) => void
  /** 只检查不安装（面板「立即检查」） */
  dryRun?: boolean
  /** 迁移失败时的诊断（有模型才给）；返回值写进 state 供面板显示 */
  diagnose?: (input: { error: string; additions: string[]; typeChanges: string[] }) => Promise<string | null>
  /** 测试注入 */
  fetchImpl?: typeof fetch
  spawn?: typeof spawnSync
}

function logLine(dir: string, message: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'update.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 日志写不进去不能反过来影响更新流程
  }
}

export function readUpdateState(dir: string): UpdateState {
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as UpdateState
  } catch {
    return {}
  }
}

function writeState(dir: string, state: UpdateState): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 同上：状态是观测信息
  }
}

/** 拿锁；拿不到返回 null。超过 30 分钟的锁视为上次进程死掉留下的 */
function acquireLock(dir: string, now: Date): string | null {
  const path = join(dir, 'update.lock')
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(path)) {
      try {
        const info = JSON.parse(readFileSync(path, 'utf8')) as { at?: number }
        const age = now.getTime() - (typeof info.at === 'number' ? info.at : 0)
        if (age < 30 * 60_000) return null
      } catch {
        // 坏锁文件当陈旧锁处理
      }
    }
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: now.getTime() })}\n`, 'utf8')
    return path
  } catch {
    return null
  }
}

function releaseLock(path: string | null): void {
  if (path === null) return
  try {
    rmSync(path, { force: true })
  } catch {
    // 忽略
  }
}

async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch,
): Promise<{ version: string; assets: ReleaseAsset[] } | null> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-memory-es-update',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return null
  const body = (await response.json()) as {
    tag_name?: unknown
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
  }
  const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : ''
  if (!/^\d+\.\d+\.\d+$/.test(tag)) return null
  const assets: ReleaseAsset[] = []
  for (const item of body.assets ?? []) {
    if (typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') continue
    assets.push({ name: item.name, url: item.browser_download_url })
  }
  return { version: tag, assets }
}

async function download(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'dsh-memory-es-update' },
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, buffer)
}

/** 读 `.sha256` 文件里的第一个字段（格式：`<hex>  <文件名>`） */
function readExpectedSha(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? '').toLowerCase()
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toLowerCase()
}

/** 解包；返回解出来的根目录（tar.gz 顶层就是 `dsh-memory-es-<ver>`） */
function extractPackage(
  archive: string,
  workDir: string,
  version: string,
  spawn: typeof spawnSync,
): string {
  const target = join(workDir, `dsh-memory-es-${version}`)
  const result = spawn('tar', ['xzf', archive, '-C', workDir], { encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) {
    throw new Error(`解包失败：${String(result.stderr ?? result.error ?? '').slice(0, 200)}`)
  }
  return target
}

/** 发行包里模板脚本的位置（打包后的布局是 `es/scripts/`，仓库里是 `scripts/`） */
function findTemplateScript(extractDir: string): string | null {
  const candidates = [join(extractDir, 'es/scripts/init-indices.sh'), join(extractDir, 'scripts/init-indices.sh')]
  for (const path of candidates) if (existsSync(path)) return path
  return null
}

/** 收集「模板 vs 各索引」的差异；索引不存在（404）视为无差异 */
async function collectDiff(
  templates: TemplateMap,
  indexes: Record<IndexKind, string>,
  es: UpdateDeps['es'],
  log: (message: string) => void,
): Promise<{ diffs: Array<{ kind: IndexKind; index: string; diff: MappingDiff }>; additions: string[]; typeChanges: Array<{ field: string; from: string; to: string }> }> {
  const diffs: Array<{ kind: IndexKind; index: string; diff: MappingDiff }> = []
  const additions: string[] = []
  const typeChanges: Array<{ field: string; from: string; to: string }> = []
  for (const [templateName, kind] of Object.entries(TEMPLATE_TO_INDEX_KIND) as Array<[string, IndexKind]>) {
    const expected = templates[templateName]
    if (expected === undefined) continue
    const index = indexes[kind]
    let current: Record<string, Record<string, unknown>> = {}
    try {
      current = await es.getMapping(index)
    } catch (err) {
      // 404 = 索引还没建（新用户），模板会在创建时生效，无需迁移
      const message = String(err)
      if (/not_found|404/i.test(message)) {
        log(`索引 ${index} 不存在，跳过体检`)
        continue
      }
      throw err
    }
    const properties = Object.values(current)[0] ?? {}
    const diff = diffMapping(expected, properties as Record<string, FieldSpec>)
    diffs.push({ kind, index, diff })
    for (const field of diff.additions) additions.push(`${index}:${field}`)
    for (const change of diff.typeChanges) typeChanges.push(change)
  }
  return { diffs, additions, typeChanges }
}

/** 备份当前代码，失败可人工回滚 */
function backupCurrent(pluginDir: string, stateDir: string, version: string): void {
  const target = join(stateDir, `prev-${version}`)
  try {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    cpSync(join(pluginDir, 'lib'), join(target, 'lib'), { recursive: true })
    cpSync(join(pluginDir, 'panel'), join(target, 'panel'), { recursive: true })
    // 只留最近两份，避免长年累积
    const prev = readdirSync(stateDir).filter((name) => name.startsWith('prev-')).sort()
    for (const name of prev.slice(0, Math.max(0, prev.length - 2))) {
      rmSync(join(stateDir, name), { recursive: true, force: true })
    }
  } catch (err) {
    logLine(stateDir, `备份旧代码失败（继续安装）：${String(err).slice(0, 200)}`)
  }
}

/**
 * 跑一轮更新。**不自己决定退出**：返回 outcome 后由调用方（定时器/脚本）决定是否重启。
 * 唯一例外是「装好了」——这时会按 `restartDelayMs` 安排 `deps.exit(0)`。
 */
export async function runUpdate(deps: UpdateDeps): Promise<UpdateOutcome> {
  const now = deps.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const spawn = deps.spawn ?? spawnSync
  const state = readUpdateState(deps.stateDir)
  const today = zonedParts(now, deps.timeZone).date
  const finish = (outcome: UpdateOutcome): UpdateOutcome => {
    writeState(deps.stateDir, {
      ...state,
      lastCheckDate: today,
      lastCheckAt: now.toISOString(),
      lastResult: outcome.reason,
      lastAction: outcome.action,
      localVersion: deps.localVersion,
      releaseVersion: outcome.releaseVersion ?? state.releaseVersion,
      additions: outcome.additions ?? [],
      typeChanges: outcome.typeChanges ?? [],
    })
    logLine(deps.stateDir, `${outcome.action}：${outcome.reason}`)
    return outcome
  }

  const lock = acquireLock(deps.stateDir, now)
  if (lock === null) {
    return finish({ action: 'skipped', reason: '已有更新任务在跑（锁被占用）', localVersion: deps.localVersion })
  }

  try {
    deps.log(`检查更新：本地 ${deps.localVersion}，仓库 ${deps.repo}`)
    const release = await fetchLatestRelease(deps.repo, fetchImpl)
    if (release === null) {
      return finish({ action: 'skipped', reason: '查最新版本失败（网络或 API 异常），本轮跳过', localVersion: deps.localVersion })
    }
    // 防重启死循环：这个版本已经装过、但进程版本号没变（install.sh 装到了别处、
    // 或重启没成功）。**跨天也不重试**——否则会每天装一次、重启一次，而版本永远不变。
    if (state.lastAttemptVersion === release.version) {
      return finish({
        action: 'skipped',
        reason: `v${release.version} 已尝试安装但当前仍是 v${deps.localVersion}，自动更新不再重试（请人工确认安装路径与重启方式）`,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
    }
    if (compareVersions(release.version, deps.localVersion) <= 0) {
      return finish({
        action: 'skipped',
        reason: `已是最新（本地 ${deps.localVersion} ≥ Release ${release.version}）`,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
    }

    // 下载包与校验文件
    const archiveName = `dsh-memory-es-${release.version}.tar.gz`
    const archiveAsset = release.assets.find((item) => item.name === archiveName)
    const shaAsset = release.assets.find((item) => item.name === `${archiveName}.sha256`)
    if (archiveAsset === undefined || shaAsset === undefined) {
      return finish({
        action: 'failed',
        reason: `Release v${release.version} 缺少发行包或 sha256（跳过，不装没校验的包）`,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
    }

    const workDir = join(deps.stateDir, 'work')
    rmSync(workDir, { recursive: true, force: true })
    mkdirSync(workDir, { recursive: true })
    const archivePath = join(workDir, archiveName)
    const shaPath = join(workDir, `${archiveName}.sha256`)
    await download(archiveAsset.url, archivePath, fetchImpl)
    await download(shaAsset.url, shaPath, fetchImpl)
    const expected = readExpectedSha(readFileSync(shaPath, 'utf8'))
    const actual = fileSha(archivePath)
    if (expected === '' || expected !== actual) {
      return finish({
        action: 'failed',
        reason: `sha256 校验失败（期望 ${expected.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…），丢弃该包`,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
    }

    const extractDir = extractPackage(archivePath, workDir, release.version, spawn)
    const templateScript = findTemplateScript(extractDir)
    if (templateScript === null) {
      return finish({
        action: 'failed',
        reason: '发行包里找不到 init-indices.sh，无法体检索引',
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
    }
    const templates = parseTemplates(readFileSync(templateScript, 'utf8'))
    const { diffs, additions, typeChanges } = await collectDiff(templates, deps.indexes, deps.es, deps.log)

    const plan = planUpdate({
      localVersion: deps.localVersion,
      releaseVersion: release.version,
      mode: deps.mode,
      additions,
      typeChanges,
    })

    if (plan.action === 'skip') {
      return finish({
        action: 'skipped',
        reason: plan.reason,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
    }
    if (plan.action === 'wait-index') {
      return finish({
        action: 'wait-index',
        reason: `索引未就绪（缺 ${additions.length} 个字段），等管理员先迁移；本轮不升级`,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
        additions,
      })
    }
    if (plan.action === 'manual') {
      return finish({
        action: 'manual',
        reason: plan.reason,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
        additions,
        typeChanges: plan.typeChanges,
      })
    }

    if (deps.dryRun === true) {
      return finish({
        action: 'skipped',
        reason: `只检查：可以升级到 v${release.version}（${plan.action}，新增字段 ${additions.length} 个）`,
        localVersion: deps.localVersion,
        releaseVersion: release.version,
        additions,
      })
    }

    // 管理员实例：先补字段，补完校验，全部成功才换代码
    if (plan.action === 'migrate-then-install') {
      try {
        for (const item of diffs) {
          if (item.diff.additions.length === 0) continue
          const expected = templates[
            (Object.entries(TEMPLATE_TO_INDEX_KIND).find(([, kind]) => kind === item.kind)?.[0]) ?? ''
          ]
          if (expected === undefined) continue
          const properties: Record<string, unknown> = {}
          for (const field of item.diff.additions) properties[field] = expected[field]
          await deps.es.putMapping(item.index, properties)
          deps.log(`已补字段：${item.index} ← ${item.diff.additions.join(', ')}`)
        }
      } catch (err) {
        const error = String(err)
        let diagnostics: string | null = null
        if (deps.diagnose !== undefined) {
          try {
            diagnostics = await deps.diagnose({ error, additions, typeChanges: typeChanges.map((c) => c.field) })
          } catch {
            diagnostics = null
          }
        }
        writeState(deps.stateDir, {
          ...state,
          lastCheckDate: today,
          lastCheckAt: now.toISOString(),
          lastResult: `迁移失败：${error.slice(0, 300)}`,
          lastAction: 'migrate-failed',
          localVersion: deps.localVersion,
          releaseVersion: release.version,
          additions,
          diagnostics: diagnostics ?? '',
        })
        logLine(deps.stateDir, `迁移失败：${error.slice(0, 300)}`)
        return {
          action: 'failed',
          reason: '索引迁移失败，未安装新代码',
          localVersion: deps.localVersion,
          releaseVersion: release.version,
          additions,
          detail: diagnostics ?? error.slice(0, 300),
        }
      }
    }

    // 换代码前留证据
    backupCurrent(deps.pluginDir, deps.stateDir, deps.localVersion)

    const install = spawn(
      'bash',
      [
        join(extractDir, 'install.sh'),
        '--dsh-home',
        deps.dshHome,
        '--profile',
        deps.profile,
        '--skip-selfcheck',
      ],
      { cwd: extractDir, encoding: 'utf8', timeout: 10 * 60_000 },
    )
    if (install.status !== 0) {
      const detail = String(install.stderr ?? install.error ?? install.stdout ?? '').slice(0, 400)
      writeState(deps.stateDir, {
        ...state,
        lastAttemptVersion: release.version,
        lastAttemptDate: today,
        lastCheckDate: today,
        lastCheckAt: now.toISOString(),
        lastResult: `安装失败：${detail}`,
        lastAction: 'install-failed',
        // 失败时清掉上一次的诊断，避免面板显示过期的建议
        diagnostics: '',
        localVersion: deps.localVersion,
        releaseVersion: release.version,
      })
      logLine(deps.stateDir, `install.sh 失败（未重启）：${detail}`)
      return {
        action: 'failed',
        reason: 'install.sh 失败，保持旧代码运行',
        localVersion: deps.localVersion,
        releaseVersion: release.version,
        detail,
      }
    }

    writeState(deps.stateDir, {
      ...state,
      lastAttemptVersion: release.version,
      lastAttemptDate: today,
      lastCheckDate: today,
      lastCheckAt: now.toISOString(),
      lastResult: `已安装 v${release.version}，${Math.round(deps.restartDelayMs / 1000)} 秒后重启生效`,
      lastAction: 'installed',
      diagnostics: '',
      localVersion: deps.localVersion,
      releaseVersion: release.version,
      additions,
      typeChanges: [],
    })
    logLine(deps.stateDir, `v${release.version} 已安装，准备重启`)

    // 退出后由 systemd / docker restart policy 拉起（本机 Restart=always、容器 unless-stopped）
    setTimeout(() => deps.exit(0), deps.restartDelayMs)
    return {
      action: 'updated',
      reason: `已安装 v${release.version}，${Math.round(deps.restartDelayMs / 1000)} 秒后重启生效`,
      localVersion: deps.localVersion,
      releaseVersion: release.version,
      additions,
    }
  } catch (err) {
    const message = String(err).slice(0, 300)
    return finish({ action: 'failed', reason: `更新失败：${message}`, localVersion: deps.localVersion })
  } finally {
    releaseLock(lock)
  }
}
