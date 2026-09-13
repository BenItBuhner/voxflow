import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorFromResponse, type TranscribeOutput } from '@core/stt'
import { formatTranscript, type FormatInput } from '@engine'
import { defaultSettings, type Settings } from '@shared/settings'
import type { OverlayState } from '@shared/types'
import type { FormatOutcome } from '../src/main/inference/router'

// The session talks to the desktop through the injector and to the world through the speech
// provider and the formatter; all three are replaced, everything else is the real code.
const inject = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; method: string }>,
  injectText: vi.fn(async (text: string, opts: { method: string }) => {
    inject.calls.push({ text, method: opts.method })
    return { ok: true, method: 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

const NOW = Date.now()
const UPGRADE = 'https://murmur.app/account?upgrade=yearly'

/** What the gateway answers when a free account has spent its week (contract §4). */
const WORDS_REFUSAL = JSON.stringify({
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
    upgradeUrl: UPGRADE
  }
})
const RATE_REFUSAL = JSON.stringify({
  error: {
    type: 'murmur_gateway_error',
    code: 'rate_limited',
    message: 'Too many requests; try again in 30s',
    limit: 'requestsPerMinute',
    plan: 'free',
    planState: 'free',
    used: 20,
    allowed: 20,
    resetsAt: NOW + 30_000,
    upgradeUrl: UPGRADE
  }
})
const TOKENS_REFUSAL = JSON.stringify({
  error: {
    type: 'murmur_gateway_error',
    code: 'quota_exceeded',
    message: "This month's formatting allowance on the free plan is used up",
    limit: 'llmTokensPerMonth',
    plan: 'free',
    planState: 'free',
    used: 500_100,
    allowed: 500_000,
    resetsAt: NOW + 9 * 86_400_000,
    upgradeUrl: UPGRADE
  }
})

const provider = vi.hoisted(() => ({
  requests: 0,
  /** The next transcription requests: refused on a limit, or answered. */
  refusal: null as string | null,
  refusalStatus: 429,
  transcribe: async (): Promise<TranscribeOutput> => {
    provider.requests++
    if (provider.refusal) throw errorFromResponse(provider.refusalStatus, provider.refusal)
    return { text: 'hello from murmur', language: 'en', durationSec: 1.2, latencyMs: 10 }
  }
}))
vi.mock('@core/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt')>()
  return {
    ...actual,
    getSttProvider: () => ({
      transcribe: provider.transcribe,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' })
    })
  }
})

import { DictationController } from '../src/main/dictation/session'
import { HistoryStore } from '../src/main/store/history'
import { RecordingStore } from '../src/main/store/recordings'

const SAMPLE_RATE = 16000

function speech(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    const amplitude = t % 0.5 < 0.35 ? 11000 : 60
    pcm[i] = Math.round(Math.sin(i / 17) * amplitude + (Math.random() - 0.5) * 40)
  }
  return pcm
}

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor(mode: Settings['formatting']['mode']) {
    super()
    this.value.formatting.mode = mode
  }
  get(): Settings {
    return this.value
  }
  patch(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    return this.value
  }
}

const hook = {
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

/** The Murmur route: speech and formatting both go to the instance's gateway. */
const GATEWAY = 'https://happy-otter-123.convex.site/v1'
const formatter = vi.hoisted(() => ({
  /** What the gateway's /v1/format does: answer with the engine, skip for fair use, or refuse. */
  behaviour: 'model' as 'model' | 'fair-use' | 'refuse',
  calls: 0
}))
const inference = {
  stt: async () => ({
    source: 'murmur',
    provider: 'murmur',
    cfg: {
      kind: 'openai-compatible' as const,
      baseUrl: GATEWAY,
      apiKey: 'jwt',
      model: 'murmur-transcribe',
      language: 'auto',
      timeoutMs: 45000
    },
    fallbackModel: ''
  }),
  llm: async () => ({
    source: 'murmur',
    cfg: { baseUrl: GATEWAY, apiKey: 'jwt', model: 'murmur-format', timeoutMs: 8000 }
  }),
  formatter: async () => ({
    source: 'murmur',
    format: async (input: FormatInput): Promise<FormatOutcome> => {
      formatter.calls++
      if (formatter.behaviour === 'refuse') throw errorFromResponse(429, TOKENS_REFUSAL)
      if (formatter.behaviour === 'model') {
        return formatTranscript(input, async () => ({ text: 'Hello from Murmur.' }))
      }
      // Past the fair-use cap the gateway answers with the rule-based text and says why.
      const result = await formatTranscript(input, null)
      return {
        ...result,
        status: { outcome: 'skipped', detail: 'fair use', attempts: 0 },
        limit: {
          limit: 'fairUseSttSecondsPerMonth',
          plan: 'pro',
          planState: 'pro',
          used: 108_500,
          allowed: 108_000,
          resetsAt: NOW + 10 * 86_400_000,
          upgradeUrl: null,
          message: 'fair use'
        }
      }
    }
  }),
  complete: async () => {
    throw new Error('not used')
  },
  refreshedStt: async () => null
}

describe('DictationController and plan limits', () => {
  let dir: string
  let history: HistoryStore
  let recordings: RecordingStore
  let states: OverlayState[]
  let controller: DictationController

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
    expect(controller.isBusy).toBe(false)
  }

  function build(mode: Settings['formatting']['mode']): void {
    controller = new DictationController({
      settings: new FakeSettings(mode) as never,
      history,
      recorder: {
        pcm: speech(1.5),
        start: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn(async () => speech(1.5))
      } as never,
      recordings,
      hook: hook as never,
      inference: inference as never,
      overlay: { setState: (s) => states.push(s), playSound: () => undefined },
      getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
    })
  }

  async function dictate(): Promise<void> {
    controller.handle({ type: 'start', mode: 'hold' })
    controller.handle({ type: 'stop' })
    await settle()
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-limit-'))
    recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    states = []
    inject.calls.length = 0
    provider.requests = 0
    provider.refusal = null
    provider.refusalStatus = 429
    formatter.behaviour = 'model'
    formatter.calls = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a refused transcription keeps the recording and puts the limit on the pill, with Retry', async () => {
    build('smart')
    provider.refusal = WORDS_REFUSAL
    await dictate()

    const [entry] = history.list().entries
    expect(entry.finalText).toBe('')
    expect(entry.error).toBe("This week's 500 free words are used up.")
    expect(entry.recording).toBe(`${entry.id}.wav`)
    expect(recordings.has(entry.recording)).toBe(true)
    expect(inject.calls).toHaveLength(0)
    expect(formatter.calls).toBe(0)

    const shown = states.find((s) => s.phase === 'error')!
    expect(shown.retryId).toBe(entry.id)
    expect(shown.message).toBe(entry.error)
    expect(shown.limit).toMatchObject({
      limit: 'wordsPerWeek',
      plan: 'free',
      planState: 'free',
      used: 503,
      allowed: 500,
      upgradeUrl: UPGRADE
    })

    // Once the limit has reset (or the user switched provider), the same recording goes through.
    provider.refusal = null
    const result = await controller.retry(entry.id, { inject: true })
    expect(result).toEqual({ ok: true })
    expect(history.get(entry.id)).toMatchObject({
      finalText: 'Hello from Murmur.',
      attempts: 2,
      error: undefined
    })
    expect(inject.calls).toEqual([{ text: 'Hello from Murmur. ', method: 'auto' }])
    expect(states.at(-1)).toMatchObject({ phase: 'success' })
    expect(states.at(-1)?.limit).toBeUndefined()
  })

  it('a too-long clip is refused the same way, without a reset time', async () => {
    build('light')
    provider.refusalStatus = 413
    provider.refusal = JSON.stringify({
      error: {
        code: 'clip_too_long',
        message: 'Clips longer than 1 minute cannot be sent on the free plan',
        limit: 'maxClipSeconds',
        plan: 'free',
        planState: 'free',
        used: 75,
        allowed: 60,
        resetsAt: null,
        upgradeUrl: UPGRADE
      }
    })
    await dictate()
    const shown = states.find((s) => s.phase === 'error')!
    expect(shown.limit).toMatchObject({ limit: 'maxClipSeconds', resetsAt: null })
    expect(shown.retryId).toBeDefined()
    expect(recordings.has(history.list().entries[0].recording)).toBe(true)
  })

  it('a plain rate limit stays an ordinary retryable error', async () => {
    build('light')
    provider.refusal = RATE_REFUSAL
    await dictate()
    const shown = states.find((s) => s.phase === 'error')!
    expect(shown.message).toBe('Too many requests; try again in 30s')
    expect(shown.retryId).toBeDefined()
    expect(shown.limit).toBeUndefined()
  })

  it('a formatting model paused for fair use never drops the text: rule-based text goes in, the pill says so', async () => {
    build('smart')
    formatter.behaviour = 'fair-use'
    await dictate()

    expect(inject.calls).toEqual([{ text: 'Hello from murmur ', method: 'auto' }])
    const [entry] = history.list().entries
    expect(entry.finalText).toBe('Hello from murmur')
    expect(entry.error).toBeUndefined()
    expect(entry.llmUsed).toBe(false)
    expect(entry.llm).toMatchObject({ outcome: 'skipped', detail: 'fair use' })

    const shown = states.at(-1)!
    expect(shown.phase).toBe('success')
    expect(shown.limit).toMatchObject({ limit: 'fairUseSttSecondsPerMonth', plan: 'pro' })
    expect(states.some((s) => s.phase === 'error')).toBe(false)
  })

  it('a formatting request refused on a limit falls back to rule-based text and says why', async () => {
    build('smart')
    formatter.behaviour = 'refuse'
    await dictate()

    expect(inject.calls).toEqual([{ text: 'Hello from murmur ', method: 'auto' }])
    const [entry] = history.list().entries
    expect(entry.finalText).toBe('Hello from murmur')
    expect(entry.llm).toMatchObject({
      outcome: 'failed',
      detail: "This month's formatting allowance on the free plan is used up"
    })
    const shown = states.at(-1)!
    expect(shown.phase).toBe('success')
    expect(shown.limit).toMatchObject({ limit: 'llmTokensPerMonth', upgradeUrl: UPGRADE })
  })
})
