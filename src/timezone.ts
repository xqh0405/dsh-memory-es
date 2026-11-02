/**
 * 时区相关的时间计算（日记 / 人格提炼的「到点没」「算哪天」都要用）。
 *
 * 为什么不能直接用 `new Date().getHours()`：
 * `dsh-*` 容器实测跑在 **UTC**（`TZ` 未设置、`/etc/timezone` 不存在、node 的
 * `getTimezoneOffset()` 返回 0），而宿主与用户都在 Asia/Shanghai。直接取本地时分的结果是：
 *   · `at: 23:30` 实际在北京时间次日 **07:30** 才触发；
 *   · `dateKey()` 按 UTC 算日期，北京时间 00:00–08:00 的对话会被记到前一天。
 * 症状是「日记能出，但总晚 8 小时 / 日期错位」，比完全不跑更难发现。
 *
 * 所以这里把「某个时刻在某时区是几点几分」和「某时区的某天从哪一刻开始」显式算出来，
 * 时区来自配置（默认 Asia/Shanghai），与容器环境解耦。
 *
 * @module dsh-memory-es/timezone
 */

/** 默认时区：插件面向中文用户，日记/提炼的「几点」都按北京时间理解 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

export interface ZonedParts {
  /** 该时区的 `YYYY-MM-DD` */
  date: string
  hour: number
  minute: number
}

/** 取某时刻在指定时区的日期与时分（不依赖进程 TZ） */
export function zonedParts(at: Date, timeZone: string = DEFAULT_TIMEZONE): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // en-CA 在午夜可能给 "24"，取模归一
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  }
}

/** 该时刻下，指定时区相对 UTC 的偏移（毫秒；东八区为 +8h） */
function tzOffsetMs(at: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - at
}

/**
 * 某时区 `YYYY-MM-DD` 当天 0 点对应的 UTC 毫秒。
 *
 * 用「按 UTC 建一个猜测值 → 再用该时区此刻的偏移修正」的常规做法；
 * 中国无夏令时，两次偏移不会差一小时，猜测一次即可（有 DST 的时区需要迭代一次，这里不做）。
 */
export function zonedDayStart(date: string, timeZone: string = DEFAULT_TIMEZONE): number {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10))
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0)
  return guess - tzOffsetMs(guess, timeZone)
}

/** `YYYY-MM-DD` 加一天（纯日期运算，与时区无关） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10))
  const at = new Date(Date.UTC(y, m - 1, d))
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** "HH:MM" → 当天第几分钟（解析不出来时给默认值） */
export function minutesOfDay(hhmm: string, fallback: { hour: number; minute: number }): number {
  const [h, m] = hhmm.split(':').map((part) => Number.parseInt(part, 10))
  const hour = Number.isFinite(h) ? h : fallback.hour
  const minute = Number.isFinite(m) ? m : fallback.minute
  return hour * 60 + minute
}
