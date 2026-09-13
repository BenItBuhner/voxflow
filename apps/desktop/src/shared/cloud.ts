/**
 * Types shared between the main process (which owns the Convex connection and the offline mirror),
 * the preload bridge and the renderer (which owns the Clerk session and the UI).
 */

/**
 * How the build treats accounts.
 * - `off`: no cloud configured; the app is fully local (dev builds, self-hosted builds).
 * - `optional`: sign-in is offered but "continue without an account" is allowed.
 * - `required`: the production instance; every user signs up before onboarding.
 */
export type AccountMode = 'off' | 'optional' | 'required'

export type Plan = 'free' | 'pro'

/**
 * Where the account stands: the 14-day Pro trial every account starts with, the residual free tier
 * after it, or a paid (or operator-granted) Pro subscription. `plan` is the tier whose limits apply,
 * so a trial account is `pro` on `plan`. See internal/entitlements-contract.md in the Project store.
 */
export type PlanState = 'trial' | 'free' | 'pro'

/** The limits the gateway meters; the `limit` field of a usage meter and of a limit error. */
export type LimitName =
  | 'wordsPerWeek'
  | 'sttSecondsPerWeek'
  | 'dictationsPerDay'
  | 'maxClipSeconds'
  | 'sttSecondsPerMonth'
  | 'fairUseSttSecondsPerMonth'
  | 'llmTokensPerMonth'
  | 'requestsPerMinute'

/** One limit that applies to the account's tier, with how much of it is used. */
export interface UsageMeter {
  limit: LimitName
  used: number
  allowed: number
  exceeded: boolean
  /** Epoch ms: when `used` next drops; if exceeded, when it drops under `allowed`. */
  resetsAt: number
}

/** The rolling windows the gateway computed for the UTC day the client passed. */
export interface UsageWindow {
  day: string
  /** `day` minus six days: the first day of the rolling week. */
  weekStart: string
  words: number
  sttSeconds: number
  dictationsToday: number
}

/** Next resets (epoch ms): UTC midnight, the oldest counted day leaving the week, the first of next month. */
export interface UsageResets {
  day: number
  week: number | null
  month: number
}

export interface CloudConfig {
  accountMode: AccountMode
  convexUrl: string
  /**
   * Origin of the deployment's HTTP actions (`https://<name>.convex.site`), where the managed
   * inference gateway lives. Empty in local builds.
   */
  convexSiteUrl: string
  clerkPublishableKey: string
  /** Clerk Frontend API host derived from the publishable key, e.g. clerk.murmur.app. */
  clerkFrontendApiHost: string
  /** Custom URL scheme that serves the renderer and receives OAuth deep links. */
  deepLinkScheme: string
  /** Name of the Clerk JWT template that mints Convex tokens. */
  jwtTemplate: string
}

/** What the renderer reports about the Clerk session. */
export interface RendererAuthState {
  signedIn: boolean
  userId?: string
  email?: string
  name?: string
  imageUrl?: string
}

export interface CloudUser {
  id: string
  clerkId: string
  email?: string
  name?: string
  imageUrl?: string
  /** Account tier; decides the managed-inference allowance. */
  plan: Plan
  /** Absent from an instance that predates plan states; then `plan` alone tells the story. */
  planState?: PlanState
  /** Epoch ms; present once the account has been granted its trial. */
  trialEndsAt?: number
  onboardingCompletedAt?: number
  onboardingVersion?: number
}

/**
 * What the instance offers the signed-in account in managed models, and how much is left. The
 * fields after `usage` arrive from an instance that meters plans; an older instance leaves them
 * out, and `planState` then follows `plan`.
 */
export interface InferenceStatus {
  /** The instance is configured with at least a managed speech model. */
  available: boolean
  models: { stt: string | null; llm: string | null }
  plan: Plan
  limits: {
    sttSecondsPerMonth: number
    llmTokensPerMonth: number
    requestsPerMinute: number
    maxClipSeconds: number
  }
  /** Newest month with any usage (`YYYY-MM`, UTC); other months count as zero. */
  usage: {
    period: string
    sttSeconds: number
    sttRequests: number
    llmTokens: number
    llmRequests: number
  }
  planState?: PlanState
  trialEndsAt?: number | null
  /** Pro past the soft fair-use cap: `/v1/format` answers with rule-based text until the month resets. */
  formattingPaused?: boolean
  /** The web account page that starts an upgrade; null when the instance has no site URL. */
  upgradeUrl?: string | null
  /** Null when the status was fetched without the client's UTC day. */
  window?: UsageWindow | null
  /** Empty when the status was fetched without the client's UTC day. */
  meters?: UsageMeter[]
  resets?: UsageResets | null
}

export interface CloudDevice {
  deviceId: string
  name: string
  platform: string
  appVersion: string
  lastSeenAt: number
  createdAt: number
  /** True for the device this app is running on. */
  current: boolean
}

export type SyncPhase =
  | 'disabled' // accountMode off
  | 'signed-out'
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error'

export interface SyncStatus {
  configured: boolean
  phase: SyncPhase
  signedIn: boolean
  /** True once the Convex WebSocket is authenticated with a Clerk token. */
  authenticated: boolean
  connected: boolean
  pendingOps: number
  lastSyncedAt?: number
  error?: string
  user: CloudUser | null
  devices: CloudDevice[]
  deviceId: string
  /** Managed-model availability and allowance; null until the account is connected. */
  inference: InferenceStatus | null
}

/** Current UTC month as `YYYY-MM`, the period the gateway bills usage to. */
export function currentUsagePeriod(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Current UTC calendar day as `YYYY-MM-DD`, the `day` the status query computes its windows for. */
export function currentUtcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Milliseconds from `now` to the next UTC midnight, when the status query has to be asked again. */
export function msUntilNextUtcDay(now = Date.now()): number {
  const d = new Date(now)
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(1, next - now)
}

export interface TokenRequest {
  id: string
  forceRefresh: boolean
}

export interface TokenResponse {
  id: string
  token: string | null
  error?: string
}

export const ONBOARDING_VERSION = 1

export const DEFAULT_DEEP_LINK_SCHEME = 'murmur'
export const DEFAULT_JWT_TEMPLATE = 'convex'
