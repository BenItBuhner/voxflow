import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import {
  checkFormatting,
  checkRate,
  checkTranscription,
  metersFor,
  rollingResetAt,
  weekBuckets,
  weekRollsAt,
  type DayUsage,
  type UsageSnapshot
} from '../convex/lib/entitlements'
import { transcriptWords, upgradeUrlFor } from '../convex/lib/inference'
import {
  DAY_MS,
  PLANS,
  TRIAL_MS,
  dayStart,
  formatResetDate,
  isUsageDay,
  nextMonthStart,
  shiftDay,
  usageDay,
  usagePeriod,
  weekDays
} from '../convex/lib/plans'
import {
  LLM_ENV,
  STT_ENV,
  ada,
  chatAnswer,
  chatRequest,
  formatRequest,
  jsonResponse,
  makeWav,
  setup,
  sttRequest,
  stubEnv,
  stubFetch
} from './helpers'

/** Sunday 13 September 2026, noon UTC: the week is 7..13 September, the month resets on 1 October. */
const NOW = Date.UTC(2026, 8, 13, 12, 0, 0)
const TODAY = '2026-09-13'
const TOMORROW = Date.UTC(2026, 8, 14)
const OCTOBER = Date.UTC(2026, 9, 1)
const SITE = 'https://murmur.test'

const bucket = (day: string, partial: Partial<DayUsage> = {}): DayUsage => ({
  day,
  words: 0,
  sttSeconds: 0,
  dictations: 0,
  formats: 0,
  ...partial
})

const snapshot = (
  days: DayUsage[] = [],
  month: Partial<UsageSnapshot['month']> = {}
): UsageSnapshot => ({
  day: TODAY,
  days,
  month: { sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0, ...month }
})

const free = {
  plan: 'free' as const,
  state: 'free' as const,
  limits: PLANS.free,
  snapshot: snapshot(),
  now: NOW
}
const pro = {
  plan: 'pro' as const,
  state: 'pro' as const,
  limits: PLANS.pro,
  snapshot: snapshot(),
  now: NOW
}

type T = ReturnType<typeof setup>

async function seedDay(
  t: T,
  userId: Id<'users'>,
  day: string,
  partial: Partial<DayUsage>
): Promise<void> {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query('inferenceDays')
      .withIndex('by_user_and_day', (q) => q.eq('userId', userId).eq('day', day))
      .unique()
    if (existing) await ctx.db.patch('inferenceDays', existing._id, partial)
    else await ctx.db.insert('inferenceDays', { userId, ...bucket(day, partial), updatedAt: NOW })
  })
}

async function seedMonth(
  t: T,
  userId: Id<'users'>,
  partial: Partial<{
    sttSeconds: number
    llmTokens: number
    windowStart: number
    windowCount: number
  }>
): Promise<void> {
  await t.run(async (ctx) => {
    const period = usagePeriod(NOW)
    const existing = await ctx.db
      .query('inferenceUsage')
      .withIndex('by_user_and_period', (q) => q.eq('userId', userId).eq('period', period))
      .unique()
    if (existing) await ctx.db.patch('inferenceUsage', existing._id, partial)
    else
      await ctx.db.insert('inferenceUsage', {
        userId,
        period,
        sttSeconds: 0,
        sttRequests: 0,
        llmTokens: 0,
        llmRequests: 0,
        updatedAt: NOW,
        ...partial
      })
  })
}

/** An account on the residual free tier (every account starts on the trial). */
async function freeAccount(t: T, clerkId = 'user_ada'): Promise<Id<'users'>> {
  const user = await t.mutation(internal.users.setPlan, { clerkId, plan: 'free' })
  return user.id
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  stubEnv({ ...STT_ENV, ...LLM_ENV, MURMUR_SITE_URL: SITE })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('calendar helpers', () => {
  it('keys days and months in UTC and walks the rolling week', () => {
    expect(usageDay(NOW)).toBe(TODAY)
    expect(usageDay(Date.UTC(2026, 8, 13, 23, 59, 59))).toBe(TODAY)
    expect(usageDay(Date.UTC(2026, 8, 14, 0, 0, 0))).toBe('2026-09-14')
    expect(shiftDay(TODAY, -6)).toBe('2026-09-07')
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30')
    expect(weekDays(TODAY)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13'
    ])
    expect(dayStart(TODAY)).toBe(Date.UTC(2026, 8, 13))
    expect(nextMonthStart(TODAY)).toBe(OCTOBER)
    expect(nextMonthStart('2026-12-31')).toBe(Date.UTC(2027, 0, 1))
    expect(isUsageDay(TODAY)).toBe(true)
    expect(isUsageDay('2026-02-30')).toBe(false)
    expect(isUsageDay('13-09-2026')).toBe(false)
    expect(isUsageDay('2026-9-3')).toBe(false)
    expect(formatResetDate(TOMORROW)).toBe('Mon, Sep 14')
  })

  it('says when a rolling meter next moves', () => {
    const pick = (d: DayUsage): number => d.words
    // Nothing counted: the window rolls tomorrow.
    expect(rollingResetAt(TODAY, weekBuckets(TODAY, []), pick, 500)).toBe(TOMORROW)
    // Under the cap: when the oldest counted day leaves the window (day − 3 leaves at day + 4).
    const three = weekBuckets(TODAY, [bucket('2026-09-10', { words: 120 })])
    expect(rollingResetAt(TODAY, three, pick, 500)).toBe(Date.UTC(2026, 8, 17))
    // Over the cap because of an old day: dropping it is enough, so tomorrow.
    const old = weekBuckets(TODAY, [
      bucket('2026-09-07', { words: 300 }),
      bucket('2026-09-11', { words: 250 })
    ])
    expect(rollingResetAt(TODAY, old, pick, 500)).toBe(TOMORROW)
    // Over the cap today alone: today has to leave, a week from now.
    const today = weekBuckets(TODAY, [bucket(TODAY, { words: 600 })])
    expect(rollingResetAt(TODAY, today, pick, 500)).toBe(Date.UTC(2026, 8, 20))
    expect(weekRollsAt(weekBuckets(TODAY, []))).toBeNull()
    expect(weekRollsAt(three)).toBe(Date.UTC(2026, 8, 17))
  })
})

describe('meters', () => {
  it('lists the free tier’s meters in display order with their resets', () => {
    const meters = metersFor(
      PLANS.free,
      snapshot(
        [
          bucket('2026-09-09', { words: 200, sttSeconds: 100, dictations: 5 }),
          bucket(TODAY, { dictations: 2, formats: 4 })
        ],
        {
          sttSeconds: 300,
          llmTokens: 1000
        }
      )
    )
    expect(meters.map((m) => m.limit)).toEqual([
      'wordsPerWeek',
      'sttSecondsPerWeek',
      'dictationsPerDay',
      'sttSecondsPerMonth',
      'llmTokensPerMonth'
    ])
    expect(meters[0]).toEqual({
      limit: 'wordsPerWeek',
      used: 200,
      allowed: 500,
      exceeded: false,
      resetsAt: Date.UTC(2026, 8, 16)
    })
    expect(meters[1]).toMatchObject({ used: 100, allowed: 420, exceeded: false })
    // Today's dictations are the larger of transcriptions and formatting requests.
    expect(meters[2]).toEqual({
      limit: 'dictationsPerDay',
      used: 4,
      allowed: 12,
      exceeded: false,
      resetsAt: TOMORROW
    })
    expect(meters[3]).toEqual({
      limit: 'sttSecondsPerMonth',
      used: 300,
      allowed: 7200,
      exceeded: false,
      resetsAt: OCTOBER
    })
    expect(meters[4]).toMatchObject({ used: 1000, allowed: 500_000, resetsAt: OCTOBER })
  })

  it('gives Pro the fair-use meters and no weekly ones', () => {
    const meters = metersFor(PLANS.pro, snapshot([], { sttSeconds: 30 * 3600 }))
    expect(meters.map((m) => m.limit)).toEqual([
      'fairUseSttSecondsPerMonth',
      'sttSecondsPerMonth',
      'llmTokensPerMonth'
    ])
    expect(meters[0]).toEqual({
      limit: 'fairUseSttSecondsPerMonth',
      used: 108_000,
      allowed: 108_000,
      exceeded: true,
      resetsAt: OCTOBER
    })
    expect(meters[1]).toMatchObject({ allowed: 216_000, exceeded: false })
  })
})

describe('request checks', () => {
  it('refuses clips longer than the tier allows, with the tier’s cap', () => {
    expect(checkTranscription(free, 61)).toMatchObject({
      status: 413,
      code: 'clip_too_long',
      limit: 'maxClipSeconds',
      used: 61,
      allowed: 60,
      resetsAt: null,
      message:
        'Clips longer than 1 minute cannot be sent on the free plan; Pro takes clips up to 10 minutes.'
    })
    expect(checkTranscription(free, 60)).toBeNull()
    expect(checkTranscription(pro, 61)).toBeNull()
    expect(checkTranscription(pro, 601)).toMatchObject({
      status: 413,
      allowed: 600,
      message: /10 minutes cannot be sent to Murmur/
    })
  })

  it('stops the free tier at its word, audio, daily and monthly caps in that order', () => {
    const words = checkTranscription(
      { ...free, snapshot: snapshot([bucket('2026-09-08', { words: 500 })]) },
      10
    )
    expect(words).toMatchObject({
      status: 429,
      code: 'quota_exceeded',
      limit: 'wordsPerWeek',
      used: 500,
      allowed: 500,
      resetsAt: Date.UTC(2026, 8, 15),
      retryAfterSec: (Date.UTC(2026, 8, 15) - NOW) / 1000,
      message:
        "You've dictated the 500 words a week the free plan includes; more open up on Tue, Sep 15, or go unlimited with Pro."
    })
    // 499 words: still allowed, however long the clip within the other caps.
    expect(
      checkTranscription({ ...free, snapshot: snapshot([bucket(TODAY, { words: 499 })]) }, 30)
    ).toBeNull()

    const audio = checkTranscription(
      { ...free, snapshot: snapshot([bucket(TODAY, { sttSeconds: 400 })]) },
      30
    )
    expect(audio).toMatchObject({
      limit: 'sttSecondsPerWeek',
      used: 400,
      allowed: 420,
      resetsAt: Date.UTC(2026, 8, 20)
    })
    expect(audio?.message).toBe(
      'The free plan transcribes 7 minutes of audio a week; that is used up until Sun, Sep 20. Pro has no weekly limit.'
    )
    expect(
      checkTranscription({ ...free, snapshot: snapshot([bucket(TODAY, { sttSeconds: 400 })]) }, 20)
    ).toBeNull()

    const day = checkTranscription(
      { ...free, snapshot: snapshot([bucket(TODAY, { dictations: 12 })]) },
      5
    )
    expect(day).toMatchObject({
      limit: 'dictationsPerDay',
      used: 12,
      allowed: 12,
      resetsAt: TOMORROW,
      retryAfterSec: 43_200
    })
    // Yesterday's dictations do not count today.
    expect(
      checkTranscription(
        { ...free, snapshot: snapshot([bucket('2026-09-12', { dictations: 12 })]) },
        5
      )
    ).toBeNull()

    const month = checkTranscription(
      { ...free, snapshot: snapshot([], { sttSeconds: 7200 - 10 }) },
      20
    )
    expect(month).toMatchObject({ limit: 'sttSecondsPerMonth', allowed: 7200, resetsAt: OCTOBER })
    expect(month?.message).toMatch(
      /120 minutes of Murmur transcription on the free plan are used up; more on Thu, Oct 1/
    )
  })

  it('applies Pro’s fair use: soft pauses formatting, hard stops transcription', () => {
    const soft = { ...pro, snapshot: snapshot([], { sttSeconds: 30 * 3600 }) }
    expect(checkTranscription(soft, 60)).toBeNull()
    expect(checkFormatting(soft, true)).toEqual({
      ok: true,
      paused: {
        limit: 'fairUseSttSecondsPerMonth',
        used: 108_000,
        allowed: 108_000,
        exceeded: true,
        resetsAt: OCTOBER
      }
    })
    expect(checkFormatting(soft, false)).toMatchObject({
      ok: false,
      refusal: {
        code: 'quota_exceeded',
        limit: 'fairUseSttSecondsPerMonth',
        message:
          "Murmur's formatting model is paused until Thu, Oct 1: this month's 30 hours of fair use are used. Dictation continues with rule-based cleanup."
      }
    })
    const hard = { ...pro, snapshot: snapshot([], { sttSeconds: 60 * 3600 }) }
    expect(checkTranscription(hard, 1)).toMatchObject({
      limit: 'sttSecondsPerMonth',
      allowed: 216_000,
      message:
        "This month's 60 hours of Murmur transcription, the Pro plan's fair-use limit, are used up; more on Thu, Oct 1."
    })
    expect(checkFormatting(pro, false)).toEqual({ ok: true, paused: null })
  })

  it('caps formatting requests a day on the free tier and tokens a month everywhere', () => {
    const formats = checkFormatting(
      { ...free, snapshot: snapshot([bucket(TODAY, { formats: 12 })]) },
      true
    )
    expect(formats).toMatchObject({ ok: false, refusal: { limit: 'dictationsPerDay', used: 12 } })
    // Transcriptions alone do not exhaust the formatting side of the daily cap.
    expect(
      checkFormatting({ ...free, snapshot: snapshot([bucket(TODAY, { dictations: 12 })]) }, true)
    ).toEqual({ ok: true, paused: null })
    const tokens = checkFormatting(
      { ...pro, snapshot: snapshot([], { llmTokens: 25_000_000 }) },
      true
    )
    expect(tokens).toMatchObject({
      ok: false,
      refusal: { limit: 'llmTokensPerMonth', allowed: 25_000_000, resetsAt: OCTOBER }
    })
  })

  it('rate-limits with a Retry-After', () => {
    expect(checkRate(20, NOW - 30_000, 19, NOW)).toBeNull()
    expect(checkRate(20, NOW - 30_000, 20, NOW)).toEqual({
      status: 429,
      code: 'rate_limited',
      message: 'Too many requests; try again in 30s',
      limit: 'requestsPerMinute',
      used: 20,
      allowed: 20,
      resetsAt: NOW + 30_000,
      retryAfterSec: 30
    })
  })

  it('counts transcript words and builds the upgrade link', () => {
    expect(
      transcriptWords(
        JSON.stringify({ text: "ask not what your country can do for you, it's 2026" }),
        'application/json'
      )
    ).toBe(11)
    expect(transcriptWords('hello there  general', 'text/plain')).toBe(3)
    expect(transcriptWords('not json', 'application/json')).toBe(0)
    expect(transcriptWords('', 'text/plain')).toBe(0)
    expect(upgradeUrlFor({ MURMUR_SITE_URL: 'https://murmur.app/' }, 'free')).toBe(
      'https://murmur.app/account?upgrade=yearly'
    )
    expect(upgradeUrlFor({ MURMUR_SITE_URL: 'https://murmur.app' }, 'trial')).toBe(
      'https://murmur.app/account?upgrade=yearly'
    )
    expect(upgradeUrlFor({ MURMUR_SITE_URL: 'https://murmur.app' }, 'pro')).toBeNull()
    expect(upgradeUrlFor({}, 'free')).toBeNull()
    expect(upgradeUrlFor({ MURMUR_SITE_URL: 'murmur.app' }, 'free')).toBeNull()
  })
})

describe('gateway: free tier', () => {
  it('counts words from the transcript and stops at 500 a week with a structured error', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'one two three four five', duration: 5 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const userId = await freeAccount(t)
    await seedDay(t, userId, '2026-09-09', { words: 400 })
    await seedDay(t, userId, TODAY, { words: 95 })

    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))).status
    ).toBe(200)
    let status = await asAda.query(api.inference.status, { day: TODAY })
    expect(status.window).toEqual({
      day: TODAY,
      weekStart: '2026-09-07',
      words: 500,
      sttSeconds: 5,
      dictationsToday: 1
    })
    expect(status.meters[0]).toMatchObject({
      limit: 'wordsPerWeek',
      used: 500,
      exceeded: true,
      resetsAt: Date.UTC(2026, 8, 16)
    })

    const blocked = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe(String((Date.UTC(2026, 8, 16) - NOW) / 1000))
    expect(await blocked.json()).toEqual({
      error: {
        type: 'murmur_gateway_error',
        code: 'quota_exceeded',
        message:
          "You've dictated the 500 words a week the free plan includes; more open up on Wed, Sep 16, or go unlimited with Pro.",
        limit: 'wordsPerWeek',
        plan: 'free',
        planState: 'free',
        used: 500,
        allowed: 500,
        resetsAt: Date.UTC(2026, 8, 16),
        upgradeUrl: `${SITE}/account?upgrade=yearly`
      }
    })
    expect(calls).toHaveLength(1)
    // Formatting is not counted in words, so it still works while the word cap is reached.
    stubFetch(() => chatAnswer('Hello.'))
    expect((await asAda.fetch('/v1/chat/completions', chatRequest())).status).toBe(200)

    // The window rolls at midnight UTC: the 400 words of 9 September leave on the 16th.
    vi.setSystemTime(Date.UTC(2026, 8, 16, 0, 0, 1))
    stubFetch(() => jsonResponse({ text: 'again', duration: 5 }))
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))).status
    ).toBe(200)
    status = await asAda.query(api.inference.status, { day: '2026-09-16' })
    expect(status.window?.words).toBe(101)
  })

  it('caps audio a week, dictations a day and the clip length', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'ok', duration: 30 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const userId = await freeAccount(t)

    await seedDay(t, userId, '2026-09-12', { sttSeconds: 400 })
    const audio = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(30)))
    expect(audio.status).toBe(429)
    expect((await audio.json()).error).toMatchObject({
      limit: 'sttSecondsPerWeek',
      used: 400,
      allowed: 420,
      resetsAt: Date.UTC(2026, 8, 19)
    })
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(15)))).status
    ).toBe(200)

    const long = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(61)))
    expect(long.status).toBe(413)
    expect((await long.json()).error).toMatchObject({
      code: 'clip_too_long',
      limit: 'maxClipSeconds',
      allowed: 60,
      resetsAt: null
    })

    await seedDay(t, userId, TODAY, { dictations: 12 })
    const day = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(day.status).toBe(429)
    expect((await day.json()).error).toMatchObject({
      limit: 'dictationsPerDay',
      used: 12,
      allowed: 12,
      resetsAt: TOMORROW
    })
    expect(day.headers.get('retry-after')).toBe('43200')
    // Formatting has its own side of the daily cap.
    stubFetch(() => chatAnswer('Hello.'))
    expect((await asAda.fetch('/v1/format', formatRequest('hello there everyone'))).status).toBe(
      200
    )
    await seedDay(t, userId, TODAY, { formats: 12 })
    const formats = await asAda.fetch('/v1/format', formatRequest('hello there everyone'))
    expect(formats.status).toBe(429)
    expect((await formats.json()).error.limit).toBe('dictationsPerDay')
    expect((await asAda.fetch('/v1/chat/completions', chatRequest())).status).toBe(429)

    // Tomorrow the daily counters are fresh.
    vi.setSystemTime(TOMORROW + 60_000)
    stubFetch(() => jsonResponse({ text: 'ok', duration: 1 }))
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status
    ).toBe(200)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('keeps the monthly backstops and the free request rate', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'ok', duration: 1 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const userId = await freeAccount(t)
    await seedMonth(t, userId, { sttSeconds: PLANS.free.sttSecondsPerMonth })
    const month = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(month.status).toBe(429)
    expect((await month.json()).error).toMatchObject({
      limit: 'sttSecondsPerMonth',
      allowed: 7200,
      resetsAt: OCTOBER
    })
    await seedMonth(t, userId, { sttSeconds: 0, llmTokens: PLANS.free.llmTokensPerMonth })
    const tokens = await asAda.fetch('/v1/format', formatRequest('hello there everyone'))
    expect(tokens.status).toBe(429)
    expect((await tokens.json()).error).toMatchObject({
      limit: 'llmTokensPerMonth',
      allowed: 500_000
    })
    await seedMonth(t, userId, {
      llmTokens: 0,
      windowStart: NOW - 1000,
      windowCount: PLANS.free.requestsPerMinute
    })
    const rate = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(rate.status).toBe(429)
    expect((await rate.json()).error).toMatchObject({
      code: 'rate_limited',
      limit: 'requestsPerMinute',
      used: 20,
      allowed: 20,
      resetsAt: NOW + 59_000
    })
    expect(rate.headers.get('retry-after')).toBe('59')
    expect(calls).toHaveLength(0)
  })
})

describe('gateway: Pro fair use', () => {
  it('pauses the formatting model past 30 audio-hours and throttles, but keeps transcribing', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'still here', duration: 61 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const user = await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'pro' })
    await seedMonth(t, user.id, { sttSeconds: PLANS.pro.fairUseSttSecondsPerMonth! })

    // Longer clips than the free tier takes are still fine, and transcription continues.
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(61)))).status
    ).toBe(200)
    expect(calls).toHaveLength(1)

    const chat = await asAda.fetch('/v1/chat/completions', chatRequest())
    expect(chat.status).toBe(429)
    expect((await chat.json()).error).toMatchObject({
      code: 'quota_exceeded',
      limit: 'fairUseSttSecondsPerMonth',
      plan: 'pro',
      planState: 'pro',
      allowed: 108_000,
      resetsAt: OCTOBER,
      upgradeUrl: null
    })

    const format = await asAda.fetch(
      '/v1/format',
      formatRequest('um so the budget is one million dollars')
    )
    expect(format.status).toBe(200)
    const out = await format.json()
    expect(out.status).toMatchObject({ outcome: 'skipped', detail: 'fair use' })
    expect(out.text).toBe('So the budget is one million dollars')
    expect(out.limit).toEqual({
      limit: 'fairUseSttSecondsPerMonth',
      plan: 'pro',
      planState: 'pro',
      used: 108_061,
      allowed: 108_000,
      resetsAt: OCTOBER,
      upgradeUrl: null
    })
    // No model call, nothing billed for formatting.
    expect(calls).toHaveLength(1)
    const status = await asAda.query(api.inference.status, { day: TODAY })
    expect(status.formattingPaused).toBe(true)
    expect(status.usage.llmRequests).toBe(0)
    expect(status.meters[0]).toMatchObject({ limit: 'fairUseSttSecondsPerMonth', exceeded: true })

    // The request rate drops to the free tier's 20 a minute.
    await seedMonth(t, user.id, { windowStart: NOW, windowCount: 20 })
    const throttled = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(throttled.status).toBe(429)
    expect((await throttled.json()).error).toMatchObject({
      limit: 'requestsPerMinute',
      allowed: 20
    })
    // Under the soft cap the same burst is well within Pro's 60.
    await seedMonth(t, user.id, { sttSeconds: 1000 })
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status
    ).toBe(200)
    expect((await asAda.query(api.inference.status, { day: TODAY })).formattingPaused).toBe(false)
  })

  it('stops transcription at the 60-hour hard cap', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'nope', duration: 1 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const user = await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'pro' })
    await seedMonth(t, user.id, { sttSeconds: PLANS.pro.sttSecondsPerMonth })
    const hard = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(hard.status).toBe(429)
    expect((await hard.json()).error).toMatchObject({
      limit: 'sttSecondsPerMonth',
      allowed: 216_000,
      resetsAt: OCTOBER,
      message: /60 hours of Murmur transcription, the Pro plan's fair-use limit/
    })
    expect(calls).toHaveLength(0)
    // Next month it is back.
    vi.setSystemTime(OCTOBER + 1000)
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status
    ).toBe(200)
  })

  it('applies the trial exactly like Pro', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'trialing', duration: 120 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(120)))).status
    ).toBe(200)
    const status = await asAda.query(api.inference.status, { day: TODAY })
    expect(status).toMatchObject({
      plan: 'pro',
      planState: 'trial',
      upgradeUrl: `${SITE}/account?upgrade=yearly`
    })
    expect(status.meters.map((m) => m.limit)).toEqual([
      'fairUseSttSecondsPerMonth',
      'sttSecondsPerMonth',
      'llmTokensPerMonth'
    ])
    expect(calls).toHaveLength(1)
  })
})

describe('trial lifecycle', () => {
  it('starts every new account on a 14-day trial that a scheduled function ends', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const created = await asAda.mutation(api.users.ensure, {})
    expect(created).toMatchObject({ plan: 'pro', planState: 'trial', trialEndsAt: NOW + TRIAL_MS })
    expect(await asAda.query(api.users.me, {})).toMatchObject({
      planState: 'trial',
      trialEndsAt: NOW + TRIAL_MS
    })

    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(Date.now()).toBeGreaterThanOrEqual(NOW + TRIAL_MS)
    expect(await asAda.query(api.users.me, {})).toMatchObject({
      plan: 'free',
      planState: 'free',
      trialEndsAt: NOW + TRIAL_MS
    })
    const status = await asAda.query(api.inference.status, {})
    expect(status).toMatchObject({
      plan: 'free',
      planState: 'free',
      limits: { maxClipSeconds: 60 }
    })
  })

  it('settles a stale trial on the next contact even if the scheduled job never ran', async () => {
    stubFetch(() => jsonResponse({ text: 'late', duration: 1 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    const asBob = t.withIdentity({ subject: 'user_bob' })
    await asBob.mutation(api.users.ensure, {})

    vi.setSystemTime(NOW + TRIAL_MS + 1)
    // Ada comes back through the app (users.ensure)…
    expect(await asAda.mutation(api.users.ensure, {})).toMatchObject({ planState: 'free' })
    // …Bob straight through the gateway, which now applies the free tier's clip cap.
    const long = await asBob.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(61)))
    expect(long.status).toBe(413)
    expect((await long.json()).error).toMatchObject({
      plan: 'free',
      planState: 'free',
      allowed: 60
    })
    expect(await asBob.query(api.users.me, {})).toMatchObject({ planState: 'free' })
  })

  it('lets the operator restart a trial or set a state by hand', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    vi.setSystemTime(NOW + TRIAL_MS + DAY_MS)
    expect(await asAda.mutation(api.users.ensure, {})).toMatchObject({ planState: 'free' })
    const again = await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'trial' })
    expect(again).toMatchObject({
      plan: 'pro',
      planState: 'trial',
      trialEndsAt: NOW + 2 * TRIAL_MS + DAY_MS
    })
    expect(
      await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'pro' })
    ).toMatchObject({ planState: 'pro' })
    expect(
      await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    ).toMatchObject({ planState: 'free', plan: 'free' })
  })

  it('backfills existing accounts with 14 days from deploy time, page by page', async () => {
    const t = setup()
    // 105 accounts from before the trial existed, one of them a comped Pro, plus one that already has a trial.
    const ids = await t.run(async (ctx) => {
      const out: Id<'users'>[] = []
      for (let i = 0; i < 105; i++) {
        out.push(
          await ctx.db.insert('users', {
            clerkId: `legacy_${i}`,
            plan: i === 3 ? 'pro' : undefined,
            createdAt: NOW - 30 * DAY_MS,
            updatedAt: NOW - 30 * DAY_MS
          })
        )
      }
      return out
    })
    await t.withIdentity(ada).mutation(api.users.ensure, {})
    const legacy = t.withIdentity({ subject: 'legacy_0' })
    // Before the backfill a legacy row reads as free…
    const before = await legacy.query(api.users.me, {})
    expect(before).toMatchObject({ planState: 'free' })
    expect(before?.trialEndsAt).toBeUndefined()

    vi.setSystemTime(NOW + 3600_000)
    const first = await t.mutation(internal.entitlements.backfillTrials, {})
    expect(first).toEqual({ granted: 100, isDone: false })
    // The next page is scheduled right away; fire only that timer, not the trial expiries.
    vi.advanceTimersByTime(1)
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const users = await ctx.db.query('users').collect()
      const granted = users.filter((u) => u.clerkId.startsWith('legacy_'))
      expect(granted).toHaveLength(105)
      for (const u of granted) {
        expect(u.trialEndsAt).toBe(NOW + 3600_000 + TRIAL_MS)
        expect(u.plan).toBe(u.clerkId === 'legacy_3' ? 'pro' : 'trial')
      }
      const adaRow = users.find((u) => u.clerkId === 'user_ada')!
      expect(adaRow.trialEndsAt).toBe(NOW + TRIAL_MS)
      expect(ids).toHaveLength(105)
    })
    // Running it again grants nothing.
    expect(await t.mutation(internal.entitlements.backfillTrials, {})).toEqual({
      granted: 0,
      isDone: false
    })
    vi.advanceTimersByTime(1)
    await t.finishInProgressScheduledFunctions()
    // …and the backfilled trials end on schedule like any other.
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await legacy.query(api.users.me, {})).toMatchObject({ planState: 'free' })
    expect(await t.withIdentity({ subject: 'legacy_3' }).query(api.users.me, {})).toMatchObject({
      planState: 'pro'
    })
  })
})

describe('inference.status windows', () => {
  it('returns the rolling week, the day and every reset for the day the client passes', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const userId = await freeAccount(t)
    await seedDay(t, userId, '2026-09-06', { words: 999, sttSeconds: 999, dictations: 9 })
    await seedDay(t, userId, '2026-09-07', { words: 100, sttSeconds: 60, dictations: 2 })
    await seedDay(t, userId, '2026-09-12', { words: 50, sttSeconds: 20, dictations: 1, formats: 1 })
    await seedDay(t, userId, TODAY, { words: 10, sttSeconds: 4, dictations: 1, formats: 3 })
    await seedMonth(t, userId, { sttSeconds: 84, llmTokens: 5000 })

    const status = await asAda.query(api.inference.status, { day: TODAY })
    expect(status.window).toEqual({
      day: TODAY,
      weekStart: '2026-09-07',
      words: 160,
      sttSeconds: 84,
      dictationsToday: 3
    })
    expect(status.meters).toEqual([
      { limit: 'wordsPerWeek', used: 160, allowed: 500, exceeded: false, resetsAt: TOMORROW },
      { limit: 'sttSecondsPerWeek', used: 84, allowed: 420, exceeded: false, resetsAt: TOMORROW },
      { limit: 'dictationsPerDay', used: 3, allowed: 12, exceeded: false, resetsAt: TOMORROW },
      { limit: 'sttSecondsPerMonth', used: 84, allowed: 7200, exceeded: false, resetsAt: OCTOBER },
      {
        limit: 'llmTokensPerMonth',
        used: 5000,
        allowed: 500_000,
        exceeded: false,
        resetsAt: OCTOBER
      }
    ])
    expect(status.resets).toEqual({ day: TOMORROW, week: TOMORROW, month: OCTOBER })
    expect(status.upgradeUrl).toBe(`${SITE}/account?upgrade=yearly`)

    // A later day sees the old days fall out of the window.
    const later = await asAda.query(api.inference.status, { day: '2026-09-15' })
    expect(later.window).toMatchObject({ weekStart: '2026-09-09', words: 60, dictationsToday: 0 })
    expect(later.resets).toEqual({
      day: Date.UTC(2026, 8, 16),
      week: Date.UTC(2026, 8, 19),
      month: OCTOBER
    })

    // Without a day only the month-level fields are filled; a malformed day is a client bug.
    const bare = await asAda.query(api.inference.status, {})
    expect(bare).toMatchObject({ window: null, meters: [], resets: null })
    await expect(asAda.query(api.inference.status, { day: 'today' })).rejects.toThrow(/YYYY-MM-DD/)
  })

  it('deletes the daily buckets with the rest of the account', async () => {
    stubFetch(() => jsonResponse({ text: 'a few words here', duration: 1 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    expect(
      (await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status
    ).toBe(200)
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('inferenceDays').collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ day: TODAY, words: 4, dictations: 1, formats: 0 })
      expect(rows[0].sttSeconds).toBeCloseTo(1, 3)
    })
    await asAda.mutation(api.users.deleteMyData, {})
    await t.run(async (ctx) => {
      expect(await ctx.db.query('inferenceDays').collect()).toHaveLength(0)
    })
  })
})
