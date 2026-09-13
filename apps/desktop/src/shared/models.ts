/**
 * Model ids the hosted providers have retired, with the replacement each provider recommends.
 * The presets stop offering them and `migrateSettings` moves an install that still names one onto
 * the replacement, so nobody's dictation starts failing the day a provider pulls a model.
 *
 * Only exact provider hosts are matched: the same id on a proxy or another server may still work
 * there, and a local server is nobody's business but the user's.
 */
export interface RetiredModel {
  /** Host of the provider's API, compared case-insensitively with the base URL's host. */
  host: string
  model: string
  replacement: string
  /** Shutdown date (YYYY-MM-DD) from the provider's deprecation page. */
  retiredOn: string
}

export const GROQ_HOST = 'api.groq.com'
export const OPENAI_HOST = 'api.openai.com'

export const RETIRED_MODELS: readonly RetiredModel[] = [
  // https://console.groq.com/docs/deprecations
  {
    host: GROQ_HOST,
    model: 'llama-3.1-8b-instant',
    replacement: 'openai/gpt-oss-20b',
    retiredOn: '2026-08-16'
  },
  {
    host: GROQ_HOST,
    model: 'llama-3.3-70b-versatile',
    replacement: 'openai/gpt-oss-120b',
    retiredOn: '2026-08-16'
  },
  {
    host: GROQ_HOST,
    model: 'distil-whisper-large-v3-en',
    replacement: 'whisper-large-v3-turbo',
    retiredOn: '2025-08-23'
  },
  // https://developers.openai.com/api/docs/deprecations
  {
    host: OPENAI_HOST,
    model: 'gpt-4.1-nano',
    replacement: 'gpt-5.6-luna',
    retiredOn: '2026-10-23'
  },
  {
    host: OPENAI_HOST,
    model: 'gpt-4.1-nano-2025-04-14',
    replacement: 'gpt-5.6-luna',
    retiredOn: '2026-10-23'
  }
]

/** Host of an API base URL, lower-cased; empty when the URL does not parse. */
export function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The model to use instead of `model` at `baseUrl`, or null when the model is not known to be
 * retired at that host. A replacement that is itself retired is followed to the end.
 */
export function replacementModel(baseUrl: string, model: string): string | null {
  const host = baseUrlHost(baseUrl)
  if (!host) return null
  let current = model.trim()
  let replaced = false
  for (let hops = 0; hops < RETIRED_MODELS.length; hops++) {
    const hit = RETIRED_MODELS.find((r) => r.host === host && r.model === current)
    if (!hit) break
    current = hit.replacement
    replaced = true
  }
  return replaced ? current : null
}
