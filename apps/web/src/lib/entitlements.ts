import type { InferenceStatus } from '@/lib/backend-api'
import { formatAudioSeconds, formatNumber } from '@/lib/format'

/**
 * The account page's reading of the backend's entitlement contract (packages/backend/convex/lib/
 * entitlements.ts): plan states, the meters and when they reset. Pure, so the copy is testable.
 */

export type PlanState = InferenceStatus['planState']
export type Meter = InferenceStatus['meters'][number]
export type LimitName = Meter['limit']
export type BillingInterval = 'month' | 'year'

const DAY_MS = 86_400_000

/** The UTC calendar day the backend keys daily usage by, as `YYYY-MM-DD`. */
export function usageDayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function planLabel(state: PlanState): string {
  return state === 'trial' ? 'Pro trial' : state === 'pro' ? 'Pro' : 'Free'
}

/** Whole days left in the trial, never negative. */
export function trialDaysLeft(trialEndsAt: number, now: number): number {
  return Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS))
}

/** `Tue 16 Sep`, in UTC like the backend's windows. */
export function formatUtcDate(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  }).format(new Date(ts))
}

/** `16 September 2026`, for billing dates. */
export function formatLongDate(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(ts))
}

/** When a meter next moves, as a person would say it. */
export function describeReset(resetsAt: number, now: number): string {
  const days = Math.ceil((resetsAt - now) / DAY_MS)
  if (resetsAt <= now) return 'now'
  if (days <= 1) return 'at midnight UTC'
  return `on ${formatUtcDate(resetsAt)}`
}

const METER_LABELS: Record<LimitName, string> = {
  wordsPerWeek: 'Words, last 7 days',
  sttSecondsPerWeek: 'Audio, last 7 days',
  dictationsPerDay: 'Dictations today',
  maxClipSeconds: 'Clip length',
  sttSecondsPerMonth: 'Audio this month',
  fairUseSttSecondsPerMonth: 'Audio this month, fair use',
  llmTokensPerMonth: 'Formatting tokens this month',
  requestsPerMinute: 'Requests a minute'
}

const AUDIO_METERS: ReadonlySet<LimitName> = new Set([
  'sttSecondsPerWeek',
  'sttSecondsPerMonth',
  'fairUseSttSecondsPerMonth'
])

/** The meters worth a bar on the account page, for the tier. */
export function displayedMeters(status: InferenceStatus): Meter[] {
  const shown: LimitName[] =
    status.plan === 'free'
      ? ['wordsPerWeek', 'sttSecondsPerWeek', 'dictationsPerDay']
      : ['fairUseSttSecondsPerMonth', 'sttSecondsPerMonth']
  return shown
    .map((limit) => status.meters.find((m) => m.limit === limit))
    .filter((m): m is Meter => m !== undefined)
}

export interface MeterView {
  limit: LimitName
  label: string
  used: number
  allowed: number
  display: string
  ratio: number
  exceeded: boolean
  resetsAt: number
}

export function meterView(meter: Meter): MeterView {
  const audio = AUDIO_METERS.has(meter.limit)
  const fmt = (n: number): string => (audio ? formatAudioSeconds(n) : formatNumber(Math.round(n)))
  return {
    limit: meter.limit,
    label: METER_LABELS[meter.limit],
    used: meter.used,
    allowed: meter.allowed,
    display: `${fmt(meter.used)} of ${fmt(meter.allowed)}`,
    ratio: meter.allowed > 0 ? Math.min(1, meter.used / meter.allowed) : 0,
    exceeded: meter.exceeded,
    resetsAt: meter.resetsAt
  }
}

/** The sentence for a meter that has run out, if any has. */
export function exhaustedNotice(status: InferenceStatus, now: number): string | null {
  const words = status.meters.find((m) => m.limit === 'wordsPerWeek')
  if (words?.exceeded)
    return `This week's ${formatNumber(words.allowed)} words are used; more open up ${describeReset(words.resetsAt, now)}.`
  const audio = status.meters.find((m) => m.limit === 'sttSecondsPerWeek')
  if (audio?.exceeded)
    return `This week's ${formatAudioSeconds(audio.allowed)} of audio are used; more ${describeReset(audio.resetsAt, now)}.`
  const day = status.meters.find((m) => m.limit === 'dictationsPerDay')
  if (day?.exceeded)
    return `Today's ${day.allowed} dictations are used; more ${describeReset(day.resetsAt, now)}.`
  const hard = status.meters.find((m) => m.limit === 'sttSecondsPerMonth')
  if (hard?.exceeded && status.plan === 'pro')
    return `This month's ${formatAudioSeconds(hard.allowed)} of fair use are used; transcription resumes ${describeReset(hard.resetsAt, now)}.`
  if (status.formattingPaused) {
    const soft = status.meters.find((m) => m.limit === 'fairUseSttSecondsPerMonth')
    return `Past ${soft ? formatAudioSeconds(soft.allowed) : '30 h'} of audio this month the formatting model pauses and dictation continues with rule-based cleanup${soft ? `, until ${formatUtcDate(soft.resetsAt)}` : ''}.`
  }
  return null
}

// ---- URL parameters the account page reacts to ----------------------------------------------

/** `?upgrade=yearly|monthly|1` from the pricing page or a limit error's upgrade URL. */
export function upgradeIntent(value: string | null): BillingInterval | null {
  if (value === null) return null
  if (value === 'monthly' || value === 'month') return 'month'
  return 'year'
}

/** `?checkout=success|cancelled` from Stripe's return URLs. */
export function checkoutOutcome(value: string | null): 'success' | 'cancelled' | null {
  return value === 'success' || value === 'cancelled' ? value : null
}
