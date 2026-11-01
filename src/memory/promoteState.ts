/**
 * `promote_state` 的取值词典（阶段 13）。
 *
 * 为什么要集中成一份：这个字段散在 6 处写入（save / traits / mood / persona / journal /
 * consolidate），加一个新状态时最容易漏的就是「扫描条件」——漏了它，条目会被反复处理；
 * 或者漏在终态列表里，面板与统计就会把它当成「还没结论」。
 *
 * 分成两组看：
 *  · **可再扫**（`none` / `candidate`）——整理任务会反复看它们；
 *  · **终态**（`promoted` / `blocked` / `personal_only` / `dismissed`）——已经给过结论，
 *    不该再被扫；其中 `dismissed` 是**人工判定「不合并」**（阶段 13 新增），
 *    和 `blocked`（敏感拦下）语义不同，别混用。
 *
 * @module dsh-memory-es/memory/promoteState
 */

export const PROMOTE_STATES = [
  'none',
  'candidate',
  'promoted',
  'blocked',
  'personal_only',
  /** 人工判过：内容与已有团队条目相似，但**决定不合并** */
  'dismissed',
] as const

export type PromoteState = (typeof PROMOTE_STATES)[number]

/** 整理任务会反复扫的状态：其余都是已给出结论的终态 */
export const RESCANNABLE_PROMOTE_STATES = ['none', 'candidate'] as const

/** 终态：有结论了，不该再被扫（也不该出现在「待整理」计数里） */
export const SETTLED_PROMOTE_STATES = ['promoted', 'blocked', 'personal_only', 'dismissed'] as const

/** 人话解释，供面板/报告用（避免各处自己写一套） */
export const PROMOTE_STATE_LABELS: Record<PromoteState, string> = {
  none: '未整理',
  candidate: '待合并',
  promoted: '已进团队库',
  blocked: '含敏感内容被拦',
  personal_only: '只留个人库',
  dismissed: '人工判定不合并',
}
