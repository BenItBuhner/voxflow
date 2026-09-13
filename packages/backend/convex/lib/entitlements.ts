import { v, type Infer } from 'convex/values'
import {
  DAY_MS,
  FAIR_USE_REQUESTS_PER_MINUTE,
  PLANS,
  RATE_WINDOW_MS,
  dayStart,
  formatResetDate,
  nextMonthStart,
  weekDays,
  type Plan,
  type PlanLimits,
  type PlanState
} from './plans'

/**
 * Pure metering: given what an account used, decide what it may still do and how to tell it when
 * it may not. Nothing here reads the database or the clock; `authorize` (convex/inference.ts) and
 * `inference.status` feed it and the tests drive it directly.
 */

export const limitNameValidator = v.union(
  v.literal('wordsPerWeek'),
  v.literal('sttSecondsPerWeek'),
  v.literal('dictationsPerDay'),
  v.literal('maxClipSeconds'),
  v.literal('sttSecondsPerMonth'),
  v.literal('fairUseSttSecondsPerMonth'),
  v.literal('llmTokensPerMonth'),
  v.literal('requestsPerMinute')
)
export type LimitName = Infer<typeof limitNameValidator>

/** One limit that applies to the account, with where it stands. */
export const meterValidator = v.object({
  limit: limitNameValidator,
  used: v.number(),
  allowed: v.number(),
  exceeded: v.boolean(),
  /** When `used` next drops; if exceeded, when it drops under `allowed`. Epoch ms. */
  resetsAt: v.number()
})
export type Meter = Infer<typeof meterValidator>

/** A day's bucket of managed usage (`inferenceDays`). */
export interface DayUsage {
  day: string
  words: number
  sttSeconds: number
  /** Transcriptions. */
  dictations: number
  /** Formatting requests (chat completions and /v1/format). */
  formats: number
}

/** A month's bucket (`inferenceUsage`). */
export interface MonthUsage {
  sttSeconds: number
  sttRequests: number
  llmTokens: number
  llmRequests: number
}

export const ZERO_MONTH: MonthUsage = {
  sttSeconds: 0,
  sttRequests: 0,
  llmTokens: 0,
  llmRequests: 0
}

export interface UsageSnapshot {
  /** The UTC day the snapshot is anchored on. */
  day: string
  /** Daily buckets for the rolling week ending on `day`; missing days count as zero. */
  days: DayUsage[]
  month: MonthUsage
}

const sum = (days: DayUsage[], pick: (d: DayUsage) => number): number =>
  days.reduce((acc, d) => acc + pick(d), 0)

/** Buckets of the rolling week ending on `day`, oldest first, zero-filled. */
export function weekBuckets(day: string, days: DayUsage[]): DayUsage[] {
  const byDay = new Map(days.map((d) => [d.day, d]))
  return weekDays(day).map(
    (key) => byDay.get(key) ?? { day: key, words: 0, sttSeconds: 0, dictations: 0, formats: 0 }
  )
}

/**
 * When a rolling-week meter next moves. The window advances at UTC midnight, dropping its oldest
 * day: if the meter is exceeded, the first midnight after which the total is under the cap; if
 * not, the first midnight at which the total shrinks (the oldest counted day leaving), or simply
 * the next midnight when nothing is counted yet.
 */
export function rollingResetAt(
  day: string,
  buckets: DayUsage[],
  pick: (d: DayUsage) => number,
  allowed: number
): number {
  const tomorrow = dayStart(day) + DAY_MS
  const leaves = (index: number): number => dayStart(buckets[index].day) + buckets.length * DAY_MS
  let total = sum(buckets, pick)
  if (total < allowed) {
    const oldest = buckets.findIndex((b) => pick(b) > 0)
    return oldest < 0 ? tomorrow : leaves(oldest)
  }
  for (let i = 0; i < buckets.length; i++) {
    total -= pick(buckets[i])
    if (total < allowed) return leaves(i)
  }
  return tomorrow
}

/** The UTC midnight at which the oldest day with any usage leaves the window; null if none. */
export function weekRollsAt(buckets: DayUsage[]): number | null {
  const oldest = buckets.findIndex(
    (b) => b.words > 0 || b.sttSeconds > 0 || b.dictations > 0 || b.formats > 0
  )
  return oldest < 0 ? null : dayStart(buckets[oldest].day) + buckets.length * DAY_MS
}

function meter(limit: LimitName, used: number, allowed: number, resetsAt: number): Meter {
  return { limit, used, allowed, exceeded: used >= allowed, resetsAt }
}

/** Every meter that applies under `limits`, in the order the account page shows them. */
export function metersFor(limits: PlanLimits, snapshot: UsageSnapshot): Meter[] {
  const buckets = weekBuckets(snapshot.day, snapshot.days)
  const today = buckets[buckets.length - 1]
  const monthReset = nextMonthStart(snapshot.day)
  const out: Meter[] = []
  if (limits.wordsPerWeek !== null) {
    out.push(
      meter(
        'wordsPerWeek',
        sum(buckets, (d) => d.words),
        limits.wordsPerWeek,
        rollingResetAt(snapshot.day, buckets, (d) => d.words, limits.wordsPerWeek)
      )
    )
  }
  if (limits.sttSecondsPerWeek !== null) {
    out.push(
      meter(
        'sttSecondsPerWeek',
        sum(buckets, (d) => d.sttSeconds),
        limits.sttSecondsPerWeek,
        rollingResetAt(snapshot.day, buckets, (d) => d.sttSeconds, limits.sttSecondsPerWeek)
      )
    )
  }
  if (limits.dictationsPerDay !== null) {
    out.push(
      meter(
        'dictationsPerDay',
        Math.max(today.dictations, today.formats),
        limits.dictationsPerDay,
        dayStart(snapshot.day) + DAY_MS
      )
    )
  }
  if (limits.fairUseSttSecondsPerMonth !== null) {
    out.push(
      meter(
        'fairUseSttSecondsPerMonth',
        snapshot.month.sttSeconds,
        limits.fairUseSttSecondsPerMonth,
        monthReset
      )
    )
  }
  out.push(
    meter('sttSecondsPerMonth', snapshot.month.sttSeconds, limits.sttSecondsPerMonth, monthReset)
  )
  out.push(
    meter('llmTokensPerMonth', snapshot.month.llmTokens, limits.llmTokensPerMonth, monthReset)
  )
  return out
}

/** Pro past its soft fair-use cap: the formatting model pauses and the request rate drops. */
export function formattingPaused(limits: PlanLimits, month: MonthUsage): boolean {
  return (
    limits.fairUseSttSecondsPerMonth !== null &&
    month.sttSeconds >= limits.fairUseSttSecondsPerMonth
  )
}

export function requestRateFor(limits: PlanLimits, month: MonthUsage): number {
  return formattingPaused(limits, month)
    ? Math.min(limits.requestsPerMinute, FAIR_USE_REQUESTS_PER_MINUTE)
    : limits.requestsPerMinute
}

export const refusalCodeValidator = v.union(
  v.literal('quota_exceeded'),
  v.literal('rate_limited'),
  v.literal('clip_too_long')
)

/** Why a request is refused, in the shape the gateway turns into a response. */
export const refusalValidator = v.object({
  status: v.number(),
  code: refusalCodeValidator,
  message: v.string(),
  limit: limitNameValidator,
  used: v.number(),
  allowed: v.number(),
  resetsAt: v.union(v.number(), v.null()),
  retryAfterSec: v.optional(v.number())
})
export type Refusal = Infer<typeof refusalValidator>

const minutes = (seconds: number): string => {
  const m = Math.max(1, Math.round(seconds / 60))
  return `${m} minute${m === 1 ? '' : 's'}`
}
const hours = (seconds: number): string => `${Math.round(seconds / 3600)} hours`
const secondsUntil = (ts: number, now: number): number => Math.max(1, Math.ceil((ts - now) / 1000))

function refuse(m: Meter, message: string, now: number): Refusal {
  return {
    status: 429,
    code: 'quota_exceeded',
    message,
    limit: m.limit,
    used: m.used,
    allowed: m.allowed,
    resetsAt: m.resetsAt,
    retryAfterSec: secondsUntil(m.resetsAt, now)
  }
}

export interface RequestCheck {
  plan: Plan
  state: PlanState
  limits: PlanLimits
  snapshot: UsageSnapshot
  now: number
}

/**
 * May this account transcribe a clip of `clipSeconds`? The clip length is known up front, so the
 * audio meters are checked with it included; words are only known afterwards, so a transcription
 * is allowed while the account is under the word cap (a clip can finish the week slightly over).
 */
export function checkTranscription(check: RequestCheck, clipSeconds: number): Refusal | null {
  const { plan, limits, snapshot, now } = check
  if (clipSeconds > limits.maxClipSeconds) {
    return {
      status: 413,
      code: 'clip_too_long',
      message:
        plan === 'free'
          ? `Clips longer than ${minutes(limits.maxClipSeconds)} cannot be sent on the free plan; Pro takes clips up to ${minutes(PLANS.pro.maxClipSeconds)}.`
          : `Clips longer than ${minutes(limits.maxClipSeconds)} cannot be sent to Murmur's speech model.`,
      limit: 'maxClipSeconds',
      used: clipSeconds,
      allowed: limits.maxClipSeconds,
      resetsAt: null
    }
  }
  const all = metersFor(limits, snapshot)
  const by = (name: LimitName): Meter | undefined => all.find((m) => m.limit === name)

  const month = by('sttSecondsPerMonth')!
  if (month.exceeded || month.used + clipSeconds > month.allowed) {
    return refuse(
      month,
      plan === 'free'
        ? `This month's ${minutes(month.allowed)} of Murmur transcription on the free plan are used up; more on ${formatResetDate(month.resetsAt)}, or unlimited dictation with Pro.`
        : `This month's ${hours(month.allowed)} of Murmur transcription, the Pro plan's fair-use limit, are used up; more on ${formatResetDate(month.resetsAt)}.`,
      now
    )
  }
  const words = by('wordsPerWeek')
  if (words?.exceeded) {
    return refuse(
      words,
      `You've dictated the ${words.allowed} words a week the free plan includes; more open up on ${formatResetDate(words.resetsAt)}, or go unlimited with Pro.`,
      now
    )
  }
  const week = by('sttSecondsPerWeek')
  if (week && (week.exceeded || week.used + clipSeconds > week.allowed)) {
    return refuse(
      week,
      `The free plan transcribes ${minutes(week.allowed)} of audio a week; that is used up until ${formatResetDate(week.resetsAt)}. Pro has no weekly limit.`,
      now
    )
  }
  const day = by('dictationsPerDay')
  if (day) {
    const buckets = weekBuckets(snapshot.day, snapshot.days)
    const dictations = buckets[buckets.length - 1].dictations
    if (dictations >= day.allowed) {
      return refuse(
        { ...day, used: dictations },
        `The free plan's ${day.allowed} dictations a day are used up; more after midnight UTC, or unlimited with Pro.`,
        now
      )
    }
  }
  return null
}

export type FormattingCheck = { ok: true; paused: Meter | null } | { ok: false; refusal: Refusal }

/**
 * May this account ask the formatting model? `degradable` callers (/v1/format) get `paused` past
 * the soft fair-use cap and answer with rule-based text; others (/v1/chat/completions) are refused.
 */
export function checkFormatting(check: RequestCheck, degradable: boolean): FormattingCheck {
  const { plan, limits, snapshot, now } = check
  const all = metersFor(limits, snapshot)
  const by = (name: LimitName): Meter | undefined => all.find((m) => m.limit === name)

  const tokens = by('llmTokensPerMonth')!
  if (tokens.exceeded) {
    return {
      ok: false,
      refusal: refuse(
        tokens,
        `This month's Murmur formatting allowance on the ${plan} plan is used up; more on ${formatResetDate(tokens.resetsAt)}.`,
        now
      )
    }
  }
  const day = by('dictationsPerDay')
  if (day) {
    const buckets = weekBuckets(snapshot.day, snapshot.days)
    const formats = buckets[buckets.length - 1].formats
    if (formats >= day.allowed) {
      return {
        ok: false,
        refusal: refuse(
          { ...day, used: formats },
          `The free plan's ${day.allowed} dictations a day are used up; more after midnight UTC, or unlimited with Pro.`,
          now
        )
      }
    }
  }
  const soft = by('fairUseSttSecondsPerMonth')
  if (soft?.exceeded) {
    if (degradable) return { ok: true, paused: soft }
    return {
      ok: false,
      refusal: refuse(
        soft,
        `Murmur's formatting model is paused until ${formatResetDate(soft.resetsAt)}: this month's ${hours(soft.allowed)} of fair use are used. Dictation continues with rule-based cleanup.`,
        now
      )
    }
  }
  return { ok: true, paused: null }
}

/** The per-minute request window; `count` is what the window already holds. */
export function checkRate(
  perMinute: number,
  windowStart: number,
  count: number,
  now: number
): Refusal | null {
  if (count < perMinute) return null
  const resetsAt = windowStart + RATE_WINDOW_MS
  const retryAfterSec = secondsUntil(resetsAt, now)
  return {
    status: 429,
    code: 'rate_limited',
    message: `Too many requests; try again in ${retryAfterSec}s`,
    limit: 'requestsPerMinute',
    used: count,
    allowed: perMinute,
    resetsAt,
    retryAfterSec
  }
}
