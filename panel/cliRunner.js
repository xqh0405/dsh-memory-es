/**
 * 跑 consolidate CLI（P3）：整理任务与 Markdown 镜像都复用它，不重复实现第二套逻辑。
 *
 * 为什么要在容器里跑 CLI：`consolidate/` 的依赖链是纯 node 内置 + 相对导入（已核查），
 * Node ≥22.18 能直接跑 .ts，所以把源码随面板包一起放进容器即可——不需要在 .125 上克隆仓库。
 *
 * 三个必须：
 *  1. CLI 的凭证只从 `$ES_DIR/.env` 读 → 每次调用临时生成 600 的 .env，调用完删掉；
 *  2. CA 也放在这次临时目录里（cli 只认 `$ES_DIR/certs/ca.crt`）；
 *  3. 有超时：整理要跑 embedding，卡住不能把面板请求挂死（默认 120s，可覆盖）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * CLI 入口候选目录，按顺序取第一个存在的。
 *
 * 关键约束：**不能在 node_modules 下面跑**。Node 的类型剥离对 node_modules 内的 .ts 直接拒绝
 * （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），而面板被 pnpm 装进 profile 的 node_modules。
 * 所以优先用 local-plugins 那份（同名目录、不在 node_modules 路径内），HERE/cli 只作兜底。
 */
const CLI_DIR_CANDIDATES = [
  process.env.MEMORY_ES_CLI_DIR,
  '/data/dsh/local-plugins/dsh-memory-es-panel/cli',        // .125 容器内
  join(homedir(), '.dsh/local-plugins/dsh-memory-es-panel/cli'), // .114 本机
  join(HERE, 'cli'),                                        // 兜底（node_modules 下跑不了，仅当装了本地目录）
].filter((value) => typeof value === 'string' && value !== '')

function resolveCliDir() {
  for (const dir of CLI_DIR_CANDIDATES) {
    if (existsSync(join(dir, 'consolidate', 'cli.ts'))) return dir
  }
  return ''
}

/** 部署时是否把 CLI 源码带进来了 */
export function cliAvailable() {
  return resolveCliDir() !== ''
}

/**
 * 执行一次 CLI。
 * @param config 面板解析出来的插件配置（含三种身份密码）
 * @param args   传给 CLI 的参数（不含 node 路径）
 */
export async function runCli(config, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const cliDir = resolveCliDir()
  if (cliDir === '') throw new Error('找不到 CLI 源码目录（local-plugins 与包内 cli 都不存在）')
  const workDir = cliDir
  const envDir = join('/tmp', `memory-es-cli-${process.pid}-${Date.now()}`)
  const stateDir = options.stateDir ?? '/data/dsh/memory-es-state'

  try {
    mkdirSync(join(envDir, 'certs'), { recursive: true, mode: 0o700 })
    if (config.es.caCertPath) copyFileSync(config.es.caCertPath, join(envDir, 'certs', 'ca.crt'))
    const single = config.identity.username && config.identity.password
    const envLines = [
      `MEM_USER_ID=${config.identity.userId}`,
      // 单账号模式：CLI 会优先用这两个，忽略下面三组遗留密码
      ...(single ? [`MEM_USERNAME=${config.identity.username}`, `MEM_PASSWORD=${config.identity.password}`] : []),
      `MEM_READER_PASSWORD=${config.identity.readPassword}`,
      `MEM_WRITER_PASSWORD=${config.identity.writerPassword}`,
      `MEM_CONSOLIDATOR_PASSWORD=${config.identity.consolidatorPassword}`,
      `MEM_PERSONAL_PREFIX=${config.index.personalPrefix}`,
      `MEM_TEAM_INDEX=${config.index.team}`,
      'MEM_AUDIT_INDEX=memory_audit',
      `MEM_EMBEDDING_URL=${config.embedding.url}`,
      `MEM_EMBEDDING_MODEL=${config.embedding.model}`,
      `MEM_EMBEDDING_DIMS=${config.embedding.dims}`,
    ]
    writeFileSync(join(envDir, '.env'), `${envLines.join('\n')}\n`, { mode: 0o600 })
    mkdirSync(stateDir, { recursive: true })

    const finalArgs = [
      join(cliDir, 'consolidate', 'cli.ts'),
      '--es-url', config.es.url,
      '--state', join(stateDir, 'consolidate.json'),
      ...args,
    ]

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, finalArgs, {
        cwd: workDir,
        env: {
          ...process.env,
          ES_DIR: envDir,
          // CLI 会按需读这些；给上避免它去猜仓库路径
          NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout] 超过 ${timeoutMs}ms 被终止` })
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
        if (stdout.length > 64_000) stdout = stdout.slice(-64_000)
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
        if (stderr.length > 32_000) stderr = stderr.slice(-32_000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: `${stderr}\n[spawn] ${String(error.message ?? error)}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
    return result
  } finally {
    try {
      rmSync(envDir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

/** 从 CLI 输出里挑出要给人看的摘要行（整理小结 / 导出结果） */
export function summarize(stdout) {
  const lines = stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '')
  const keep = lines.filter((line) =>
    /^(小结|候选|向量|模式|已导出|DRY-RUN|范围|共 |清理旧文件)/.test(line) ||
    line.startsWith('- ') ||
    line.includes('promoted='),
  )
  return (keep.length > 0 ? keep : lines).slice(-12)
}
