import { describe, expect, it } from 'vitest'
import {
  formatAudioSeconds,
  formatBytes,
  formatDate,
  formatPeriod,
  formatRelative,
  usagePeriod
} from './format'

describe('formatBytes', () => {
  it('uses decimal units with one decimal under ten', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2435)).toBe('2.4 KB')
    expect(formatBytes(36_465_490)).toBe('36 MB')
    expect(formatBytes(216_745_251)).toBe('217 MB')
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('dates and periods', () => {
  it('formats release dates in UTC', () => {
    expect(formatDate('2026-09-06T20:16:15Z')).toBe('6 Sept 2026')
    expect(formatDate('not a date')).toBe('')
  })
  it('keys usage by UTC month like the backend', () => {
    expect(usagePeriod(Date.UTC(2026, 8, 11, 9, 57))).toBe('2026-09')
    expect(usagePeriod(Date.UTC(2026, 0, 1, 0, 0))).toBe('2026-01')
    expect(formatPeriod('2026-09')).toBe('September 2026')
    expect(formatPeriod('')).toBe('')
  })
  it('describes recent timestamps relatively', () => {
    const now = Date.UTC(2026, 8, 11, 12, 0)
    expect(formatRelative(now - 30_000, now)).toBe('just now')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 d ago')
  })
})

describe('formatAudioSeconds', () => {
  it('rounds to the unit the apps use', () => {
    expect(formatAudioSeconds(45)).toBe('45 s')
    expect(formatAudioSeconds(720)).toBe('12 min')
    expect(formatAudioSeconds(4800)).toBe('1 h 20 min')
    expect(formatAudioSeconds(7200)).toBe('2 h')
  })
})
