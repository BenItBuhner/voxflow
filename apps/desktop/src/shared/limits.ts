import type { LimitName, Plan, PlanState, UsageMeter } from './cloud'

/**
 * The structured part of a gateway refusal (HTTP 429/413 with `error.limit`), or of the `limit`
 * object `/v1/format` attaches when it skipped the model for fair use. Both apps render these
 * rather than the sentence alone, so the user learns which limit it was and when it comes back.
 * Field names follow internal/entitlements-contract.md in the Project store.
 */
export interface LimitNotice {
  limit: LimitName
  plan: Plan
  planState: PlanState
  used: number
  allowed: number
  /** Epoch ms when the limit next lets a request through; null for a per-request limit. */
  resetsAt: number | null
  /** The web account page that starts an upgrade; null when already Pro or the instance has no site. */
  upgradeUrl: string | null
  /** The gateway's own sentence. */
  message: string
}

const LIMIT_NAMES: ReadonlySet<string> = new Set<LimitName>([
  'wordsPerWeek',
  'sttSecondsPerWeek',
  'dictationsPerDay',
  'maxClipSeconds',
  'sttSecondsPerMonth',
  'fairUseSttSecondsPerMonth',
  'llmTokensPerMonth',
  'requestsPerMinute'
])

export function isLimitName(value: unknown): value is LimitName {
  return typeof value === 'string' && LIMIT_NAMES.has(value)
}

/**
 * Read a limit notice out of an object that carries the contract's fields: a gateway `error`
 * object or a `/v1/format` `limit` object. Null when there is no known `limit` in it.
 */
export function parseLimitNotice(source: unknown, message?: string): LimitNotice | null {
  if (!source || typeof source !== 'object') return null
  const o = source as Record<string, unknown>
  if (!isLimitName(o.limit)) return null
  const plan: Plan = o.plan === 'pro' ? 'pro' : 'free'
  const planState: PlanState =
    o.planState === 'trial' || o.planState === 'pro' || o.planState === 'free' ? o.planState : plan
  return {
    limit: o.limit,
    plan,
    planState,
    used: typeof o.used === 'number' && Number.isFinite(o.used) ? o.used : 0,
    allowed: typeof o.allowed === 'number' && Number.isFinite(o.allowed) ? o.allowed : 0,
    resetsAt: typeof o.resetsAt === 'number' && Number.isFinite(o.resetsAt) ? o.resetsAt : null,
    upgradeUrl: typeof o.upgradeUrl === 'string' && o.upgradeUrl ? o.upgradeUrl : null,
    message: message ?? (typeof o.message === 'string' ? o.message : '')
  }
}

/**
 * The limits that stop a dictation for plan reasons. A rate limit is a plain "try again in a
 * moment" and gets the ordinary error treatment, not the upgrade conversation.
 */
export function isPlanLimit(limit: LimitName): boolean {
  return limit !== 'requestsPerMinute'
}

export function planStateLabel(state: PlanState): string {
  switch (state) {
    case 'trial':
      return 'Pro trial'
    case 'pro':
      return 'Pro'
    default:
      return 'Free'
  }
}

/** The account's plan state, from an instance that reports one or, failing that, from its tier. */
export function planStateOf(
  status: { planState?: PlanState; plan: Plan } | null | undefined,
  user?: { planState?: PlanState; plan: Plan } | null
): PlanState {
  if (status?.planState) return status.planState
  if (user?.planState) return user.planState
  const plan = status?.plan ?? user?.plan ?? 'free'
  return plan === 'pro' ? 'pro' : 'free'
}

/** Whole days left on the trial, never negative: `ceil((trialEndsAt - now) / 24 h)`. */
export function trialDaysLeft(trialEndsAt: number | null | undefined, now = Date.now()): number {
  if (typeof trialEndsAt !== 'number') return 0
  return Math.max(0, Math.ceil((trialEndsAt - now) / 86_400_000))
}

// ---- wording --------------------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function clockTime(d: Date): string {
  const h = d.getHours()
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * When a limit comes back, the way a person would say it: "in 40 min", "at 3:00 pm",
 * "tomorrow at 1:00 am", "Tue 16 Sep". Local time; the gateway's instants are UTC-aligned.
 */
export function formatResetTime(resetsAt: number, now = Date.now()): string {
  const diff = resetsAt - now
  if (diff < MINUTE) return 'in a moment'
  if (diff < HOUR) return `in ${Math.ceil(diff / MINUTE)} min`
  const then = new Date(resetsAt)
  const today = new Date(now)
  if (sameLocalDay(then, today)) return `at ${clockTime(then)}`
  const tomorrow = new Date(now + DAY)
  if (sameLocalDay(then, tomorrow)) return `tomorrow at ${clockTime(then)}`
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`
  return diff < 6 * DAY ? `${WEEKDAYS[then.getDay()]} ${date}` : `on ${date}`
}

function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

/** Token counts read in thousands and millions: "12k", "500k", "2.1M", "25M". */
export function compactCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return formatCount(n)
}

/** Seconds of audio as a figure in the unit the allowance is naturally read in: minutes, or hours from 3 h up. */
function audioFigure(seconds: number, allowedSeconds: number): { value: string; unit: string } {
  const hours = allowedSeconds >= 3 * 3600 && allowedSeconds % 3600 === 0
  if (hours) {
    const h = seconds / 3600
    const value = h >= 10 || Number.isInteger(h) ? Math.round(h).toString() : h.toFixed(1)
    return { value, unit: 'h' }
  }
  const m = seconds / 60
  return { value: m > 0 && m < 1 ? '<1' : Math.round(m).toString(), unit: 'min' }
}

/** "7 min", "120 min", "30 h"; `allowedSeconds` decides the unit when a used figure is shown against it. */
export function formatAudioSeconds(seconds: number, allowedSeconds = seconds): string {
  const { value, unit } = audioFigure(seconds, allowedSeconds)
  return `${value} ${unit}`
}

/** "312 of 500 words", "12 of 120 min", "2.5 of 30 h", "3 of 12". */
export function meterValue(meter: Pick<UsageMeter, 'limit' | 'used' | 'allowed'>): string {
  switch (meter.limit) {
    case 'wordsPerWeek':
      return `${formatCount(meter.used)} of ${formatCount(meter.allowed)} words`
    case 'sttSecondsPerWeek':
    case 'sttSecondsPerMonth':
    case 'fairUseSttSecondsPerMonth':
      return `${audioFigure(meter.used, meter.allowed).value} of ${formatAudioSeconds(meter.allowed)}`
    case 'llmTokensPerMonth':
      return `${compactCount(meter.used)} of ${compactCount(meter.allowed)} tokens`
    case 'maxClipSeconds':
      return `up to ${formatAudioSeconds(meter.allowed)} a clip`
    default:
      return `${formatCount(meter.used)} of ${formatCount(meter.allowed)}`
  }
}

/** The Account page's label for a meter. */
export function meterLabel(limit: LimitName): string {
  switch (limit) {
    case 'wordsPerWeek':
      return 'Words this week'
    case 'sttSecondsPerWeek':
      return 'Speech this week'
    case 'dictationsPerDay':
      return 'Dictations today'
    case 'sttSecondsPerMonth':
      return 'Transcription this month'
    case 'fairUseSttSecondsPerMonth':
      return 'Fair use this month'
    case 'llmTokensPerMonth':
      return 'Formatting this month'
    case 'maxClipSeconds':
      return 'Recording length'
    default:
      return 'Requests this minute'
  }
}

/** Meters worth a row on the Account page: the ones that fill up over time. */
export function usageMeters(meters: UsageMeter[] | undefined): UsageMeter[] {
  return (meters ?? []).filter(
    (m) => m.limit !== 'maxClipSeconds' && m.limit !== 'requestsPerMinute'
  )
}

export interface LimitCopy {
  /** One line: what ran out. */
  title: string
  /** One line: the allowance, and when it comes back. */
  detail: string
  /** Upgrading lifts this limit (never for a cap Pro already has). */
  upgradeHelps: boolean
}

function tierPhrase(notice: LimitNotice): string {
  return notice.plan === 'pro' ? 'on Pro' : 'on the free plan'
}

/**
 * The calm version of a limit refusal: which limit it was, what the allowance is, and when it
 * resets. `stage` says what the limit stopped; a formatting limit never loses text (the rule-based
 * cleanup is inserted instead), so its copy leads with that and gives the reason second.
 */
export function describeLimit(
  notice: LimitNotice,
  now = Date.now(),
  stage: 'speech' | 'formatting' = 'speech'
): LimitCopy {
  const reset = notice.resetsAt !== null ? formatResetTime(notice.resetsAt, now) : null
  const resets = reset ? ` · resets ${reset}` : ''
  const stop = describeStop(notice)
  if (stage === 'formatting') {
    return {
      title: 'Inserted without formatting',
      detail: `${stop.title}${resets}`,
      upgradeHelps: stop.upgradeHelps
    }
  }
  return { ...stop, detail: `${stop.detail}${resets}` }
}

/** What ran out and the allowance behind it, without the reset (added by the caller). */
function describeStop(notice: LimitNotice): LimitCopy {
  const tier = tierPhrase(notice)
  const pro = notice.plan === 'pro'
  switch (notice.limit) {
    case 'wordsPerWeek':
      return {
        title: "This week's free words are used up",
        detail: `${formatCount(notice.allowed)} words a week ${tier}`,
        upgradeHelps: true
      }
    case 'sttSecondsPerWeek':
      return {
        title: "This week's free minutes are used up",
        detail: `${formatAudioSeconds(notice.allowed)} of speech a week ${tier}`,
        upgradeHelps: true
      }
    case 'dictationsPerDay':
      return {
        title: "Today's free dictations are used up",
        detail: `${formatCount(notice.allowed)} dictations a day ${tier}`,
        upgradeHelps: true
      }
    case 'maxClipSeconds':
      return {
        title: pro ? 'That recording is too long' : 'That recording is too long for the free plan',
        detail: pro
          ? `Clips can be up to ${formatAudioSeconds(notice.allowed)}`
          : `Clips up to ${formatAudioSeconds(notice.allowed)} ${tier}; up to 10 min on Pro`,
        upgradeHelps: !pro
      }
    case 'sttSecondsPerMonth':
      return {
        title: pro
          ? "This month's fair-use cap is reached"
          : "This month's free transcription is used up",
        detail: `${formatAudioSeconds(notice.allowed)} a month ${tier}`,
        upgradeHelps: !pro
      }
    case 'fairUseSttSecondsPerMonth':
      return {
        title: 'Fair use reached for this month',
        detail: `Past ${formatAudioSeconds(notice.allowed)} of transcription a month the text is tidied by rules only`,
        upgradeHelps: false
      }
    case 'llmTokensPerMonth':
      return {
        title: "This month's formatting allowance is used up",
        detail: `${compactCount(notice.allowed)} tokens a month ${tier}`,
        upgradeHelps: !pro
      }
    default:
      return {
        title: 'Too many requests at once',
        detail: `Up to ${formatCount(notice.allowed)} requests a minute ${tier}`,
        upgradeHelps: !pro
      }
  }
}
