import { describe, expect, it } from 'vitest'
import type { InferenceStatus } from './backend-api'
import {
  checkoutOutcome,
  describeReset,
  displayedMeters,
  exhaustedNotice,
  formatLongDate,
  formatUtcDate,
  meterView,
  planLabel,
  trialDaysLeft,
  upgradeIntent,
  usageDayUtc
} from './entitlements'

const NOW = Date.UTC(2026, 8, 13, 12, 0)
const TOMORROW = Date.UTC(2026, 8, 14)
const OCTOBER = Date.UTC(2026, 9, 1)

type Meter = InferenceStatus['meters'][number]
const meter = (limit: Meter['limit'], used: number, allowed: number, resetsAt: number): Meter => ({
  limit,
  used,
  allowed,
  exceeded: used >= allowed,
  resetsAt
})

function status(partial: Partial<InferenceStatus>): InferenceStatus {
  return {
    available: true,
    models: { stt: 'murmur-transcribe', llm: 'murmur-format' },
    plan: 'free',
    planState: 'free',
    trialEndsAt: null,
    limits: {
      sttSecondsPerMonth: 7200,
      llmTokensPerMonth: 500_000,
      requestsPerMinute: 20,
      maxClipSeconds: 60
    },
    usage: { period: '2026-09', sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0 },
    formattingPaused: false,
    upgradeUrl: null,
    window: null,
    meters: [],
    resets: null,
    ...partial
  }
}

describe('plan states and dates', () => {
  it('keys the day in UTC and names the states', () => {
    expect(usageDayUtc(NOW)).toBe('2026-09-13')
    expect(usageDayUtc(Date.UTC(2026, 8, 13, 23, 59))).toBe('2026-09-13')
    expect(planLabel('trial')).toBe('Pro trial')
    expect(planLabel('free')).toBe('Free')
    expect(planLabel('pro')).toBe('Pro')
  })

  it('counts trial days left, never below zero', () => {
    expect(trialDaysLeft(NOW + 14 * 86_400_000, NOW)).toBe(14)
    expect(trialDaysLeft(NOW + 1000, NOW)).toBe(1)
    expect(trialDaysLeft(NOW - 1000, NOW)).toBe(0)
  })

  it('describes resets the way a person would', () => {
    expect(describeReset(TOMORROW, NOW)).toBe('at midnight UTC')
    expect(describeReset(Date.UTC(2026, 8, 16), NOW)).toBe('on Wed 16 Sept')
    expect(describeReset(NOW - 1, NOW)).toBe('now')
    expect(formatUtcDate(OCTOBER)).toBe('Thu 1 Oct')
    expect(formatLongDate(Date.UTC(2026, 9, 13))).toBe('13 October 2026')
  })
})

describe('meters', () => {
  it('shows the free tier its weekly and daily meters, Pro its fair use', () => {
    const free = status({
      meters: [
        meter('wordsPerWeek', 312, 500, Date.UTC(2026, 8, 16)),
        meter('sttSecondsPerWeek', 240, 420, TOMORROW),
        meter('dictationsPerDay', 3, 12, TOMORROW),
        meter('sttSecondsPerMonth', 240, 7200, OCTOBER),
        meter('llmTokensPerMonth', 900, 500_000, OCTOBER)
      ]
    })
    expect(displayedMeters(free).map((m) => m.limit)).toEqual([
      'wordsPerWeek',
      'sttSecondsPerWeek',
      'dictationsPerDay'
    ])
    const views = displayedMeters(free).map(meterView)
    expect(views[0]).toMatchObject({
      label: 'Words, last 7 days',
      display: '312 of 500',
      ratio: 0.624,
      exceeded: false
    })
    expect(views[1]).toMatchObject({ label: 'Audio, last 7 days', display: '4 min of 7 min' })
    expect(views[2]).toMatchObject({ label: 'Dictations today', display: '3 of 12' })

    const pro = status({
      plan: 'pro',
      planState: 'pro',
      meters: [
        meter('fairUseSttSecondsPerMonth', 7200, 108_000, OCTOBER),
        meter('sttSecondsPerMonth', 7200, 216_000, OCTOBER),
        meter('llmTokensPerMonth', 0, 25_000_000, OCTOBER)
      ]
    })
    expect(
      displayedMeters(pro)
        .map(meterView)
        .map((m) => m.display)
    ).toEqual(['2 h of 30 h', '2 h of 60 h'])
    expect(meterView(meter('wordsPerWeek', 600, 500, TOMORROW))).toMatchObject({
      ratio: 1,
      exceeded: true
    })
  })

  it('says which limit ran out and when it frees up', () => {
    expect(exhaustedNotice(status({}), NOW)).toBeNull()
    expect(
      exhaustedNotice(
        status({ meters: [meter('wordsPerWeek', 500, 500, Date.UTC(2026, 8, 16))] }),
        NOW
      )
    ).toBe("This week's 500 words are used; more open up on Wed 16 Sept.")
    expect(
      exhaustedNotice(status({ meters: [meter('sttSecondsPerWeek', 420, 420, TOMORROW)] }), NOW)
    ).toBe("This week's 7 min of audio are used; more at midnight UTC.")
    expect(
      exhaustedNotice(status({ meters: [meter('dictationsPerDay', 12, 12, TOMORROW)] }), NOW)
    ).toBe("Today's 12 dictations are used; more at midnight UTC.")
    expect(
      exhaustedNotice(
        status({
          plan: 'pro',
          planState: 'pro',
          meters: [meter('sttSecondsPerMonth', 216_000, 216_000, OCTOBER)]
        }),
        NOW
      )
    ).toBe("This month's 60 h of fair use are used; transcription resumes on Thu 1 Oct.")
    expect(
      exhaustedNotice(
        status({
          plan: 'pro',
          planState: 'pro',
          formattingPaused: true,
          meters: [meter('fairUseSttSecondsPerMonth', 108_000, 108_000, OCTOBER)]
        }),
        NOW
      )
    ).toBe(
      'Past 30 h of audio this month the formatting model pauses and dictation continues with rule-based cleanup, until Thu 1 Oct.'
    )
  })
})

describe('URL parameters', () => {
  it('reads the upgrade intent and the checkout outcome', () => {
    expect(upgradeIntent(null)).toBeNull()
    expect(upgradeIntent('yearly')).toBe('year')
    expect(upgradeIntent('monthly')).toBe('month')
    expect(upgradeIntent('1')).toBe('year')
    expect(checkoutOutcome('success')).toBe('success')
    expect(checkoutOutcome('cancelled')).toBe('cancelled')
    expect(checkoutOutcome('other')).toBeNull()
    expect(checkoutOutcome(null)).toBeNull()
  })
})
