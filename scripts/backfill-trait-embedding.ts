#!/usr/bin/env node
/**
 * 给已存在的 identity 自述补 embedding 向量。
 *
 * 为什么需要：`memory_traits` 早期写候选时**没有写向量**，而语义判重靠 kNN——
 * kNN 只能查到有 `embedding` 的文档。不补齐的话，「同义候选不重复写入」对历史数据
 * 完全失效（2026-10-31 实测：14 条 pending 全部 has_vec=0）。
 *
 * 用法：
 *   node scripts/backfill-trait-embedding.ts            # 只报告缺多少
 *   node scripts/backfill-trait-embedding.ts --apply    # 真写回
 *
 * 幂等：只处理 `embedding` 字段不存在的文档，已有向量的一条都不碰。
 * 凭据与连接参数从 DSH profile 里读（与插件同源），不在命令行暴露。
 *
 * @module dsh-memory-es/scripts/backfill-trait-embedding
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEmbedder } from '../src/embedding.ts'
import { createEsClient } from '../src/es/http.ts'
import { personalIndexFor } from '../src/memory/common.ts'

const PROFILE = process.env.DSH_PROFILE_YML ?? join(homedir(), '.dsh/profiles/web/cordis.patch.yml')
const APPLY = process.argv.includes('--apply')
/** 单批取多少条：候选通常只有几十条，100 足够且不会一次打爆内存 */
const BATCH = 100

/**
 * 从 profile 文本里抠 dsh-memory-es 的配置。
 * 用正则而不是 YAML 解析：该文件含 `!!js` 自定义标签，标准解析器会直接失败。
 */
function readMemoryConfig(): {
  esUrl: string
  caCertPath: string
  username: string
  password: string
  embedUrl: string
  embedModel: string
  dims: number
  userId: string
  personalPrefix: string
} {
  const text = readFileSync(PROFILE, 'utf8')
  const start = text.indexOf('- id: dsh-memory-es')
  if (start === -1) throw new Error(`profile 里没有 dsh-memory-es 条目：${PROFILE}`)
  // 截到下一个顶层条目或文件尾，避免抓到别的插件的同名字段
  const rest = text.slice(start + 1)
  const nextEntry = rest.search(/\n- id: /)
  const seg = nextEntry === -1 ? rest : rest.slice(0, nextEntry)

  const pick = (source: string, re: RegExp, label: string): string => {
    const m = source.match(re)
    if (m === null || m[1] === undefined || m[1].trim() === '') {
      throw new Error(`profile 的 dsh-memory-es 段缺少 ${label}`)
    }
    return m[1].trim()
  }

  // embedding 段必须单独切出来：distill 段也有 `url:` 与 `model:`，
  // 整段一起用正则会抓到 deepseek-flash（2026-10-31 实测踩到）
  const embedAt = seg.indexOf('embedding:')
  if (embedAt === -1) throw new Error('profile 的 dsh-memory-es 段缺少 embedding')
  const embedSeg = seg.slice(embedAt)

  return {
    esUrl: pick(seg, /url:\s*(\S+)/, 'es.url'),
    caCertPath: pick(seg, /caCertPath:\s*(\S+)/, 'es.caCertPath'),
    username: pick(seg, /username:\s*(\S+)/, 'identity.username'),
    password: pick(seg, /password:\s*(\S+)/, 'identity.password'),
    embedUrl: pick(embedSeg, /url:\s*(\S+)/, 'embedding.url'),
    // model 可能是带引号的（distill 段是 'xxx'）也可能裸写（embedding 段是 bge-m3）
    embedModel: pick(embedSeg, /model:\s*'?([^'\s]+)'?/, 'embedding.model'),
    dims: Number(pick(embedSeg, /dims:\s*(\d+)/, 'embedding.dims')),
    userId: pick(seg, /userId:\s*(\S+)/, 'identity.userId'),
    personalPrefix: pick(seg, /personalPrefix:\s*(\S+)/, 'index.personalPrefix'),
  }
}

async function main(): Promise<void> {
  const cfg = readMemoryConfig()
  const index = personalIndexFor(cfg.personalPrefix, cfg.userId)
  const es = createEsClient({
    url: cfg.esUrl,
    caCertPath: cfg.caCertPath,
    username: cfg.username,
    password: cfg.password,
    requestTimeoutMs: 15_000,
  })
  const embedder = createEmbedder({ url: cfg.embedUrl, model: cfg.embedModel, dims: cfg.dims })

  // 只取「有内容但没有向量」的 identity 文档
  const found = await es.search(index, {
    size: BATCH,
    _source: ['memory_id', 'content', 'status'],
    query: {
      bool: {
        filter: [{ term: { memory_type: 'identity' } }],
        must_not: [{ exists: { field: 'embedding' } }],
      },
    },
  })

  console.log(`索引 ${index}：identity 条目中缺向量的有 ${found.hits.length} 条`)
  if (found.hits.length === 0) {
    console.log('没有需要补的，退出。')
    return
  }
  if (!APPLY) {
    for (const hit of found.hits.slice(0, 5)) {
      const content = String((hit.source['content'] as string | undefined) ?? '')
      console.log(`  - ${hit.id} [${String(hit.source['status'] ?? '?')}] ${content.slice(0, 40)}…`)
    }
    console.log('\n这是干跑。加 --apply 才会写回。')
    return
  }

  let ok = 0
  const failed: string[] = []
  for (const hit of found.hits) {
    const content = String((hit.source['content'] as string | undefined) ?? '')
    if (content.trim() === '') {
      failed.push(`${hit.id}(空内容)`)
      continue
    }
    try {
      const vector = await embedder.embed(content)
      // refresh=wait_for：补完立刻就能被 kNN 查到，否则下一次提炼还会漏判
      await es.update(index, hit.id, { embedding: vector }, { refresh: 'wait_for' })
      ok += 1
      console.log(`  ✓ ${hit.id}`)
    } catch (err) {
      failed.push(`${hit.id}(${String(err).slice(0, 80)})`)
    }
  }

  console.log(`\n补齐 ${ok} 条，失败 ${failed.length} 条`)
  if (failed.length > 0) {
    console.log('失败明细：')
    for (const f of failed) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

await main()
