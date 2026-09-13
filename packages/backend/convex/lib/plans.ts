import { v, type Infer } from 'convex/values'

/**
 * Account lifecycle and the allowances that come with it.
 *
 * Every account starts a 14-day Pro trial with no card (`trial`), then drops to a residual free
 * tier (`free`); a Stripe subscription (or the operator, through `internal.users.setPlan`) makes it
 * `pro`. The trial and Pro share one set of limits, so the tier whose limits apply is `plan`
 * (`free` | `pro`) while the account's state is `planState` (`trial` | `free` | `pro`); clients that
 * only know `plan` keep working and show "Pro" during the trial, which is what it is.
 *
 * Numbers come from the monetization analysis: the free tier is defined by words per rolling week
 * with hidden guardrails scaled to the 500-word residual tier; Pro is "unlimited" behind fair use
 * (soft 30 audio-hours a month, hard 60). Everything the analysis did not override keeps the value
 * the code had before (monthly backstops, request rates, the 10-minute clip).
 */
export const planStateValidator = v.union(v.literal('trial'), v.literal('free'), v.literal('pro'))
export type PlanState = Infer<typeof planStateValidator>

export const planValidator = v.union(v.literal('free'), v.literal('pro'))
export type Plan = Infer<typeof planValidator>

export const DEFAULT_PLAN: Plan = 'free'

/** The tier whose limits an account in `state` gets. */
export function tierOf(state: PlanState | undefined): Plan {
  return state === 'trial' || state === 'pro' ? 'pro' : 'free'
}

export const TRIAL_DAYS = 14
export const DAY_MS = 86_400_000
export const TRIAL_MS = TRIAL_DAYS * DAY_MS
/** The rolling window the word cap is measured over, in UTC calendar days including today. */
export const WEEK_DAYS = 7

export interface PlanLimits {
  /** Seconds of audio the managed speech model transcribes per UTC month (Pro: the hard fair-use cap). */
  sttSecondsPerMonth: number
  /** Prompt + completion tokens the managed formatting model may use per UTC month. */
  llmTokensPerMonth: number
  /** Managed inference requests (speech and formatting together) per rolling minute. */
  requestsPerMinute: number
  /** Longest clip the speech model accepts, in seconds. */
  maxClipSeconds: number
  /** Words transcribed per rolling 7 UTC days; null = unlimited. */
  wordsPerWeek: number | null
  /** Seconds of audio transcribed per rolling 7 UTC days; null = unlimited. */
  sttSecondsPerWeek: number | null
  /** Transcriptions (and, separately, formatting requests) per UTC day; null = unlimited. */
  dictationsPerDay: number | null
  /** Soft fair-use cap: past it the formatting model pauses and the request rate drops; null = none. */
  fairUseSttSecondsPerMonth: number | null
}

export const PLANS: Record<Plan, PlanLimits> = {
  free: {
    sttSecondsPerMonth: 120 * 60,
    llmTokensPerMonth: 500_000,
    requestsPerMinute: 20,
    // 2 minutes at 2,500 words a week in the analysis; a fifth of that cuts ordinary sentences,
    // so one minute: the weekly audio ceiling does the proportional work.
    maxClipSeconds: 60,
    wordsPerWeek: 500,
    // Twice the speech time 500 words imply at 150 words a minute, the ratio the analysis used.
    sttSecondsPerWeek: 7 * 60,
    // Six times the two median dictations a day the cap implies, as 60 was to 10.
    dictationsPerDay: 12,
    fairUseSttSecondsPerMonth: null
  },
  pro: {
    sttSecondsPerMonth: 60 * 60 * 60,
    llmTokensPerMonth: 25_000_000,
    requestsPerMinute: 60,
    maxClipSeconds: 600,
    wordsPerWeek: null,
    sttSecondsPerWeek: null,
    dictationsPerDay: null,
    fairUseSttSecondsPerMonth: 30 * 60 * 60
  }
}

/** Request rate for a Pro account past its soft fair-use cap (the free rate). */
export const FAIR_USE_REQUESTS_PER_MINUTE = PLANS.free.requestsPerMinute

export function planLimits(plan: Plan | undefined): PlanLimits {
  return PLANS[plan ?? DEFAULT_PLAN]
}

/**
 * The longest clip any tier accepts, in seconds. Convex HTTP actions cap request bodies at 20 MB,
 * which is roughly ten minutes of 16 kHz 16-bit mono WAV; the limit is slightly below that so the
 * client gets a readable error instead of a transport failure.
 */
export const MAX_CLIP_SECONDS = PLANS.pro.maxClipSeconds

/** Length of the request-rate window. */
export const RATE_WINDOW_MS = 60_000

/** Pro prices in USD cents; the Stripe prices the operator creates must match. */
export const PRO_PRICES = {
  month: { amountCents: 750, label: '$7.50 a month' },
  year: { amountCents: 7200, label: '$72 a year' }
} as const
export type BillingInterval = keyof typeof PRO_PRICES
export const billingIntervalValidator = v.union(v.literal('month'), v.literal('year'))

// ---- calendar helpers (all UTC) ---------------------------------------------------------------

/** Calendar month (UTC) a usage row belongs to, as `YYYY-MM`. */
export function usagePeriod(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Calendar day (UTC) as `YYYY-MM-DD`, the key of a daily usage bucket. */
export function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function isUsageDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false
  const start = dayStart(day)
  return Number.isFinite(start) && usageDay(start) === day
}

/** Midnight UTC that starts `day`, in epoch ms. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

export function shiftDay(day: string, days: number): string {
  return usageDay(dayStart(day) + days * DAY_MS)
}

/** The `WEEK_DAYS` UTC days ending on `day`, oldest first. */
export function weekDays(day: string): string[] {
  const out: string[] = []
  for (let i = WEEK_DAYS - 1; i >= 0; i--) out.push(shiftDay(day, -i))
  return out
}

/** First instant of the UTC month after the one containing `day`. */
export function nextMonthStart(day: string): number {
  const d = new Date(dayStart(day))
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** `Tue, Sep 16` in UTC, for the sentences limit errors carry. */
export function formatResetDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(ts))
}
