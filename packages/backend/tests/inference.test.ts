import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import {
  MAX_TRANSCRIPT_CHARS,
  clipSeconds,
  describeUpstreamFailure,
  modelsPayload,
  multipartBoundary,
  parseFormatRequest,
  parseMultipart,
  readUpstreams,
  subjectOf,
  tokensUsed,
  upstreamModelFor,
  wavInfo
} from '../convex/lib/inference'
import { MAX_CLIP_SECONDS, PLANS, TRIAL_MS, usagePeriod } from '../convex/lib/plans'
import {
  LLM_ENV,
  STT_ENV,
  ada,
  bob,
  jsonResponse,
  makeWav,
  setup,
  sttRequest,
  stubEnv,
  stubFetch
} from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('inference helpers', () => {
  it('reads upstream configuration from the environment', () => {
    expect(readUpstreams({})).toEqual({ stt: null, llm: null })
    expect(readUpstreams({ MURMUR_INFERENCE_STT_URL: 'https://x', MURMUR_INFERENCE_STT_MODEL: '' }).stt).toBeNull()
    expect(readUpstreams({ MURMUR_INFERENCE_STT_URL: 'ftp://x', MURMUR_INFERENCE_STT_MODEL: 'm' }).stt).toBeNull()
    const both = readUpstreams({ ...STT_ENV, ...LLM_ENV })
    expect(both.stt).toEqual({
      baseUrl: 'https://stt.example.test/v1',
      apiKey: 'sk-stt-secret',
      model: 'whisper-large-v3-turbo',
      proModel: undefined
    })
    expect(both.llm?.proModel).toBe('llama-3.3-70b-versatile')
    expect(upstreamModelFor(both.llm!, 'free')).toBe('llama-3.1-8b-instant')
    expect(upstreamModelFor(both.llm!, 'pro')).toBe('llama-3.3-70b-versatile')
    expect(upstreamModelFor(both.stt!, 'pro')).toBe('whisper-large-v3-turbo')
    expect(modelsPayload(both).data.map((m) => m.id)).toEqual(['murmur-transcribe', 'murmur-format'])
    expect(modelsPayload(readUpstreams(STT_ENV)).data.map((m) => m.id)).toEqual(['murmur-transcribe'])
  })

  it('parses multipart bodies produced by the Fetch API, binary parts intact', async () => {
    const wav = makeWav(1.5)
    const init = await sttRequest(wav, {
      language: 'en',
      prompt: 'Wispr Flow, naïve café — “quotes”',
      'timestamp_granularities[]': ['word', 'segment']
    })
    const contentType = (init.headers as Record<string, string>)['content-type']
    expect(multipartBoundary(contentType)).toBeTruthy()
    expect(multipartBoundary('application/json')).toBeNull()
    const parsed = parseMultipart(new Uint8Array(init.body as ArrayBuffer), contentType)
    expect(parsed.fields.model).toEqual(['murmur-transcribe'])
    expect(parsed.fields.language).toEqual(['en'])
    expect(parsed.fields.prompt).toEqual(['Wispr Flow, naïve café — “quotes”'])
    expect(parsed.fields['timestamp_granularities[]']).toEqual(['word', 'segment'])
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0]).toMatchObject({ name: 'file', filename: 'audio.wav', type: 'audio/wav' })
    expect(parsed.files[0].data.length).toBe(wav.length)
    expect(Array.from(parsed.files[0].data.subarray(0, 12))).toEqual(Array.from(wav.subarray(0, 12)))
    expect(parsed.files[0].data.every((b, i) => b === wav[i])).toBe(true)
  })

  it('rejects malformed multipart bodies', () => {
    expect(() => parseMultipart(new Uint8Array([1, 2, 3]), 'multipart/form-data; boundary=abc')).toThrow(/boundary/i)
    expect(() => parseMultipart(new Uint8Array([1, 2, 3]), 'text/plain')).toThrow(/multipart/i)
    const unterminated = new TextEncoder().encode('--abc\r\ncontent-disposition: form-data; name="x"\r\n\r\nvalue')
    expect(() => parseMultipart(unterminated, 'multipart/form-data; boundary=abc')).toThrow(/closing boundary/i)
  })

  it('measures WAV clips and estimates anything else', () => {
    const info = wavInfo(makeWav(12.25))
    expect(info).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 })
    expect(info!.durationSec).toBeCloseTo(12.25, 3)
    expect(wavInfo(makeWav(2, 44_100, 2, 16))!.durationSec).toBeCloseTo(2, 3)
    expect(wavInfo(new TextEncoder().encode('not audio at all, just some text bytes to be sure'))).toBeNull()
    expect(clipSeconds(new Uint8Array(32_000 * 3))).toBe(3)
    // A streaming encoder that left the data size blank is measured from what arrived.
    const blank = makeWav(4)
    new DataView(blank.buffer).setUint32(40, 0xffffffff, true)
    expect(wavInfo(blank)!.durationSec).toBeCloseTo(4, 3)
  })

  it('treats a bearer token Convex cannot parse as "not signed in", never as a crash', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await subjectOf({ getUserIdentity: async () => ({ subject: 'user_ada' }) })).toBe('user_ada')
    expect(await subjectOf({ getUserIdentity: async () => null })).toBeNull()
    expect(
      await subjectOf({
        getUserIdentity: async () => {
          throw new Error('Could not parse JWT payload')
        }
      })
    ).toBeNull()
    expect(warn).toHaveBeenCalledWith('[gateway] rejected bearer token:', 'Could not parse JWT payload')
    warn.mockRestore()
  })

  it('maps upstream failures without leaking credentials and counts tokens', () => {
    expect(describeUpstreamFailure(401, '{"error":{"message":"bad key sk-live-123"}}')).toMatchObject({
      status: 502,
      code: 'upstream_auth'
    })
    expect(describeUpstreamFailure(401, '').message).not.toMatch(/sk-live/)
    expect(describeUpstreamFailure(429, 'slow down')).toMatchObject({ status: 503, code: 'upstream_busy' })
    expect(describeUpstreamFailure(400, '{"error":{"message":"timestamp_granularities not supported"}}')).toEqual({
      status: 400,
      code: 'bad_request',
      message: 'timestamp_granularities not supported'
    })
    expect(describeUpstreamFailure(500, 'boom')).toMatchObject({ status: 502, code: 'upstream_error', message: 'boom' })
    expect(tokensUsed({ total_tokens: 42 }, 1000, 1000)).toBe(42)
    expect(tokensUsed({ prompt_tokens: 10, completion_tokens: 5 }, 0, 0)).toBe(15)
    expect(tokensUsed(undefined, 400, 200)).toBe(150)
    expect(usagePeriod(Date.UTC(2026, 8, 7, 23, 59))).toBe('2026-09')
    expect(usagePeriod(Date.UTC(2026, 11, 31, 23, 59))).toBe('2026-12')
  })
})

describe('managed inference gateway', () => {
  beforeEach(() => stubEnv({ ...STT_ENV, ...LLM_ENV }))

  it('requires a signed-in account on every route', async () => {
    const t = setup()
    expect((await t.fetch('/v1/models')).status).toBe(401)
    const stt = await t.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(stt.status).toBe(401)
    const llm = await t.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'murmur-format', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(llm.status).toBe(401)
    expect((await llm.json()).error.code).toBe('unauthorized')
  })

  it('reports unavailable managed models when the instance has none configured', async () => {
    vi.unstubAllEnvs()
    const t = setup()
    const asAda = t.withIdentity(ada)
    const res = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('not_configured')
    expect((await (await asAda.fetch('/v1/models')).json()).data).toEqual([])
    const status = await asAda.query(api.inference.status, {})
    expect(status.available).toBe(false)
    expect(status.models).toEqual({ stt: null, llm: null })
    expect(status.plan).toBe('free')
  })

  it('lists the managed models and the trial (Pro) allowance for a fresh account', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const models = await (await asAda.fetch('/v1/models')).json()
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(['murmur-transcribe', 'murmur-format'])
    const before = Date.now()
    await asAda.mutation(api.users.ensure, {})
    const status = await asAda.query(api.inference.status, {})
    expect(status).toMatchObject({
      available: true,
      models: { stt: 'murmur-transcribe', llm: 'murmur-format' },
      plan: 'pro',
      planState: 'trial',
      limits: {
        sttSecondsPerMonth: PLANS.pro.sttSecondsPerMonth,
        llmTokensPerMonth: PLANS.pro.llmTokensPerMonth,
        requestsPerMinute: PLANS.pro.requestsPerMinute,
        maxClipSeconds: MAX_CLIP_SECONDS
      },
      usage: { period: '', sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0 },
      formattingPaused: false,
      upgradeUrl: null,
      window: null,
      meters: [],
      resets: null
    })
    expect(status.trialEndsAt).toBeGreaterThanOrEqual(before + TRIAL_MS)
    // Without `day` nothing windowed is computed; the free-tier meters come with it (see entitlements.test.ts).
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    const free = await asAda.query(api.inference.status, {})
    expect(free.limits).toEqual({
      sttSecondsPerMonth: PLANS.free.sttSecondsPerMonth,
      llmTokensPerMonth: PLANS.free.llmTokensPerMonth,
      requestsPerMinute: PLANS.free.requestsPerMinute,
      maxClipSeconds: PLANS.free.maxClipSeconds
    })
  })

  it('forwards a transcription with the instance credentials and bills the clip length', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ text: 'ask not what your country can do for you', duration: 11, language: 'en' })
    )
    const t = setup()
    const asAda = t.withIdentity(ada)
    const wav = makeWav(11)
    const res = await asAda.fetch(
      '/v1/audio/transcriptions',
      await sttRequest(wav, {
        language: 'en',
        prompt: 'Murmur.',
        response_format: 'verbose_json',
        temperature: '0',
        'timestamp_granularities[]': ['word', 'segment'],
        // Not on the allow list: must never reach the provider.
        user: 'someone-else',
        file_url: 'https://evil.test'
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ text: 'ask not what your country can do for you' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://stt.example.test/v1/audio/transcriptions')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-stt-secret')
    const form = calls[0].init.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('language')).toBe('en')
    expect(form.get('prompt')).toBe('Murmur.')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
    expect(form.get('user')).toBeNull()
    expect(form.get('file_url')).toBeNull()
    const file = form.get('file') as File
    expect(file.size).toBe(wav.length)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav)

    const status = await asAda.query(api.inference.status, {})
    expect(status.usage.period).toBe(usagePeriod(Date.now()))
    expect(status.usage.sttRequests).toBe(1)
    expect(status.usage.sttSeconds).toBeCloseTo(11, 2)
    expect(status.usage.llmRequests).toBe(0)
    // Another account is untouched.
    expect((await t.withIdentity(bob).query(api.inference.status, {})).usage.sttRequests).toBe(0)
  })

  it('accepts a raw audio body with query parameters', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'hello', duration: 2 }))
    const t = setup()
    const wav = makeWav(2)
    const res = await t.withIdentity(ada).fetch('/v1/audio/transcriptions?model=murmur-transcribe&language=de', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav as BodyInit
    })
    expect(res.status).toBe(200)
    const form = calls[0].init.body as FormData
    expect(form.get('language')).toBe('de')
    expect((form.get('file') as File).size).toBe(wav.length)
  })

  it('names the available model when the client asks for another one', async () => {
    const calls = stubFetch(() => jsonResponse({}))
    const t = setup()
    const res = await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1), {}, 'whisper-1'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('model_not_found')
    // The apps pick the hint up with /available models?:\s*(...)/i and offer it in the UI.
    expect(body.error.message).toMatch(/Available models: murmur-transcribe$/)
    expect(calls).toHaveLength(0)
    const chat = await t.withIdentity(ada).fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] })
    })
    expect(chat.status).toBe(404)
    expect((await chat.json()).error.message).toMatch(/Available models: murmur-format$/)
  })

  it('rejects bad speech requests before touching the provider', async () => {
    const calls = stubFetch(() => jsonResponse({}))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const noFile = new FormData()
    noFile.append('model', 'murmur-transcribe')
    const req = new Request('https://client.test/', { method: 'POST', body: noFile })
    const missing = await asAda.fetch('/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': req.headers.get('content-type')! },
      body: await req.arrayBuffer()
    })
    expect(missing.status).toBe(400)
    const wrongType = await asAda.fetch('/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(wrongType.status).toBe(400)
    const tooLong = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(MAX_CLIP_SECONDS + 5)))
    expect(tooLong.status).toBe(413)
    expect((await tooLong.json()).error.code).toBe('clip_too_long')
    expect(calls).toHaveLength(0)
  })

  it('stops at the monthly allowance and the request rate of the plan', async () => {
    const calls = stubFetch(() => jsonResponse({ text: 'ok', duration: 60 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const user = await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    const period = usagePeriod(Date.now())
    // Nearly out of minutes: the next 60 s clip does not fit.
    await t.run(async (ctx) => {
      await ctx.db.insert('inferenceUsage', {
        userId: user.id,
        period,
        sttSeconds: PLANS.free.sttSecondsPerMonth - 30,
        sttRequests: 100,
        llmTokens: PLANS.free.llmTokensPerMonth,
        llmRequests: 5,
        updatedAt: Date.now()
      })
    })
    const quota = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(60)))
    expect(quota.status).toBe(429)
    expect((await quota.json()).error).toMatchObject({ code: 'quota_exceeded' })
    const llmQuota = await asAda.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'murmur-format', messages: [{ role: 'user', content: 'x' }] })
    })
    expect(llmQuota.status).toBe(429)
    expect((await llmQuota.json()).error.code).toBe('quota_exceeded')
    expect(calls).toHaveLength(0)

    // A short clip still fits; a burst beyond the per-minute rate is refused with Retry-After.
    await t.run(async (ctx) => {
      const usage = await ctx.db
        .query('inferenceUsage')
        .withIndex('by_user_and_period', (q) => q.eq('userId', user.id).eq('period', period))
        .unique()
      await ctx.db.patch('inferenceUsage', usage!._id, {
        sttSeconds: 0,
        windowStart: Date.now(),
        windowCount: PLANS.free.requestsPerMinute
      })
    })
    const limited = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))
    expect(limited.status).toBe(429)
    expect((await limited.json()).error.code).toBe('rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)

    // A pro account has a larger allowance and is not throttled at the free rate.
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'pro' })
    expect((await asAda.query(api.users.me, {}))).toMatchObject({ plan: 'pro', planState: 'pro' })
    const pro = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(5)))
    expect(pro.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect((await asAda.query(api.inference.status, {})).limits.sttSecondsPerMonth).toBe(PLANS.pro.sttSecondsPerMonth)
  })

  it('translates provider failures and never bills them', async () => {
    let upstream: Response = jsonResponse({ error: { message: 'timestamp_granularities is not supported' } }, 400)
    stubFetch(() => upstream)
    const t = setup()
    const asAda = t.withIdentity(ada)
    const bad = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(3)))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.message).toMatch(/timestamp_granularities/)

    upstream = new Response('Invalid API key sk-stt-secret', { status: 401 })
    const auth = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(3)))
    expect(auth.status).toBe(502)
    const authBody = await auth.json()
    expect(authBody.error.code).toBe('upstream_auth')
    expect(JSON.stringify(authBody)).not.toMatch(/sk-stt-secret/)

    upstream = new Response('rate limited', { status: 429 })
    expect((await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(3)))).status).toBe(503)

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    const down = await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(3)))
    expect(down.status).toBe(502)
    expect((await down.json()).error.code).toBe('upstream_error')

    const status = await asAda.query(api.inference.status, {})
    expect(status.usage.sttRequests).toBe(0)
    expect(status.usage.sttSeconds).toBe(0)
  })

  it('forwards chat completions with only the allowed parameters and bills tokens', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        id: 'chatcmpl-1',
        model: 'llama-3.1-8b-instant',
        choices: [{ message: { role: 'assistant', content: 'Hello there.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 }
      })
    )
    const t = setup()
    const asAda = t.withIdentity(ada)
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    const res = await asAda.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'murmur-format',
        messages: [{ role: 'user', content: 'hello there' }],
        temperature: 0,
        max_tokens: 99_999,
        stream: true,
        n: 5,
        tools: [{ type: 'function' }],
        user: 'spoofed'
      })
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('Hello there.')
    expect(body.model).toBe('murmur-format')

    expect(calls[0].url).toBe('https://llm.example.test/v1/chat/completions')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-llm-secret')
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent).toEqual({
      model: 'llama-3.1-8b-instant',
      stream: false,
      messages: [{ role: 'user', content: 'hello there' }],
      temperature: 0,
      max_tokens: 4096
    })

    const status = await asAda.query(api.inference.status, {})
    expect(status.usage.llmRequests).toBe(1)
    expect(status.usage.llmTokens).toBe(34)

    // Pro accounts are routed to the better model when the instance has one.
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'pro' })
    await asAda.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'murmur-format', messages: [{ role: 'user', content: 'again' }] })
    })
    expect(JSON.parse(calls[1].init.body as string).model).toBe('llama-3.3-70b-versatile')
  })

  it('rejects malformed chat requests', async () => {
    const calls = stubFetch(() => jsonResponse({}))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const headers = { 'content-type': 'application/json' }
    expect((await asAda.fetch('/v1/chat/completions', { method: 'POST', headers, body: 'nope' })).status).toBe(400)
    expect(
      (
        await asAda.fetch('/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'murmur-format', messages: [] })
        })
      ).status
    ).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('deletes usage with the rest of the account data', async () => {
    stubFetch(() => jsonResponse({ text: 'ok', duration: 1 }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    expect((await asAda.fetch('/v1/audio/transcriptions', await sttRequest(makeWav(1)))).status).toBe(200)
    await t.run(async (ctx) => {
      expect(await ctx.db.query('inferenceUsage').collect()).toHaveLength(1)
    })
    await asAda.mutation(api.users.deleteMyData, {})
    await t.run(async (ctx) => {
      expect(await ctx.db.query('inferenceUsage').collect()).toHaveLength(0)
    })
  })
})

describe('POST /v1/format', () => {
  const headers = { 'content-type': 'application/json' }
  const chat = (content: string, finish = 'stop', tokens = 40): Response =>
    jsonResponse({
      choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { prompt_tokens: tokens - 5, completion_tokens: 5, total_tokens: tokens }
    })
  const body = (transcript: string, context: Record<string, unknown> = {}): RequestInit => ({
    method: 'POST',
    headers,
    body: JSON.stringify({ transcript, context: { category: 'chat', tone: 'casual', app: 'Slack', ...context } })
  })

  it('parses and bounds a client body', () => {
    expect(parseFormatRequest('x')).toMatchObject({ ok: false })
    expect(parseFormatRequest({})).toMatchObject({ ok: false, message: '"transcript" must be a string' })
    const parsed = parseFormatRequest({
      transcript: 'hello there',
      context: {
        category: 'bogus',
        tone: 'shouty',
        dictionary: [{ word: 'Wispr Flow', aliases: ['whisper flow', 7] }, 'nope', { word: '' }],
        keepVerbatim: ['my sig', '', 3],
        precedingText: 'I think',
        language: 'de',
        instructions: 'British spelling'
      }
    })
    expect(parsed).toEqual({
      ok: true,
      request: {
        transcript: 'hello there',
        context: {
          category: 'unknown',
          tone: 'neutral',
          app: undefined,
          language: 'de',
          precedingText: 'I think',
          instructions: 'British spelling',
          dictionary: [{ word: 'Wispr Flow', aliases: ['whisper flow'], fuzzy: false }],
          keepVerbatim: ['my sig']
        }
      }
    })
    expect(parseFormatRequest({ transcript: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1) })).toMatchObject({ ok: false })
  })

  it('runs the engine against the instance model and bills the tokens', async () => {
    stubEnv(LLM_ENV)
    const calls = stubFetch(() => chat('The budget is $1,200,000.'))
    const t = setup()
    const asAda = t.withIdentity(ada)
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    const res = await asAda.fetch(
      '/v1/format',
      body('um the budget is one million two hundred thousand dollars', {
        dictionary: [{ word: 'Sarah', aliases: [] }],
        language: 'en'
      })
    )
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.text).toBe('The budget is $1,200,000.')
    expect(out.status).toMatchObject({ outcome: 'used', attempts: 1 })
    expect(out.model).toBe('murmur-format')
    expect(out.pressEnter).toBe(false)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://llm.example.test/v1/chat/completions')
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent.model).toBe('llama-3.1-8b-instant')
    expect(sent.messages[0].role).toBe('system')
    const user = sent.messages[sent.messages.length - 1]
    expect(user.role).toBe('user')
    expect(user.content).toContain('Destination: a chat message (Slack). Tone: casual.')
    expect(user.content).toContain('Language: English.')
    expect(user.content).toContain('Dictionary: Sarah.')
    expect(user.content).toContain('Transcript:\num the budget is one million two hundred thousand dollars')

    const status = await asAda.query(api.inference.status, {})
    expect(status.usage.llmRequests).toBe(1)
    expect(status.usage.llmTokens).toBe(40)
  })

  it('retries once in strict mode when the verifier rejects, and falls back when it fails again', async () => {
    stubEnv(LLM_ENV)
    let n = 0
    const calls = stubFetch(() => chat(n++ === 0 ? 'The code is 7.' : 'The code is 0007.'))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const good = await (await asAda.fetch('/v1/format', body('the code is zero zero zero seven'))).json()
    expect(good.text).toBe('The code is 0007.')
    expect(good.status).toMatchObject({ outcome: 'used', attempts: 2 })
    expect(good.status.retriedAfter).toMatch(/^numbers-changed/)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1].init.body as string).messages.at(-1).content).toContain('Strict:')
    // One format request is one request for quota purposes, whatever the retries cost in tokens.
    let status = await asAda.query(api.inference.status, {})
    expect(status.usage.llmRequests).toBe(1)
    expect(status.usage.llmTokens).toBe(80)

    stubFetch(() => chat('The code is 7.'))
    const bad = await (await asAda.fetch('/v1/format', body('um the code is zero zero zero seven'))).json()
    expect(bad.status).toMatchObject({ outcome: 'rejected', attempts: 2 })
    expect(bad.text).toBe('The code is zero zero zero seven')
    expect(bad.modelText).toBe('The code is 7.')
    status = await asAda.query(api.inference.status, {})
    expect(status.usage.llmRequests).toBe(2)
  })

  it('reports an unreachable or failing upstream as a failed format, never a 5xx', async () => {
    stubEnv(LLM_ENV)
    stubFetch(() => jsonResponse({ error: { message: 'nope' } }, 500))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const res = await asAda.fetch('/v1/format', body('hello there everyone'))
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.status.outcome).toBe('failed')
    expect(out.text).toBe('Hello there everyone')
    // Nothing was billed for a request the provider never answered.
    expect((await asAda.query(api.inference.status, {})).usage.llmRequests).toBe(1)
  })

  it('enforces sign-in, configuration, the body shape and the quota', async () => {
    const t = setup()
    expect((await t.fetch('/v1/format', body('hello'))).status).toBe(401)
    const asAda = t.withIdentity(ada)
    expect((await asAda.fetch('/v1/format', body('hello'))).status).toBe(503)
    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'free' })
    stubEnv(LLM_ENV)
    stubFetch(() => chat('Hello.'))
    expect((await asAda.fetch('/v1/format', { method: 'POST', headers, body: 'nope' })).status).toBe(400)
    expect((await asAda.fetch('/v1/format', { method: 'POST', headers, body: JSON.stringify({ context: {} }) })).status).toBe(400)
    expect((await asAda.fetch('/v1/format', body('hello there everyone'))).status).toBe(200)
    await t.run(async (ctx) => {
      const usage = await ctx.db.query('inferenceUsage').first()
      await ctx.db.patch('inferenceUsage', usage!._id, { llmTokens: PLANS.free.llmTokensPerMonth })
    })
    const quota = await asAda.fetch('/v1/format', body('hello there everyone'))
    expect(quota.status).toBe(429)
    expect((await quota.json()).error.code).toBe('quota_exceeded')
  })
})
