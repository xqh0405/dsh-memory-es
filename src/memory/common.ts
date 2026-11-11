/**
 * 写侧工具（save / update_status / promote）共用的底座：
 * 索引名派生、按 id 取「自己的」文档、归属断言。
 *
 * 这里刻意只依赖 `EsClient` 的两个方法（get / update），方便测试注入假客户端；
 * **读一律用 reader 凭证、写一律用 writer 凭证**——即便 mem_writer 也有 read 权限，
 * 也不拿写凭证去读，免得一处越权配置被无限放大。
 *
 * @module dsh-memory-es/memory/common
 */

import type { EsClient } from '../es/http.ts'
import { EsError } from '../es/http.ts'

/**
 * 写入开关的取值（配置见 `config.governance.write`）。
 *
 * 2026-11-10 从 `save.ts` 搬来这里：写闸下沉到 writer 层之后，**所有写入模块**
 * 都要认这个类型，放 save.ts 会让 common → save 形成反向依赖。
 * `save.ts` 仍 re-export，老 import 路径不断。
 */
export type WriteMode = 'on' | 'readonly' | 'off'

export interface MemoryStoreDeps {
  /** 取消信号：工具把 `exec.signal` 塞进来，一路传到 ES 请求（声明 timeoutMs 的前提） */
  signal?: AbortSignal
  /** F2 注入源 */
  userId: string
  /** 个人索引前缀；索引名一律由 前缀 + userId 派生 */
  personalPrefix: string
  /** 读身份（取文档） */
  reader: Pick<EsClient, 'get'> & Partial<Pick<EsClient, 'search'>>
  /** 写身份（唯一写入口） */
  writer: Pick<EsClient, 'update'>
  /** 结构化日志：不记录 content / 凭证 */
  log?: (event: Record<string, unknown>) => void
  /**
   * 写入开关（阶段 24 → 2026-11-10 下沉到 writer 层）。
   *
   * **缺省 = `'on'`**：不传就完全不改变历史行为，所以新增的写入点即使忘了传也不会误拦。
   * 只有 `src/index.ts` 装配时显式传 `config.governance.write` 才真正生效。
   */
  writeMode?: WriteMode
}

/**
 * 写闸：`governance.write !== 'on'` 时抛出，拦下**插件侧的任何写入**。
 *
 * 为什么放在 writer 层而不是只在 `saveMemory` 里：2026-11-10 审查发现配置文案
 * （config.governance.write）承诺「导入 / 蒸馏回写 / pinned 都走同一道闸」，实际只有
 * `memory_save` 检查——`governance.write=off`（停机维护）时新增记忆被拒，但后台仍在
 * 改写已有正文、仍能 pin 置顶。**用户 2026-11-10 拍板：全拦，代码向文档靠。**
 *
 * 覆盖：memory_save（含导入）、蒸馏正文回写、sweep 状态收口（done/skipped/failed）、
 * traits/persona/journal 直写、pin/unpin、promote、review、history 回滚、mood。
 *
 * **不覆盖**：面板的人工管理动作（删除 / 恢复 / 反馈 / 归档）——那是管理员显式操作、
 * 且面板自成一套（不 import 本模块），维护期仍要能清理数据。
 *
 * @param deps 带 writeMode 的依赖（缺省视为 'on'）
 * @param where 出现在错误信息里，方便定位是哪条链路被拦
 */
export function assertWriteAllowed(deps: { writeMode?: WriteMode }, where: string): void {
  const mode = deps.writeMode ?? 'on'
  if (mode === 'on') return
  throw new Error(
    `写入已关闭（governance.write=${mode}），${where} 被拒绝。`
    + '维护结束后把 governance.write 改回 on 再重试；期间的检索、面板查看不受影响。',
  )
}

export interface OwnedDoc {
  id: string
  source: Record<string, unknown>
}

/** 个人索引名：全仓库唯一的拼法 */
export function personalIndexFor(personalPrefix: string, userId: string): string {
  return `${personalPrefix}${userId}`
}

/**
 * 「不是事实」的三类记忆，默认不进普通检索、也不进提炼素材池。
 *
 *  · identity —— 关于**用户**的稳定自述（进系统提示与 memory_review）；
 *  · persona  —— 关于**我**的人格表层（阶段 9.3，进人格段）；
 *  · journal  —— 每日回顾（阶段 9.5，进面板「日记」栏）。
 *
 * 为什么集中定义在这里：`traits.ts` 与 `persona.ts` 互相依赖（后者要 hashContent），
 * 各自 export 常量再互相 import 会形成循环，ESM 下取值可能落到 TDZ。
 * 各模块自己的常量（save/persona/journal）语义相同，由 tests/non-fact-types.test.ts 钉住一致性。
 */
export const NON_FACT_MEMORY_TYPES = ['identity', 'persona', 'journal'] as const

/**
 * F3：写前/改前断言归属。做成独立纯函数，是为了不让它跟着注入点一起被改掉。
 * （save.ts 从本模块转出，保持老调用点不变。）
 */
export function assertDocOwner(source: Record<string, unknown>, userId: string): void {
  if (source.user_id !== userId) {
    throw new Error(
      `身份校验失败：文档 user_id（${String(source.user_id)}）与 identity.userId（${userId}）不一致，已拒绝操作`,
    )
  }
}

/**
 * 按 id 取文档，并把两类失败翻译成模型能懂的错：
 *  · 404 → 明确说「没有这条记忆」，并提示 memory_id 可能来自别的用户/别的库；
 *  · 归属不符 → 拒绝（F3）。
 */
export async function loadOwnedDoc(deps: MemoryStoreDeps, memoryId: string): Promise<OwnedDoc> {
  const id = (memoryId ?? '').trim()
  if (id === '') throw new Error('memory_id 不能为空')

  let doc: { id: string; source: Record<string, unknown> }
  try {
    doc = await deps.reader.get(personalIndexFor(deps.personalPrefix, deps.userId), id, {
      signal: deps.signal,
    })
  } catch (err) {
    if (err instanceof EsError && err.kind === 'not_found') {
      throw new Error(`找不到记忆 ${id}（个人库里没有这条；索引缺失时先跑 scripts/init-indices.sh）`, { cause: err })
    }
    throw err
  }
  assertDocOwner(doc.source, deps.userId)
  return { id: doc.id, source: doc.source }
}

/** 统一的时间戳写法：ES 的 date 字段收 ISO 字符串 */
export function nowIso(now: Date): string {
  return now.toISOString()
}
