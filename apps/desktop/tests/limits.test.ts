import { describe, expect, it } from 'vitest'
import { errorFromResponse, parseErrorBody } from '@core/stt'
import { currentUtcDay, msUntilNextUtcDay, type UsageMeter } from '@shared/cloud'
import {
  describeLimit,
  formatAudioSeconds,
  formatResetTime,
  isPlanLimit,
  meterLabel,
  meterValue,
  parseLimitNotice,
  planStateLabel,
  planStateOf,
  trialDaysLeft,
  usageMeters,
  type LimitNotice
} from '@shared/limits'

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0) // Sun 13 Sep 2026, noon UTC
const UPGRADE = 'https://murmur.app/account?upgrade=yearly'

/** A gateway refusal, as the contract spells it (internal/entitlements-contract.md). */
function refusal(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    error: {
      type: 'murmur_gateway_error',
      code: 'quota_exceeded',
      message: "This week's 500 free words are used up.",
      limit: 'wordsPerWeek',
      plan: 'free',
      planState: 'free',
      used: 503,
      allowed: 500,
      resetsAt: NOW + 2 * 86_400_000,
      upgradeUrl: UPGRADE,
      ...overrides
    }
  })
}

describe('limit notices from the gateway', () => {
  it('are read off a refusal body and travel on the SttError', () => {
    const parsed = parseErrorBody(refusal())
    expect(parsed.code).toBe('quota_exceeded')
    expect(parsed.message).toBe("This week's 500 free words are used up.")
    expect(parsed.limit).toEqual<LimitNotice>({
      limit: 'wordsPerWeek',
      plan: 'free',
      planState: 'free',
      used: 503,
      allowed: 500,
      resetsAt: NOW + 2 * 86_400_000,
      upgradeUrl: UPGRADE,
      message: "This week's 500 free words are used up."
    })
    const err = errorFromResponse(429, refusal())
    expect(err.kind).toBe('rate-limit')
    expect(err.code).toBe('quota_exceeded')
    expect(err.limit?.limit).toBe('wordsPerWeek')
    expect(err.limit?.message).toBe(err.message)
    // A clip refusal is a 413 with no reset and no upgrade for a Pro account.
    const clip = errorFromResponse(
      413,
      refusal({
        code: 'clip_too_long',
        limit: 'maxClipSeconds',
        plan: 'pro',
        planState: 'pro',
        used: 640,
        allowed: 600,
        resetsAt: null,
        upgradeUrl: null
      })
    )
    expect(clip.limit).toMatchObject({ limit: 'maxClipSeconds', resetsAt: null, upgradeUrl: null })
  })

  it('leave ordinary errors alone', () => {
    expect(
      parseErrorBody('{"error":{"message":"boom","code":"upstream_error"}}').limit
    ).toBeUndefined()
    expect(parseErrorBody('not json').limit).toBeUndefined()
    expect(parseLimitNotice({ limit: 'somethingElse', used: 1 })).toBeNull()
    expect(parseLimitNotice(null)).toBeNull()
    expect(parseLimitNotice('wordsPerWeek')).toBeNull()
    // Missing details default sensibly; the tier falls back to the plan.
    expect(parseLimitNotice({ limit: 'dictationsPerDay', plan: 'pro' })).toEqual({
      limit: 'dictationsPerDay',
      plan: 'pro',
      planState: 'pro',
      used: 0,
      allowed: 0,
      resetsAt: null,
      upgradeUrl: null,
      message: ''
    })
  })

  it('tell a plan limit from a plain rate limit', () => {
    expect(isPlanLimit('wordsPerWeek')).toBe(true)
    expect(isPlanLimit('fairUseSttSecondsPerMonth')).toBe(true)
    expect(isPlanLimit('requestsPerMinute')).toBe(false)
  })
})

describe('limit wording', () => {
  const free = parseLimitNotice(JSON.parse(refusal()).error)!

  it('names the limit, the allowance and the reset', () => {
    const copy = describeLimit(free, NOW)
    expect(copy.title).toBe("This week's free words are used up")
    expect(copy.detail).toBe('500 words a week on the free plan · resets Tue 15 Sep')
    expect(copy.upgradeHelps).toBe(true)

    const day = describeLimit(
      { ...free, limit: 'dictationsPerDay', used: 12, allowed: 12, resetsAt: NOW + 5 * 3_600_000 },
      NOW
    )
    expect(day.title).toBe("Today's free dictations are used up")
    expect(day.detail.startsWith('12 dictations a day on the free plan · resets ')).toBe(true)
    // The same limit met at the formatting stage never loses text; the wording says so.
    expect(describeLimit({ ...free, limit: 'dictationsPerDay' }, NOW, 'formatting').title).toBe(
      "Inserted without formatting: today's free dictations are used up"
    )

    const minutes = describeLimit({ ...free, limit: 'sttSecondsPerWeek', allowed: 420 }, NOW)
    expect(minutes.title).toBe("This week's free minutes are used up")
    expect(minutes.detail).toBe('7 min of speech a week on the free plan · resets Tue 15 Sep')

    const clip = describeLimit(
      { ...free, limit: 'maxClipSeconds', used: 75, allowed: 60, resetsAt: null },
      NOW
    )
    expect(clip.title).toBe('That recording is too long for the free plan')
    expect(clip.detail).toBe('Clips up to 1 min on the free plan; up to 10 min on Pro')
    expect(clip.upgradeHelps).toBe(true)
  })

  it('does not sell Pro to Pro', () => {
    const pro: LimitNotice = {
      ...free,
      plan: 'pro',
      planState: 'pro',
      upgradeUrl: null,
      limit: 'sttSecondsPerMonth',
      used: 216_000,
      allowed: 216_000,
      resetsAt: Date.UTC(2026, 9, 1)
    }
    const cap = describeLimit(pro, NOW)
    expect(cap.title).toBe("This month's transcription has reached its fair-use cap")
    expect(cap.detail).toBe('60 h a month on Pro · resets on 1 Oct')
    expect(cap.upgradeHelps).toBe(false)

    const soft = describeLimit(
      { ...pro, limit: 'fairUseSttSecondsPerMonth', used: 108_500, allowed: 108_000 },
      NOW,
      'formatting'
    )
    expect(soft.title).toBe('Inserted without formatting: fair use reached for this month')
    expect(soft.detail).toBe(
      'Past 30 h of transcription a month the text is tidied by rules only · resets on 1 Oct'
    )
    expect(soft.upgradeHelps).toBe(false)

    const trialClip = describeLimit(
      {
        ...pro,
        planState: 'trial',
        limit: 'maxClipSeconds',
        used: 700,
        allowed: 600,
        resetsAt: null
      },
      NOW
    )
    expect(trialClip.title).toBe('That recording is too long')
    expect(trialClip.detail).toBe('Clips can be up to 10 min')
  })

  it('says when a limit comes back the way a person would', () => {
    expect(formatResetTime(NOW + 20_000, NOW)).toBe('in a moment')
    expect(formatResetTime(NOW + 41 * 60_000, NOW)).toBe('in 41 min')
    const later = NOW + 3 * 3_600_000
    const sameDay = new Date(later).getDate() === new Date(NOW).getDate()
    expect(formatResetTime(later, NOW)).toMatch(
      sameDay ? /^at \d{1,2}:\d{2} [ap]m$/ : /^tomorrow at /
    )
    expect(formatResetTime(NOW + 26 * 3_600_000, NOW)).toMatch(/^tomorrow at \d{1,2}:\d{2} [ap]m$/)
    expect(formatResetTime(NOW + 3 * 86_400_000, NOW)).toBe('Wed 16 Sep')
    expect(formatResetTime(NOW + 12 * 86_400_000, NOW)).toBe('on 25 Sep')
  })

  it('formats audio in the unit the allowance is read in', () => {
    expect(formatAudioSeconds(420)).toBe('7 min')
    expect(formatAudioSeconds(7_200)).toBe('120 min')
    expect(formatAudioSeconds(30)).toBe('<1 min')
    expect(formatAudioSeconds(0)).toBe('0 min')
    expect(formatAudioSeconds(108_000)).toBe('30 h')
    expect(formatAudioSeconds(9_000, 108_000)).toBe('2.5 h')
    expect(formatAudioSeconds(45_000, 216_000)).toBe('13 h')
  })

  it('describes the Account page meters', () => {
    const meters: UsageMeter[] = [
      { limit: 'wordsPerWeek', used: 312, allowed: 500, exceeded: false, resetsAt: NOW },
      { limit: 'sttSecondsPerWeek', used: 95, allowed: 420, exceeded: false, resetsAt: NOW },
      { limit: 'dictationsPerDay', used: 3, allowed: 12, exceeded: false, resetsAt: NOW },
      { limit: 'maxClipSeconds', used: 0, allowed: 60, exceeded: false, resetsAt: NOW },
      { limit: 'requestsPerMinute', used: 1, allowed: 20, exceeded: false, resetsAt: NOW },
      { limit: 'llmTokensPerMonth', used: 12_400, allowed: 500_000, exceeded: false, resetsAt: NOW }
    ]
    expect(meterValue(meters[0])).toBe('312 of 500 words')
    expect(meterValue(meters[1])).toBe('2 of 7 min')
    expect(meterValue(meters[2])).toBe('3 of 12')
    expect(meterValue(meters[3])).toBe('up to 1 min a clip')
    expect(meterValue(meters[5])).toBe('12k of 500k tokens')
    expect(meterValue({ limit: 'llmTokensPerMonth', used: 2_100_000, allowed: 25_000_000 })).toBe(
      '2.1M of 25M tokens'
    )
    expect(meterValue({ limit: 'llmTokensPerMonth', used: 980, allowed: 500_000 })).toBe(
      '980 of 500k tokens'
    )
    expect(meterLabel('wordsPerWeek')).toBe('Words this week')
    expect(meterLabel('fairUseSttSecondsPerMonth')).toBe('Fair use this month')
    // Per-request limits are not usage; they get no row.
    expect(usageMeters(meters).map((m) => m.limit)).toEqual([
      'wordsPerWeek',
      'sttSecondsPerWeek',
      'dictationsPerDay',
      'llmTokensPerMonth'
    ])
    expect(usageMeters(undefined)).toEqual([])
  })
})

describe('plan state', () => {
  it('comes from the instance when it reports one, otherwise from the tier', () => {
    expect(planStateOf({ plan: 'pro', planState: 'trial' })).toBe('trial')
    expect(planStateOf({ plan: 'pro' })).toBe('pro')
    expect(planStateOf({ plan: 'free' })).toBe('free')
    expect(planStateOf(null, { plan: 'pro', planState: 'trial' })).toBe('trial')
    expect(planStateOf(null, { plan: 'free' })).toBe('free')
    expect(planStateOf(null, null)).toBe('free')
    expect(planStateLabel('trial')).toBe('Pro trial')
    expect(planStateLabel('pro')).toBe('Pro')
    expect(planStateLabel('free')).toBe('Free')
  })

  it('counts trial days the way the contract does', () => {
    expect(trialDaysLeft(NOW + 14 * 86_400_000, NOW)).toBe(14)
    expect(trialDaysLeft(NOW + 1, NOW)).toBe(1)
    expect(trialDaysLeft(NOW - 5, NOW)).toBe(0)
    expect(trialDaysLeft(null, NOW)).toBe(0)
    expect(trialDaysLeft(undefined, NOW)).toBe(0)
  })

  it('knows the UTC day the status is asked for and when it turns', () => {
    expect(currentUtcDay(NOW)).toBe('2026-09-13')
    expect(msUntilNextUtcDay(NOW)).toBe(12 * 3_600_000)
    expect(currentUtcDay(NOW + msUntilNextUtcDay(NOW))).toBe('2026-09-14')
    expect(msUntilNextUtcDay(Date.UTC(2026, 8, 13, 23, 59, 59, 999))).toBe(1)
  })
})
