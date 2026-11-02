/**
 * 会话日志根目录的唯一推导点。
 *
 * 为什么不能只写 `~/.dsh/sessions`：
 * 容器里 `HOME` 和 `DSH_HOME` 是两个值——实测 `dsh-*` 容器是
 * `HOME=/home/node`、`DSH_HOME=/data/dsh`，而会话日志在 `/data/dsh/sessions`。
 * 只按 `homedir()` 拼出来的 `/home/node/.dsh/sessions` 根本不存在，
 * 于是 `readdirSync` 抛错被吞 → 当天 0 轮对话 → 日记与人格提炼**永远跳过**
 * （症状是「个人记忆有、日记和人格候选一直是空」，2026-11-02 在 某个成员容器 查到）。
 *
 * 所以优先认 `DSH_HOME`（容器里 entrypoint 会显式设它，本机则不设，
 * 本机 `~/.dsh` 正好就是 DSH_HOME，两条路等价）。
 *
 * @module dsh-memory-es/sessions
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 会话日志根目录：`$DSH_HOME/sessions`，没有 DSH_HOME 时退回 `~/.dsh/sessions` */
export function dshSessionsRoot(): string {
  const home = process.env.DSH_HOME?.trim()
  if (home !== undefined && home !== '') return join(home, 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}
