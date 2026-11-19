/**
 * 自更新的运行时把手（2026-11-19）。
 *
 * 为什么单独一个模块：更新调度在 `index.ts` 的 `apply` 闭包里，而面板的 HTTP 路由
 * 在 `panel/index.js` 里（同一个包的两个入口）。两边要共享同一份 UpdateDeps 与
 * 「是否正在跑」的状态，又不能互相 import 对方（会绕成环、面板那半边还是手写 JS）。
 *
 * 于是把状态放这个模块级单例：index.ts 注册一次，panel/index.js 通过
 * `../lib/update-runtime.js` 读同一份——Node 的 ESM 缓存按 URL 命中，两边看到的是
 * 同一个对象。
 */

import type { UpdateDeps } from './update.ts'

let deps: UpdateDeps | null = null
let running = false

/** 由 index.ts 在装配自更新调度时调用；插件卸载时传 null 摘掉 */
export function setUpdateDeps(next: UpdateDeps | null): void {
  deps = next
}

export function getUpdateDeps(): UpdateDeps | null {
  return deps
}

/** 一轮更新是否正在进行（面板据此把按钮置灰，避免连点） */
export function isUpdateRunning(): boolean {
  return running
}

export function markUpdateRunning(value: boolean): void {
  running = value
}
