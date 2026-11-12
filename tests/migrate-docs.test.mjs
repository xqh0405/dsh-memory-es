/**
 * `scripts/migrate-docs.py` 的切分与解析（2026-11-11 审查 #35）。
 *
 * 为什么值得测：这几个函数决定「文档怎么进索引」—— 切错了会让检索命中率下降，
 * 而且是**纯函数、零依赖**，测试成本远低于它保护的东西。原来零测试。
 *
 * 跨语言跑法：node 侧 spawn `python3`，把被测函数的结果以 JSON 带回来再断言。
 * 没有 python3 就整体 skip（不让缺 python 的机器红）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const PY = (() => {
  try {
    execFileSync('python3', ['-c', 'import sys'], { stdio: 'ignore' })
    return 'python3'
  } catch {
    return null
  }
})()
const skip = PY === null ? '本机没有 python3，跳过（切分逻辑只能在 python 里跑）' : false

/** 加载 migrate-docs.py 并执行一段代码，返回它 print 的最后一行 JSON */
function runPy(code) {
  const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('md', 'scripts/migrate-docs.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def emit(v):
    print(json.dumps(v, ensure_ascii=False))
${code}
`
  const out = execFileSync(PY, ['-c', script], { encoding: 'utf8', maxBuffer: 8 << 20 })
  const lines = out.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

describe('migrate-docs 切分', { skip }, () => {
  test('空文本 → 不产生块（别凭空造一条空文档）', () => {
    assert.deepEqual(runPy('emit(m.chunk_text(""))'), [])
    assert.deepEqual(runPy('emit(m.chunk_text("   \\n\\n  "))'), [])
  })

  test('短文本 → 单块，且原样保留', () => {
    const out = runPy('emit(m.chunk_text("短文本"))')
    assert.deepEqual(out, ['短文本'])
  })

  test('**每一块都不超过 MAX_CHUNK**（含无标点长串 —— 硬上限必须真的兜住）', () => {
    // 这条是本次审查抓到的真缺陷：`'x' * 3000` 这种无标点长串，
    // 句子切分切不开，于是一个 3000 字符的块直接进了索引，突破 MAX_CHUNK=2000。
    const label = { 无标点长串: '"x" * 3000', 带句号长文: '("y" * 1500 + "。") * 4', 多段落: '("z" * 900 + "\\n\\n") * 5' }
    for (const [name, expr] of Object.entries(label)) {
      const out = runPy(`emit({"max": m.MAX_CHUNK, "lens": [len(c) for c in m.chunk_text(${expr})]})`)
      const tooLong = out.lens.filter((n) => n > out.max)
      assert.deepEqual(
        tooLong,
        [],
        `${name}：切出了 ${tooLong.join('/')} 字符的块，超过 MAX_CHUNK=${out.max} —— 硬上限没兜住`,
      )
    }
  })

  test('长文切分后不丢内容（overlap 会重复，但不该有缺口）', () => {
    // 用带编号的句子，检查每个编号都至少出现在某一块里
    const out = runPy(`
text = "。".join("第%d句%070d" % (i, i) for i in range(60)) + "。"
chunks = m.chunk_text(text)
missing = [i for i in range(60) if not any(("第%d句" % i) in c for c in chunks)]
emit({"chunks": len(chunks), "missing": missing})
`)
    assert.equal(out.chunks > 1, true, '这段应当被切成多块')
    assert.deepEqual(out.missing, [], '有句子没进任何块 —— 内容丢了')
  })

  test('parse_frontmatter：有/无 frontmatter、列表、引号都能解', () => {
    const out = runPy(`
meta, body = m.parse_frontmatter('---\\ntitle: "标题"\\ntags:\\n  - a\\n  - "b"\\n---\\n正文')
plain, plainBody = m.parse_frontmatter('没有 frontmatter 的正文')
emit({"meta": meta, "body": body, "plain": plain, "plainBody": plainBody})
`)
    assert.equal(out.meta.title, '标题', '引号要剥掉')
    assert.deepEqual(out.meta.tags, ['a', 'b'], '列表项要剥引号')
    assert.equal(out.body, '正文')
    assert.deepEqual(out.plain, {}, '没有 frontmatter 时返回空对象')
    assert.equal(out.plainBody, '没有 frontmatter 的正文')
  })

  test('split_sections：标题层级要拼成 section_path', () => {
    const out = runPy(`
emit(m.split_sections("# 一\\n正文1\\n## 一.一\\n正文2\\n# 二\\n正文3"))
`)
    const paths = out.map((p) => p[0])
    assert.deepEqual(paths, ['一', '一 > 一.一', '二'], `section_path 不对：${JSON.stringify(paths)}`)
    assert.equal(out[1][1], '正文2')
  })
})

/**
 * 21b：迁移脚本的容量闸。
 *
 * 不测「真的超限就 return 2」——那需要跑完整 main()（要 ES、Ollama、文档目录），
 * 成本远大于它保护的东西；测的是**口径与失败降级**：折算公式、超限判定、
 * 查询失败返回 None（不能当成「已用 0」而放行）。
 * 三处实现（TS / 面板 JS / 本脚本）口径必须一致，任何一处漂移都会让闸说谎。
 */
describe('migrate-docs 容量闸（21b）', { skip }, () => {
  const fakeHttp = (chars, chunks = 7) => `
import json
def _fake(url, *, method="GET", body=None, headers=None, ctx=None, timeout=60):
    return 200, {"hits": {"total": {"value": ${chunks}}}, "aggregations": {"docs": {"value": 3}, "chars": {"value": ${chars}}}}
m.http_json = _fake
`

  test('按 chars ×3 折算已用字节（与 TS / 面板同口径）', () => {
    const out = runPy(fakeHttp(1000) + 'emit(m.read_capacity("http://x", "personal_doc_xqh", "Basic x", None, 10*1024*1024))')
    assert.equal(out.usedBytes, 3000)
    assert.equal(out.limitBytes, 10 * 1024 * 1024)
    assert.equal(out.overLimit, false)
    assert.equal(out.activeChunks, 7)
    assert.equal(out.activeDocs, 3)
  })

  test('超限被标记；limit=0 表示不限、不误报', () => {
    // 4 Mi 字符 ×3 = 12 MiB > 10 MiB
    const over = runPy(fakeHttp(4 * 1024 * 1024) + 'emit(m.read_capacity("http://x", "i", "Basic x", None, 10*1024*1024))')
    assert.equal(over.overLimit, true)
    const unlimited = runPy(fakeHttp(4 * 1024 * 1024) + 'emit(m.read_capacity("http://x", "i", "Basic x", None, 0))')
    assert.equal(unlimited.overLimit, false, 'limit=0 是不限，永远不超限')
  })

  test('查询失败返回 None —— 不能当成「已用 0」放行', () => {
    const out = runPy(`
import urllib.error
def _boom(*a, **k):
    raise urllib.error.URLError("down")
m.http_json = _boom
emit(m.read_capacity("http://x", "i", "Basic x", None, 10*1024*1024))
`)
    assert.equal(out, null)
  })
})
