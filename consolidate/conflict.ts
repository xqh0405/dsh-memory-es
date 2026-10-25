/**
 * 冲突判定（文档 §9.4 最后一条：「同一 topic_key 出现相反结论，一律 pending」）。
 *
 * **这是规则版，不是语义理解**，边界必须说清：
 *  · 能判：一对反义极性词，只有一边出现（「必须 A」vs「禁止 A」）。这是踩过坑之后最容易
 *    复制错的一类，也正是团队库最怕的那类（照着相反结论干活）。
 *  · 判不了：「同一件事换说法」的冲突、数值阈值相反但都不带极性词、多重条件叠加。
 *    判不了的不能假装判了——所以函数只对**明确命中词对**的情况返回 true，
 *    其余一律 false，交给人工（pending 队列本身就是为了这个）。
 *
 * @module dsh-memory-es/consolidate/conflict
 */

export interface ContradictionResult {
  contradiction: boolean
  /** 命中的词对（正/反），便于 dry-run 报告说清「因为哪对词」 */
  pair: [string, string] | null
  reason: string
}

/**
 * 极性词对：一边是「要求」，一边是「禁止」。顺序有意义——
 * 先匹配否定词，再匹配肯定词，否则「不支持」会被「支持」命中而判成同极性。
 */
const POLARITY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['必须', '禁止'],
  ['要', '不要'],
  ['允许', '不允许'],
  ['可以', '不能'],
  ['开启', '关闭'],
  ['支持', '不支持'],
  ['启用', '禁用'],
  ['enable', 'disable'],
  ['allow', 'forbid'],
  ['required', 'forbidden'],
]

type Polarity = 'pos' | 'neg' | null

/** 判断一段文本对某对词的极性（否定优先匹配，避免「不支持」被「支持」吃掉） */
export function polarityOf(text: string, pair: readonly [string, string]): Polarity {
  const lower = text.toLowerCase()
  const [pos, neg] = [pair[0].toLowerCase(), pair[1].toLowerCase()]
  if (lower.includes(neg)) return 'neg'
  if (lower.includes(pos)) return 'pos'
  return null
}

/**
 * 两段内容是否构成「相反结论」。
 * 只有**同一对词上极性相反**才算冲突；一边没表态（null）不算。
 */
export function detectContradiction(a: string, b: string): ContradictionResult {
  for (const pair of POLARITY_PAIRS) {
    const left = polarityOf(a, pair)
    const right = polarityOf(b, pair)
    if (left !== null && right !== null && left !== right) {
      return {
        contradiction: true,
        pair: [pair[0], pair[1]],
        reason: `同一主题上出现相反结论（「${pair[0]}」vs「${pair[1]}」），按 §9.4 进 pending`,
      }
    }
  }
  return { contradiction: false, pair: null, reason: '未发现明确的反义极性词对（规则版判不了语义冲突，需要人工看）' }
}
