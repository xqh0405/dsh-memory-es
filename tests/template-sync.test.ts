/**
 * 索引模板的一致性闸（2026-11-10 审查 P2/#18）。
 *
 * 背景：`PUT _index_template` 是**整体替换**。7 个脚本里有 5 个一直用「awk 现场提取
 * init-indices.sh 的模板」，而 `migrate-s9.sh` 与 `migrate-journal-fields.sh` 手抄了
 * 一份子集贴进去 —— 重跑一次就把模板从 **51 字段**打到 **22 / 44**，
 * 一次性删掉 origin / pinned / quarantine_reason / related / activation / hit_count…
 * 危害是**延迟发作**的：要等之后新建用户索引才缺字段，新用户第一次 memory_save 就 400
 * （strict_dynamic_mapping_exception），极难回溯到「某次重跑迁移」。
 * 线上当时 51 字段完好，属于还没发作 → 趁没发作把这个形态钉死。
 *
 * 本文件守三件事（都不需要 ES，CI 可跑）：
 *   1. init-indices.sh 里**每个 JSON heredoc 都能 JSON.parse** ——
 *      2026-11-10 我自己踩过：往 heredoc 里插 `//` 注释（JSON 不支持）会让整份 PUT 解析失败；
 *   2. 个人模板含**核心字段集**（缺它们 = 新建索引一写就 400）；
 *   3. 除 init-indices.sh 外，任何 `PUT _index_template/personal_memory_template`
 *      的脚本必须走现场提取，**不许再出现内联手抄模板**。
 *
 * @module dsh-memory-es/tests/template-sync
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'

const INIT = new URL('../scripts/init-indices.sh', import.meta.url)
const SCRIPTS_DIR = new URL('../scripts/', import.meta.url)

const initSrc = readFileSync(INIT, 'utf8')

/** 把 shell 脚本里的所有 `<<'JSON' … JSON` 主体抠出来（按出现顺序）。 */
function jsonHeredocs(src: string): string[] {
  const out: string[] = []
  const re = /<<'JSON'\r?\n([\s\S]*?)\r?\nJSON/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(m[1])
  return out
}

/**
 * 「内联手抄个人模板」的形态：PUT 与 `<<'JSON'` 落在**同一行**。
 *
 * 两个 `[^\n]` 都不能省 —— 脚本后面还有逐索引 `PUT _mapping` 用的 `<<'JSON'`，
 * 跨行匹配会把那 5 个一直正确的脚本全误判成手抄（写这个测试时真踩了一次，4 个假阳性）。
 */
const INLINE_PERSONAL_TEMPLATE = /_index_template\/personal_memory_template[^\n]*-d @-[^\n]*<<'JSON'/

/** 取 init-indices.sh 里 index_patterns 为 personal_memory_* 的那份模板。 */
function personalTemplate(src: string): Record<string, unknown> | null {
  for (const body of jsonHeredocs(src)) {
    if (!body.includes('personal_memory_*')) continue
    return JSON.parse(body) as Record<string, unknown>
  }
  return null
}

function propertiesOf(template: Record<string, unknown>): Record<string, unknown> {
  const mappings = (template.template as { mappings?: { properties?: Record<string, unknown> } } | undefined)?.mappings
  return mappings?.properties ?? {}
}

describe('init-indices.sh 的 JSON 模板', () => {
  test(`每个 <<'JSON'>> 主体都能 JSON.parse（heredoc 里不许出现 // 之类的非法语法）`, () => {
    const bodies = jsonHeredocs(initSrc)
    assert.ok(bodies.length >= 2, `应至少有个人 + 团队两份模板，实际 ${bodies.length}`)
    bodies.forEach((body, i) => {
      assert.doesNotThrow(
        () => JSON.parse(body),
        `第 ${i + 1} 份 JSON heredoc 解析失败 —— 喂给 curl 的是 raw JSON，`
        + `一个 // 注释就会让整份 PUT 400（2026-11-10 实际踩过）。\n片段：${body.slice(0, 400)}`,
      )
    })
  })

  test('个人模板含核心字段集（缺哪个新建索引一写就 400）', () => {
    const tpl = personalTemplate(initSrc)
    assert.ok(tpl, '找不到 index_patterns=personal_memory_* 的模板')
    const props = propertiesOf(tpl!)
    const have = new Set(Object.keys(props))

    // 这批字段是「谁缺了谁会让 memory_save / 蒸馏 / 回写 400」的最小集合：
    // 前 29 个正是 migrate-s9.sh 手抄模板会删掉的那批，后几个是 journal/s9 自己要加的。
    const core = [
      'origin', 'pinned', 'quarantine_reason', 'related', 'activation',
      'hit_count', 'last_hit_at', 'forget_reason', 'confirmed_use', 'corrections',
      'feedback_at', 'content_exact', 'evidence_ids', 'expires_at', 'importance',
      'review_note', 'anchor', 'day', 'blocked_reason', 'review_state',
      'memory_id', 'content', 'embedding', 'status', 'created_at',
    ]
    const missing = core.filter((f) => !have.has(f))
    assert.deepEqual(
      missing,
      [],
      `个人模板缺核心字段 ${missing.length} 个：${missing.join(', ')}（init-indices.sh 是全仓唯一来源）`,
    )
    assert.ok(Object.keys(props).length >= 51, `个人模板字段数掉了：${Object.keys(props).length} < 51`)
  })
})

describe('迁移脚本：不许内联手抄模板', () => {
  /** scripts/ 下一层的**文件**名（readdirSync 会带出 lib/ 这类子目录，必须先滤掉） */
  const files = readdirSync(new URL('.', SCRIPTS_DIR))
    .map((f) => String(f))
    .filter((f) => f.endsWith('.sh'))

  test('脚本清单本身没漏（至少这 7 个脚本会 PUT 个人模板）', () => {
    const touching = files.filter((f) => {
      const s = readFileSync(new URL(f, SCRIPTS_DIR), 'utf8')
      return s.includes('_index_template/personal_memory_template')
    })
    for (const expected of [
      'init-indices.sh', 'migrate-s9.sh', 'migrate-journal-fields.sh',
      'migrate-origin-fields.sh', 'migrate-pinned-field.sh',
      'migrate-feedback-fields.sh', 'migrate-forget-reason-fields.sh',
    ]) {
      assert.ok(touching.includes(expected), `发现脚本清单里没有 ${expected}（新增的模板脚本要纳入本测试）`)
    }
  })

  test('除 init-indices.sh 外，一律现场提取；内联手抄模板 = 整体替换掉 51 字段', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (f === 'init-indices.sh') continue
      const s = readFileSync(new URL(f, SCRIPTS_DIR), 'utf8')
      if (!s.includes('_index_template/personal_memory_template')) continue

      // ⚠️ 两个正则都必须**限死在同一行**（[^\n]）：脚本后面还有别的 <<'JSON'
      // （逐索引 PUT _mapping 用的），跨行匹配会把那 5 个一直正确的脚本也误判成手抄。
      const inline = INLINE_PERSONAL_TEMPLATE.test(s)
      const extracted = s.includes('TEMPLATE_JSON=$(awk')
      if (inline || !extracted) offenders.push(f)
    }
    assert.deepEqual(
      offenders,
      [],
      `这些脚本手抄/未用现场提取模板：${offenders.join(', ')} —— `
      + 'PUT _index_template 是整体替换，手抄子集会把 51 字段打成 22/44，'
      + '删掉 origin/pinned/related/activation…；改用与 migrate-origin-fields.sh 同款的 '
      + 'TEMPLATE_JSON=$(awk ...) 现场提取。',
    )
  })

  test('检测器本身有效：改前的真原句必须命中，改后的新写法必须不命中', () => {
    // 拿 2026-11-10 修复前 migrate-s9.sh 的**真原句**当正样本 ——
    // 没有这条，检测器写错了也照样绿（正向测试只证明「现在的树是干净的」）。
    const beforeFix = 'admin -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null <<\'JSON\''
    const afterFix = 'admin -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null <<<"$TEMPLATE_JSON"'
    assert.match(beforeFix, INLINE_PERSONAL_TEMPLATE, '内联模板的原句必须被判为手抄')
    assert.doesNotMatch(afterFix, INLINE_PERSONAL_TEMPLATE, '现场提取的新写法不能被误判')
    // 对照：脚本后面逐索引 PUT _mapping 的 heredoc 不该影响判断（这正是当初 4 个假阳性的来源）
    assert.doesNotMatch(
      `printf '%s\\n' "$TEMPLATE_JSON" | es -X PUT "$ES/_index_template/personal_memory_template" -d @- >/dev/null\n\n` +
      'es -X PUT "$ES/$idx/_mapping" -d @- >/dev/null <<\'JSON\'',
      INLINE_PERSONAL_TEMPLATE,
      '跨行匹配必须不成立（否则 5 个正确脚本会被误判）',
    )
  })

  test('现场提取用的 awk 与规范写法一致（防止「写了 TEMPLATE_JSON 但抠错段」）', () => {
    // ⚠️ 只管**个人模板**：它是 init-indices.sh 的第一份 heredoc，所以「取第一份」就是规范写法。
    //    别的模板（如 migrate-search-log-fields.sh 抠 search_log_template）必须先按模板名标记
    //    再抓，用这条规范反而会抠错段 —— 那个脚本的 awk 是对的，不该被本断言误伤。
    const canonical = "TEMPLATE_JSON=$(awk '/<<'\"'\"'JSON'\"'\"'/{if(!started){started=1; next}} started && /^JSON$/{exit} started{print}'"
    for (const f of files) {
      const s = readFileSync(new URL(f, SCRIPTS_DIR), 'utf8')
      if (!s.includes('_index_template/personal_memory_template')) continue
      if (!s.includes('TEMPLATE_JSON=$(awk')) continue
      assert.ok(
        s.includes(canonical),
        `${f} 的 TEMPLATE_JSON 提取与规范 awk 不一致 —— 抠错段会让 PUT 变成空模板`,
      )
      assert.ok(
        s.includes('_index_template/personal_memory_template') && s.includes('TEMPLATE_JSON'),
        `${f} 取了 TEMPLATE_JSON 却没用上`,
      )
    }
  })
})

// ── 这道闸必须「接进流水线」且「drift 会红」，两条都是静默失效的形态 ──────────
describe('映射对拍的可执行性（#19）', () => {
  const ciYml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const checkerSrc = readFileSync(new URL('../scripts/lib/check-index-fields.py', import.meta.url), 'utf8')

  test('ci.yml 必须真的调 diff-index-fields.sh（只写在注释里不算）', () => {
    // #17 溜过去的原因就是这道闸只在本地手动跑。把步骤删了 → 本断言红 → CI 仍红，
    // 「删掉闸」这件事本身不可能静默。
    const runsDiff = /^[ \t-]*run:[ \t]*bash scripts\/diff-index-fields\.sh[ \t]*$/m.test(ciYml)
    assert.ok(
      runsDiff,
      'ci.yml 里找不到 `run: bash scripts/diff-index-fields.sh` —— '
      + '这道闸不进流水线就会像 #17 那样静默溜过（注释里提到它不算数，必须是可执行步骤）',
    )
    assert.ok(/name: 索引字段对拍/.test(ciYml), '步骤名「索引字段对拍」丢了，报告里认不出来')
  })

  test('check-index-fields.py 的退出码必须把 drift 算进去', () => {
    // 原来是 `return 1 if missing else 0` → REQUIRED 落后于代码时 CI 照样绿。
    assert.ok(
      /return 1 if \(missing or drift_promoter or drift_writeback\) else 0/.test(checkerSrc),
      'drift 必须参与退出码：只打警告不置 1，promote-team / HIT_UPDATE_SCRIPT 加新字段时 CI 会静默变绿',
    )
    // 防有人改回旧写法又不留痕迹
    assert.ok(
      !/^\s*return 1 if missing else 0\s*$/m.test(checkerSrc),
      '不许退回 `return 1 if missing else 0`（drift 只警告）',
    )
  })

  test('live 模式不许硬编码账号与个人索引名（改由调用方传）', () => {
    assert.ok(
      !/mem-user-xqh/.test(checkerSrc),
      'check-index-fields.py 仍硬编码 mem-user-xqh —— 换用户跑就 401，且只会报成一行含糊失败',
    )
    assert.ok(
      !/"personal_memory_xqh"/.test(checkerSrc),
      'check-index-fields.py 仍硬编码 personal_memory_xqh —— 会打到别人索引',
    )
    assert.ok(
      /es_user: str, personal_index: str/.test(checkerSrc),
      'fields_live 的账号与索引名必须由调用方传',
    )
  })
})
