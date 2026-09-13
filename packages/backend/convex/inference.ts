import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server'
import {
  ZERO_MONTH,
  checkFormatting,
  checkRate,
  checkTranscription,
  formattingPaused,
  meterValidator,
  metersFor,
  refusalValidator,
  requestRateFor,
  weekBuckets,
  weekRollsAt,
  type DayUsage,
  type Meter,
  type MonthUsage,
  type UsageSnapshot
} from './lib/entitlements'
import { authedQuery } from './lib/functions'
import { MURMUR_MODELS, accountUrlFor, readUpstreams, upgradeUrlFor } from './lib/inference'
import {
  DAY_MS,
  RATE_WINDOW_MS,
  dayStart,
  isUsageDay,
  nextMonthStart,
  planLimits,
  planStateValidator,
  planValidator,
  shiftDay,
  tierOf,
  usageDay,
  usagePeriod,
  WEEK_DAYS
} from './lib/plans'
import { planStateOf, upsertUser } from './lib/users'
import {
  inferenceKindValidator,
  inferenceStatusValidator,
  type InferenceStatus
} from './lib/validators'

/**
 * Account-side view of the managed inference gateway (convex/gateway.ts): which models this
 * instance offers, what the account's tier allows, and how much of it has been used. The rules
 * themselves live in lib/entitlements.ts; this file reads and writes the usage rows around them.
 */

async function monthRow(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  period: string
): Promise<Doc<'inferenceUsage'> | null> {
  return await ctx.db
    .query('inferenceUsage')
    .withIndex('by_user_and_period', (q) => q.eq('userId', userId).eq('period', period))
    .unique()
}

async function dayRows(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  from: string,
  to: string
): Promise<Doc<'inferenceDays'>[]> {
  return await ctx.db
    .query('inferenceDays')
    .withIndex('by_user_and_day', (q) => q.eq('userId', userId).gte('day', from).lte('day', to))
    .collect()
}

const toDayUsage = (row: Doc<'inferenceDays'>): DayUsage => ({
  day: row.day,
  words: row.words,
  sttSeconds: row.sttSeconds,
  dictations: row.dictations,
  formats: row.formats
})

const toMonthUsage = (row: Doc<'inferenceUsage'> | null): MonthUsage =>
  row
    ? {
        sttSeconds: row.sttSeconds,
        sttRequests: row.sttRequests,
        llmTokens: row.llmTokens,
        llmRequests: row.llmRequests
      }
    : ZERO_MONTH

/** The rolling week ending on `day` and the month containing it. */
async function snapshotFor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  day: string
): Promise<UsageSnapshot> {
  const weekStart = shiftDay(day, -(WEEK_DAYS - 1))
  const [days, month] = await Promise.all([
    dayRows(ctx, userId, weekStart, day),
    monthRow(ctx, userId, day.slice(0, 7))
  ])
  return { day, days: days.map(toDayUsage), month: toMonthUsage(month) }
}

/**
 * The instance's managed models and this account's allowance and usage. Pass `day`, the client's
 * current UTC calendar day (`YYYY-MM-DD`), to get the rolling-week and per-day meters; the query
 * takes the day rather than reading the clock so its result is stable and cacheable within a day.
 */
export const status = authedQuery({
  args: { day: v.optional(v.string()) },
  returns: inferenceStatusValidator,
  handler: async (ctx, args): Promise<InferenceStatus> => {
    if (args.day !== undefined && !isUsageDay(args.day))
      throw new Error('"day" must be a UTC calendar day as YYYY-MM-DD')
    const upstreams = readUpstreams(process.env)
    const planState = ctx.user ? planStateOf(ctx.user) : 'free'
    const plan = tierOf(planState)
    const limits = planLimits(plan)
    // Newest month with any usage; `period` sorts lexicographically, so the index order is enough.
    const latest = ctx.user
      ? await ctx.db
          .query('inferenceUsage')
          .withIndex('by_user_and_period', (q) => q.eq('userId', ctx.user!._id))
          .order('desc')
          .first()
      : null
    const base: InferenceStatus = {
      available: upstreams.stt !== null,
      models: {
        stt: upstreams.stt ? MURMUR_MODELS.stt : null,
        llm: upstreams.llm ? MURMUR_MODELS.llm : null
      },
      plan,
      planState,
      trialEndsAt: ctx.user?.trialEndsAt ?? null,
      limits: {
        sttSecondsPerMonth: limits.sttSecondsPerMonth,
        llmTokensPerMonth: limits.llmTokensPerMonth,
        requestsPerMinute: limits.requestsPerMinute,
        maxClipSeconds: limits.maxClipSeconds
      },
      usage: latest
        ? {
            period: latest.period,
            sttSeconds: latest.sttSeconds,
            sttRequests: latest.sttRequests,
            llmTokens: latest.llmTokens,
            llmRequests: latest.llmRequests
          }
        : { period: '', ...ZERO_MONTH },
      formattingPaused: false,
      upgradeUrl: upgradeUrlFor(process.env, planState),
      accountUrl: accountUrlFor(process.env),
      window: null,
      meters: [],
      resets: null
    }
    if (args.day === undefined) return base
    const day = args.day
    const snapshot: UsageSnapshot = ctx.user
      ? await snapshotFor(ctx, ctx.user._id, day)
      : { day, days: [], month: ZERO_MONTH }
    const buckets = weekBuckets(day, snapshot.days)
    const today = buckets[buckets.length - 1]
    return {
      ...base,
      formattingPaused: formattingPaused(limits, snapshot.month),
      window: {
        day,
        weekStart: buckets[0].day,
        words: buckets.reduce((acc, b) => acc + b.words, 0),
        sttSeconds: buckets.reduce((acc, b) => acc + b.sttSeconds, 0),
        dictationsToday: Math.max(today.dictations, today.formats)
      },
      meters: metersFor(limits, snapshot),
      resets: {
        day: dayStart(day) + DAY_MS,
        week: weekRollsAt(buckets),
        month: nextMonthStart(day)
      }
    }
  }
})

const authorizeResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    userId: v.id('users'),
    plan: planValidator,
    planState: planStateValidator,
    /** Set when the caller may proceed without the model (Pro past its soft fair-use cap). */
    paused: v.union(meterValidator, v.null())
  }),
  v.object({
    ok: v.literal(false),
    plan: planValidator,
    planState: planStateValidator,
    refusal: refusalValidator
  })
)

/**
 * Gate one managed request. Provisions the account row if the Clerk webhook has not created it yet
 * (which also starts its trial), settles a trial that has run out, refuses when a limit of the
 * tier is reached or the account is asking too fast, and otherwise counts the request against the
 * rate window. Usage itself is added by `record` once the upstream answered, so a failed request
 * never costs allowance.
 */
export const authorize = internalMutation({
  args: {
    clerkId: v.string(),
    kind: inferenceKindValidator,
    /** Clip length for speech requests, so a request that cannot fit is refused up front. */
    seconds: v.optional(v.number()),
    /** The caller can answer with rule-based text instead of failing (/v1/format). */
    degradable: v.optional(v.boolean())
  },
  returns: authorizeResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await upsertUser(ctx, args.clerkId, {}, now)
    const planState = planStateOf(user)
    const plan = tierOf(planState)
    const limits = planLimits(plan)
    const day = usageDay(now)
    const period = usagePeriod(now)
    const [snapshot, usage] = await Promise.all([
      snapshotFor(ctx, user._id, day),
      monthRow(ctx, user._id, period)
    ])
    const check = { plan, state: planState, limits, snapshot, now }

    let paused: Meter | null = null
    if (args.kind === 'stt') {
      const refusal = checkTranscription(check, Math.max(0, args.seconds ?? 0))
      if (refusal) return { ok: false as const, plan, planState, refusal }
    } else {
      const verdict = checkFormatting(check, args.degradable === true)
      if (!verdict.ok) return { ok: false as const, plan, planState, refusal: verdict.refusal }
      paused = verdict.paused
    }

    const windowFresh = usage?.windowStart !== undefined && now - usage.windowStart < RATE_WINDOW_MS
    const windowStart = windowFresh ? usage!.windowStart! : now
    const windowCount = windowFresh ? (usage!.windowCount ?? 0) : 0
    const rate = checkRate(requestRateFor(limits, snapshot.month), windowStart, windowCount, now)
    if (rate) return { ok: false as const, plan, planState, refusal: rate }

    if (usage) {
      await ctx.db.patch('inferenceUsage', usage._id, {
        windowStart,
        windowCount: windowCount + 1,
        updatedAt: now
      })
    } else {
      await ctx.db.insert('inferenceUsage', {
        userId: user._id,
        period,
        ...ZERO_MONTH,
        windowStart,
        windowCount: 1,
        updatedAt: now
      })
    }
    return { ok: true as const, userId: user._id, plan, planState, paused }
  }
})

/** Add what a successful upstream request consumed to the current month and day. */
export const record = internalMutation({
  args: {
    userId: v.id('users'),
    kind: inferenceKindValidator,
    seconds: v.optional(v.number()),
    tokens: v.optional(v.number()),
    /** Words in the transcript the speech model returned. */
    words: v.optional(v.number())
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now()
    const period = usagePeriod(now)
    const day = usageDay(now)
    const [usage, [dayRow]] = await Promise.all([
      monthRow(ctx, args.userId, period),
      dayRows(ctx, args.userId, day, day)
    ])
    const seconds = Math.max(0, args.seconds ?? 0)
    const tokens = Math.max(0, Math.floor(args.tokens ?? 0))
    const words = Math.max(0, Math.floor(args.words ?? 0))
    const delta =
      args.kind === 'stt'
        ? { sttSeconds: (usage?.sttSeconds ?? 0) + seconds, sttRequests: (usage?.sttRequests ?? 0) + 1 }
        : { llmTokens: (usage?.llmTokens ?? 0) + tokens, llmRequests: (usage?.llmRequests ?? 0) + 1 }
    if (usage) {
      await ctx.db.patch('inferenceUsage', usage._id, { ...delta, updatedAt: now })
    } else {
      await ctx.db.insert('inferenceUsage', {
        userId: args.userId,
        period,
        ...ZERO_MONTH,
        ...delta,
        updatedAt: now
      })
    }
    const dayDelta =
      args.kind === 'stt'
        ? {
            words: (dayRow?.words ?? 0) + words,
            sttSeconds: (dayRow?.sttSeconds ?? 0) + seconds,
            dictations: (dayRow?.dictations ?? 0) + 1
          }
        : { formats: (dayRow?.formats ?? 0) + 1 }
    if (dayRow) {
      await ctx.db.patch('inferenceDays', dayRow._id, { ...dayDelta, updatedAt: now })
    } else {
      await ctx.db.insert('inferenceDays', {
        userId: args.userId,
        day,
        words: 0,
        sttSeconds: 0,
        dictations: 0,
        formats: 0,
        ...dayDelta,
        updatedAt: now
      })
    }
    return null
  }
})
