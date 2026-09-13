const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** `92.4 MB`: one decimal below 10 units, none above, like a file manager. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

/** `15 Aug 2026`, stable across server and client (fixed locale and UTC). */
export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

/** Seconds of audio as the apps show them: `12 min`, `1 h 20 min`, `45 s`. */
export function formatAudioSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** Calendar month (UTC) as `YYYY-MM`, the key the backend files usage under. */
export function usagePeriod(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** `2026-09` as `September 2026`. */
export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (!match) return period
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = now - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  return formatDate(new Date(ts).toISOString())
}
