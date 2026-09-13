import { afterEach, describe, expect, it, vi } from 'vitest'
import { SttError, errorFromResponse } from '@core/stt/types'
import type { CloudConfig } from '@shared/cloud'
import {
  MURMUR_LLM_MODEL,
  MURMUR_STT_MODEL,
  llmConfigured,
  murmurGatewayUrl,
  resolveInferenceSources,
  sttConfigured
} from '@shared/inference'
import { parseSettings, type Settings } from '@shared/settings'
import { InferenceRouter, type RouterDeps } from '../src/main/inference/router'
import { friendlyError } from '../src/main/dictation/session'

const LOCAL: CloudConfig = {
  accountMode: 'off',
  convexUrl: '',
  convexSiteUrl: '',
  clerkPublishableKey: '',
  clerkFrontendApiHost: '',
  deepLinkScheme: 'murmur',
  jwtTemplate: 'convex'
}

const CLOUD: CloudConfig = {
  accountMode: 'required',
  convexUrl: 'https://happy-otter-123.convex.cloud',
  convexSiteUrl: 'https://happy-otter-123.convex.site',
  clerkPublishableKey: 'pk_live_x',
  clerkFrontendApiHost: 'clerk.murmur.app',
  deepLinkScheme: 'murmur',
  jwtTemplate: 'convex'
}

const GATEWAY = 'https://happy-otter-123.convex.site/v1'

const own = (): Settings =>
  parseSettings({
    stt: {
      source: 'custom',
      kind: 'openai-compatible',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      fallbackModel: 'whisper-large-v3'
    },
    formatting: { llm: { source: 'custom', sameAsStt: true, model: 'openai/gpt-oss-20b' } }
  })

describe('resolveInferenceSources', () => {
  it('never routes a local build to Murmur, whatever the settings say', () => {
    const s = parseSettings({})
    expect(s.stt.source).toBe('murmur')
    expect(s.formatting.llm.source).toBe('murmur')
    expect(resolveInferenceSources(s, { cloudEnabled: false })).toEqual({
      stt: 'custom',
      llm: 'custom'
    })
    // ...even when the instance status is unknown or positive.
    expect(resolveInferenceSources(s, { cloudEnabled: false, managedAvailable: true })).toEqual({
      stt: 'custom',
      llm: 'custom'
    })
  })

  it('defaults a cloud build to Murmur models for both stages', () => {
    const s = parseSettings({})
    expect(resolveInferenceSources(s, { cloudEnabled: true })).toEqual({
      stt: 'murmur',
      llm: 'murmur'
    })
    expect(resolveInferenceSources(s, { cloudEnabled: true, managedAvailable: true })).toEqual({
      stt: 'murmur',
      llm: 'murmur'
    })
  })

  it("falls back to the user's provider when the instance offers no managed models", () => {
    expect(
      resolveInferenceSources(parseSettings({}), { cloudEnabled: true, managedAvailable: false })
    ).toEqual({ stt: 'custom', llm: 'custom' })
  })

  it('lets "same server as speech" follow the speech model wherever it points', () => {
    const s = own()
    expect(resolveInferenceSources(s, { cloudEnabled: true })).toEqual({
      stt: 'custom',
      llm: 'custom'
    })
    const murmurStt = parseSettings({ ...s, stt: { ...s.stt, source: 'murmur' } })
    expect(resolveInferenceSources(murmurStt, { cloudEnabled: true })).toEqual({
      stt: 'murmur',
      llm: 'murmur'
    })
    const ownLlm = parseSettings({
      ...murmurStt,
      formatting: {
        ...murmurStt.formatting,
        llm: { ...murmurStt.formatting.llm, sameAsStt: false, baseUrl: 'http://127.0.0.1:11434/v1' }
      }
    })
    expect(resolveInferenceSources(ownLlm, { cloudEnabled: true })).toEqual({
      stt: 'murmur',
      llm: 'custom'
    })
    // An explicit Murmur formatting model wins over "same as speech" pointing at a custom server.
    const murmurLlm = parseSettings({
      ...s,
      formatting: { ...s.formatting, llm: { ...s.formatting.llm, source: 'murmur' } }
    })
    expect(resolveInferenceSources(murmurLlm, { cloudEnabled: true })).toEqual({
      stt: 'custom',
      llm: 'murmur'
    })
  })

  it('knows when a stage is ready to use', () => {
    const blank = parseSettings({})
    expect(sttConfigured(blank, { stt: 'custom' }, true)).toBe(false)
    expect(sttConfigured(blank, { stt: 'murmur' }, false)).toBe(false)
    expect(sttConfigured(blank, { stt: 'murmur' }, true)).toBe(true)
    expect(sttConfigured(own(), { stt: 'custom' }, false)).toBe(true)
    expect(llmConfigured(blank, { stt: 'murmur', llm: 'murmur' }, true)).toBe(true)
    expect(llmConfigured(blank, { stt: 'custom', llm: 'custom' }, true)).toBe(false)
    expect(llmConfigured(own(), { stt: 'custom', llm: 'custom' }, false)).toBe(true)
    const noModel = own()
    noModel.formatting.llm.model = ''
    expect(llmConfigured(noModel, { stt: 'custom', llm: 'custom' }, false)).toBe(false)
  })

  it('builds the gateway URL from the HTTP actions origin', () => {
    expect(murmurGatewayUrl('https://happy-otter-123.convex.site/')).toBe(GATEWAY)
    expect(murmurGatewayUrl(' http://127.0.0.1:3211 ')).toBe('http://127.0.0.1:3211/v1')
  })
})

interface Harness {
  router: InferenceRouter
  tokens: string[]
  requests: boolean[]
}

function harness(
  config: CloudConfig,
  settings: Settings,
  opts: { token?: (() => string | null) | string[]; signedIn?: boolean; managed?: boolean } = {}
): Harness {
  const requests: boolean[] = []
  const queue = Array.isArray(opts.token) ? [...opts.token] : null
  const tokens: string[] = []
  const deps: RouterDeps = {
    config,
    settings: {
      get: () => settings,
      getSecret: (slot) => (slot === 'stt' ? 'sk-own-stt' : 'sk-own-llm')
    },
    token: async (force) => {
      requests.push(force)
      const t = queue
        ? (queue.shift() ?? null)
        : typeof opts.token === 'function'
          ? opts.token()
          : null
      if (t) tokens.push(t)
      return t
    },
    signedIn: () => opts.signedIn ?? true,
    managedAvailable: () => opts.managed
  }
  return { router: new InferenceRouter(deps), tokens, requests }
}

afterEach(() => vi.unstubAllGlobals())

describe('InferenceRouter', () => {
  it("serves the user's own provider with the device secret in local builds", async () => {
    const { router, requests } = harness(LOCAL, own(), { token: () => 'should-not-be-asked' })
    expect(router.cloudEnabled).toBe(false)
    const stt = await router.stt()
    expect(stt).toMatchObject({
      source: 'custom',
      provider: 'openai-compatible',
      fallbackModel: 'whisper-large-v3',
      cfg: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'sk-own-stt',
        model: 'whisper-large-v3-turbo'
      }
    })
    const llm = await router.llm()
    expect(llm.cfg).toMatchObject({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'sk-own-stt',
      model: 'openai/gpt-oss-20b'
    })
    // Default settings in a local build: still the user's (unset) provider, never a token request.
    const blank = harness(LOCAL, parseSettings({}), { token: () => 'nope' })
    expect((await blank.router.stt()).source).toBe('custom')
    expect((await blank.router.llm()).source).toBe('custom')
    expect(requests).toEqual([])
    expect(blank.requests).toEqual([])
  })

  it('points a cloud build at the gateway with the session token as the key', async () => {
    const { router, requests } = harness(CLOUD, parseSettings({}), { token: () => 'jwt-1' })
    expect(router.cloudEnabled).toBe(true)
    const stt = await router.stt()
    expect(stt).toEqual({
      source: 'murmur',
      provider: 'murmur',
      fallbackModel: '',
      cfg: {
        kind: 'openai-compatible',
        baseUrl: GATEWAY,
        apiKey: 'jwt-1',
        model: MURMUR_STT_MODEL,
        language: 'auto',
        timeoutMs: 45000
      }
    })
    const llm = await router.llm()
    expect(llm).toEqual({
      source: 'murmur',
      cfg: { baseUrl: GATEWAY, apiKey: 'jwt-1', model: MURMUR_LLM_MODEL, timeoutMs: 8000 }
    })
    expect(requests).toEqual([false, false])
    expect(router.isMurmur({ baseUrl: `${GATEWAY}/` })).toBe(true)
    expect(router.isMurmur({ baseUrl: 'https://api.groq.com/openai/v1' })).toBe(false)
  })

  it("keeps a cloud user's own provider when they chose it, or when the instance has no models", async () => {
    const chosen = harness(CLOUD, own(), { token: () => 'jwt' })
    expect((await chosen.router.stt()).cfg.apiKey).toBe('sk-own-stt')
    expect(chosen.requests).toEqual([])
    const none = harness(CLOUD, parseSettings({}), { token: () => 'jwt', managed: false })
    expect((await none.router.stt()).source).toBe('custom')
    expect((await none.router.llm()).source).toBe('custom')
    expect(none.requests).toEqual([])
  })

  it('explains a missing session token', async () => {
    const signedOut = harness(CLOUD, parseSettings({}), { token: () => null, signedIn: false })
    const err = await signedOut.router.stt().catch((e) => e)
    expect(err).toBeInstanceOf(SttError)
    expect(err.code).toBe('murmur_signed_out')
    expect(friendlyError(err)).toMatch(/Sign in to use Murmur models/)
    const noToken = harness(CLOUD, parseSettings({}), { token: () => null, signedIn: true })
    const err2 = await noToken.router.llm().catch((e) => e)
    expect(err2.code).toBe('murmur_no_token')
    expect(err2.kind).toBe('network')
  })

  it('refreshes the token and retries once when the gateway rejects it', async () => {
    const { router, requests } = harness(CLOUD, parseSettings({}), {
      token: ['jwt-old', 'jwt-new']
    })
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization
        seen.push(auth)
        if (auth === 'Bearer jwt-old')
          return new Response(
            JSON.stringify({
              error: { message: 'Sign in to use Murmur models', code: 'unauthorized' }
            }),
            { status: 401 }
          )
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Hello.' } }],
            model: MURMUR_LLM_MODEL
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const llm = await router.llm()
    const res = await router.complete(llm.cfg, [{ role: 'user', content: 'hello' }])
    expect(res.text).toBe('Hello.')
    expect(seen).toEqual(['Bearer jwt-old', 'Bearer jwt-new'])
    expect(requests).toEqual([false, true])

    // The speech path gets a refreshed configuration for the same situation, and only then.
    const stt = await harness(CLOUD, parseSettings({}), { token: ['a', 'b'] }).router.stt()
    const fresh = harness(CLOUD, parseSettings({}), { token: ['fresh'] })
    const refreshed = await fresh.router.refreshedStt(stt, new SttError('nope', 'auth', 401))
    expect(refreshed?.apiKey).toBe('fresh')
    expect(fresh.requests).toEqual([true])
    expect(await fresh.router.refreshedStt(stt, new SttError('slow', 'timeout'))).toBeNull()
    const ownStt = await harness(CLOUD, own()).router.stt()
    expect(await fresh.router.refreshedStt(ownStt, new SttError('nope', 'auth', 401))).toBeNull()
  })

  it('formats through the gateway for Murmur models and refreshes a rejected token once', async () => {
    const { router, requests } = harness(CLOUD, parseSettings({}), {
      token: ['jwt-old', 'jwt-new']
    })
    const seen: Array<{ url: string; auth: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization
        seen.push({ url, auth, body: JSON.parse(init.body as string) })
        if (auth === 'Bearer jwt-old')
          return new Response(
            JSON.stringify({ error: { message: 'expired', code: 'unauthorized' } }),
            {
              status: 401
            }
          )
        return new Response(
          JSON.stringify({
            text: 'The budget is $1,200,000.',
            pressEnter: false,
            status: { outcome: 'used', attempts: 1 },
            llmMs: 412,
            stages: ['llm'],
            model: MURMUR_LLM_MODEL
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const formatter = await router.formatter()
    expect(formatter.source).toBe('murmur')
    const input = {
      transcript: 'the budget is one million two hundred thousand dollars',
      mode: 'smart' as const,
      context: { category: 'chat' as const, tone: 'casual' as const, dictionary: [] }
    }
    const result = await formatter.format(input)
    expect(result.text).toBe('The budget is $1,200,000.')
    expect(result.status).toEqual({ outcome: 'used', attempts: 1 })
    expect(seen.map((x) => x.url)).toEqual([`${GATEWAY}/format`, `${GATEWAY}/format`])
    expect(seen.map((x) => x.auth)).toEqual(['Bearer jwt-old', 'Bearer jwt-new'])
    expect(seen[1].body).toEqual({ transcript: input.transcript, context: input.context })
    expect(requests).toEqual([false, true])
  })

  it("runs the engine locally against the user's own model", async () => {
    const { router } = harness(CLOUD, own(), { token: () => 'jwt' })
    const seen: Array<{
      url: string
      body: { model: string; messages: Array<{ role: string; content: string }> }
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, body: JSON.parse(init.body as string) })
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'The code is 0007.' }, finish_reason: 'stop' }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const formatter = await router.formatter()
    expect(formatter.source).toBe('custom')
    const result = await formatter.format({
      transcript: 'the code is zero zero zero seven',
      mode: 'smart',
      context: { category: 'unknown', tone: 'neutral', dictionary: [] }
    })
    expect(result.text).toBe('The code is 0007.')
    expect(result.status.outcome).toBe('used')
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(seen[0].body.model).toBe('openai/gpt-oss-20b')
    expect(seen[0].body.messages.at(-1)?.content).toContain(
      'Transcript:\nthe code is zero zero zero seven'
    )
  })

  it('does not retry an own-provider 401 with a Murmur token', async () => {
    const { router, requests } = harness(CLOUD, own(), { token: () => 'jwt' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }))
    )
    const llm = await router.llm()
    await expect(router.complete(llm.cfg, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      kind: 'auth'
    })
    expect(requests).toEqual([])
  })
})

describe('gateway errors reach the user verbatim', () => {
  it('keeps the code from an OpenAI-style error body', () => {
    const err = errorFromResponse(
      429,
      JSON.stringify({
        error: {
          message: "This month's 120 minutes of Murmur transcription on the free plan are used up",
          code: 'quota_exceeded'
        }
      })
    )
    expect(err.kind).toBe('rate-limit')
    expect(err.code).toBe('quota_exceeded')
    expect(friendlyError(err)).toMatch(/120 minutes/)
    // Ordinary providers keep the generic wording.
    const other = errorFromResponse(
      429,
      JSON.stringify({ error: { message: 'Too Many Requests' } })
    )
    expect(other.code).toBeUndefined()
    expect(friendlyError(other)).toMatch(/Rate limited by the provider/)
    const auth = errorFromResponse(401, JSON.stringify({ error: { message: 'Invalid API key' } }))
    expect(friendlyError(auth)).toMatch(/check your API key/)
    const gatewayAuth = errorFromResponse(
      401,
      JSON.stringify({ error: { message: 'Sign in to use Murmur models', code: 'unauthorized' } })
    )
    expect(friendlyError(gatewayAuth)).toBe('Sign in to use Murmur models')
  })
})
