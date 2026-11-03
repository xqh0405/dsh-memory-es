/**
 * 阶段 15.9 验收（取数边界）：`fetchSize = 单盘上限 × 2 = 10000` 是否真的贴在
 * ES `index.max_result_window` 的线上，以及越界时 ES 报什么。
 *
 * 为什么必须实测而不是看代码：`from + size ≤ 10000` 是**服务端**约束，
 * 任何本地常量都推不出它；而且默认值可以被索引级 setting 改掉。
 *
 * 用法：node scripts/bench/es-window-check.mjs
 *   · 读 ~/.dsh/profiles/web/cordis.patch.yml 的 es 节点取连接（只读）
 *   · ⚠️ 那份 yml 含 `!!js` 自定义 tag，整份 YAML.parse 会失败；
 *     更不能用报错原文做日志——它会把 identity.password 一起打出来。
 *     这里改成按行扫描定位 es 块，且报错只报字段名，不回显值。
 * 输出：每个 size 一行 JSON（status / reason / hits），10000 为 200、10001 为 400 即通过。
 */
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

const PROFILE = path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'cordis.patch.yml')

/** 从 cordis.patch.yml 里抠出某个顶层块（同缩进的兄弟块不算进来）。
 *  不解析整份 YAML：里面有 !!js 表达式，解析失败时的报错会带出凭据原文。 */
function readBlock(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line))
  if (start < 0) return null
  const indent = lines[start].match(/^\s*/)[0].length
  const block = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lead = line.match(/^\s*/)[0].length
    if (lead <= indent) break
    block.push(line)
  }
  return block
}

function pick(block, key) {
  if (block === null) return ''
  const hit = block.find((line) => new RegExp(`^\\s*${key}:`).test(line))
  if (hit === undefined) return ''
  return hit.replace(new RegExp(`^\\s*${key}:\\s*`), '').replace(/^['"]|['"]$/g, '').trim()
}

function readEsConfig(text) {
  const lines = text.split('\n')
  const es = readBlock(lines, 'es')
  if (es === null) throw new Error('cordis.patch.yml 里找不到 es 块')
  // identity 是 es 的兄弟块，不是子节点（2026-11-03 第一次写错，按子节点找不到用户名）
  const identity = readBlock(lines, 'identity')
  const config = {
    url: pick(es, 'url'),
    caCertPath: pick(es, 'caCertPath'),
    username: pick(identity, 'username'),
    password: pick(identity, 'password'),
    userId: pick(identity, 'userId'),
  }
  const missing = Object.entries(config).filter(([, value]) => value === '').map(([key]) => key)
  if (missing.length > 0) throw new Error(`配置缺字段：${missing.join('、')}（不打印值）`)
  return config
}

function probe(config, index, size) {
  return new Promise((resolve) => {
    const url = new URL(config.url)
    const body = JSON.stringify({
      size,
      track_total_hits: true,
      query: { term: { status: 'active' } },
      _source: ['memory_id'],
    })
    const request = https.request(
      {
        host: url.hostname,
        port: url.port,
        path: `/${encodeURIComponent(index)}/_search`,
        method: 'POST',
        ca: fs.readFileSync(config.caCertPath),
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      },
      (response) => {
        let data = ''
        response.on('data', (chunk) => (data += chunk))
        response.on('end', () => {
          let parsed = {}
          try {
            parsed = JSON.parse(data)
          } catch {
            parsed = {}
          }
          resolve({
            size,
            status: response.statusCode,
            // root_cause 才是「为什么」，顶层 reason 只会说 all shards failed
            reason: parsed.error?.root_cause?.[0]?.reason ?? parsed.error?.reason ?? null,
            hits: parsed.hits?.hits?.length ?? null,
          })
        })
      },
    )
    request.on('error', (error) => resolve({ size, status: -1, reason: error.message, hits: null }))
    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.end(body)
  })
}

const config = readEsConfig(fs.readFileSync(PROFILE, 'utf8'))
const index = `personal_memory_${config.userId}`
console.log(`# 索引 ${index}（只读探测，不回显连接信息）`)
for (const size of [10000, 10001]) {
  const result = await probe(config, index, size)
  console.log(JSON.stringify(result))
}
