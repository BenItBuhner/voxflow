import { internal } from './_generated/api'
import { httpAction, type ActionCtx } from './_generated/server'
import { formatTranscript } from '../../text-engine/src/format'
import type { ChatMessage, ChatOptions, ChatResult } from '../../text-engine/src/types'
import {
  MAX_COMPLETION_TOKENS,
  MURMUR_MODELS,
  STT_PASSTHROUGH_FIELDS,
  clipSeconds,
  describeUpstreamFailure,
  gatewayError,
  limitDetail,
  limitError,
  modelsPayload,
  multipartBoundary,
  parseFormatRequest,
  parseMultipart,
  readUpstreams,
  subjectOf,
  tokensUsed,
  transcriptWords,
  upstreamModelFor,
  wavInfo,
  type MultipartFile,
  type Upstream
} from './lib/inference'

/**
 * Managed inference: an OpenAI-compatible facade in front of the model providers the operator
 * configured for this instance. Clients authenticate with their Clerk session JWT (as the bearer
 * token, exactly where an API key would go), the account's tier decides the allowance, and the
 * provider credentials never leave the deployment's environment variables.
 *
 * Mounted in convex/http.ts at /v1/models, /v1/audio/transcriptions and /v1/chat/completions.
 */

const JSON_HEADERS = { 'content-type': 'application/json' }

async function identityOf(ctx: ActionCtx): Promise<{ subject: string } | null> {
  const subject = await subjectOf(ctx.auth)
  return subject ? { subject } : null
}

function modelNotFound(requested: string, available: string): Response {
  return gatewayError(
    404,
    'model_not_found',
    `Unknown model "${requested}". Available models: ${available}`
  )
}

export const models = httpAction(async (ctx) => {
  if (!(await identityOf(ctx))) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  return new Response(JSON.stringify(modelsPayload(readUpstreams(process.env))), {
    status: 200,
    headers: JSON_HEADERS
  })
})

export const transcriptions = httpAction(async (ctx, request) => {
  const identity = await identityOf(ctx)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(process.env).stt
  if (!upstream)
    return gatewayError(503, 'not_configured', 'This Murmur instance does not offer a managed speech model')

  const contentType = request.headers.get('content-type')
  const body = new Uint8Array(await request.arrayBuffer())
  let fields: Record<string, string[]> = {}
  let file: MultipartFile | undefined
  if (multipartBoundary(contentType)) {
    let parsed
    try {
      parsed = parseMultipart(body, contentType)
    } catch (err) {
      return gatewayError(400, 'bad_request', err instanceof Error ? err.message : 'Malformed multipart body')
    }
    fields = parsed.fields
    file = parsed.files.find((f) => f.name === 'file') ?? parsed.files[0]
  } else if (contentType && /^audio\//i.test(contentType) && body.length) {
    // curl-friendly form: the raw clip as the body, the parameters in the query string.
    const params = new URL(request.url).searchParams
    for (const [key, value] of params) (fields[key] ??= []).push(value)
    file = { name: 'file', filename: 'audio.wav', type: contentType, data: body }
  } else {
    return gatewayError(400, 'bad_request', 'Send multipart/form-data with a "file" part, or raw audio/* with parameters in the query string')
  }
  if (!file || !file.data.length) return gatewayError(400, 'bad_request', 'No audio file in the request')
  const requested = fields.model?.[0] ?? ''
  if (requested !== MURMUR_MODELS.stt) return modelNotFound(requested, MURMUR_MODELS.stt)

  const seconds = clipSeconds(file.data)
  const gate = await ctx.runMutation(internal.inference.authorize, {
    clerkId: identity.subject,
    kind: 'stt',
    seconds
  })
  if (!gate.ok) return limitError(gate.refusal, gate.plan, gate.planState, process.env)

  const form = new FormData()
  form.append(
    'file',
    new Blob([file.data as BlobPart], { type: file.type || 'audio/wav' }),
    file.filename || 'audio.wav'
  )
  form.append('model', upstreamModelFor(upstream, gate.plan))
  for (const [key, values] of Object.entries(fields)) {
    if (!STT_PASSTHROUGH_FIELDS.has(key)) continue
    for (const value of values) form.append(key, value)
  }
  const headers: Record<string, string> = {}
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${upstream.baseUrl}/audio/transcriptions`, { method: 'POST', headers, body: form })
  } catch (err) {
    console.error('[gateway] stt upstream unreachable', err instanceof Error ? err.message : err)
    return gatewayError(502, 'upstream_error', 'Could not reach the speech provider behind this instance')
  }
  const text = await res.text()
  if (!res.ok) {
    const failure = describeUpstreamFailure(res.status, text)
    console.warn(`[gateway] stt upstream ${res.status} -> ${failure.status} ${failure.code}`)
    return gatewayError(failure.status, failure.code, failure.message)
  }
  let json: { duration?: number } | undefined
  try {
    json = JSON.parse(text) as { duration?: number }
  } catch {
    json = undefined
  }
  const measured = wavInfo(file.data)?.durationSec
  const billed = measured ?? (typeof json?.duration === 'number' ? json.duration : seconds)
  const upstreamType = res.headers.get('content-type') ?? 'application/json'
  const words = transcriptWords(text, upstreamType)
  await ctx.runMutation(internal.inference.record, { userId: gate.userId, kind: 'stt', seconds: billed, words })
  console.log(
    `[gateway] stt plan=${gate.plan} seconds=${billed.toFixed(1)} words=${words} upstreamMs=${Date.now() - started}`
  )
  return new Response(text, { status: 200, headers: { 'content-type': upstreamType } })
})

/** Chat parameters a client may set; anything else (tools, n, streaming) is dropped. */
const CHAT_PASSTHROUGH = [
  'messages',
  'temperature',
  'top_p',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'response_format'
] as const

export const chatCompletions = httpAction(async (ctx, request) => {
  const identity = await identityOf(ctx)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(process.env).llm
  if (!upstream)
    return gatewayError(503, 'not_configured', 'This Murmur instance does not offer a managed formatting model')

  let input: Record<string, unknown>
  try {
    input = (await request.json()) as Record<string, unknown>
  } catch {
    return gatewayError(400, 'bad_request', 'Body must be JSON')
  }
  if (!input || typeof input !== 'object') return gatewayError(400, 'bad_request', 'Body must be a JSON object')
  const requested = typeof input.model === 'string' ? input.model : ''
  if (requested !== MURMUR_MODELS.llm) return modelNotFound(requested, MURMUR_MODELS.llm)
  if (!Array.isArray(input.messages) || input.messages.length === 0)
    return gatewayError(400, 'bad_request', '"messages" must be a non-empty array')

  const gate = await ctx.runMutation(internal.inference.authorize, { clerkId: identity.subject, kind: 'llm' })
  if (!gate.ok) return limitError(gate.refusal, gate.plan, gate.planState, process.env)

  const outbound: Record<string, unknown> = { model: upstreamModelFor(upstream, gate.plan), stream: false }
  for (const key of CHAT_PASSTHROUGH) if (input[key] !== undefined) outbound[key] = input[key]
  const requestedMax = typeof input.max_tokens === 'number' ? input.max_tokens : 1024
  outbound.max_tokens = Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(requestedMax)))
  const requestBody = JSON.stringify(outbound)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${upstream.baseUrl}/chat/completions`, { method: 'POST', headers, body: requestBody })
  } catch (err) {
    console.error('[gateway] llm upstream unreachable', err instanceof Error ? err.message : err)
    return gatewayError(502, 'upstream_error', 'Could not reach the model provider behind this instance')
  }
  const text = await res.text()
  if (!res.ok) {
    const failure = describeUpstreamFailure(res.status, text)
    console.warn(`[gateway] llm upstream ${res.status} -> ${failure.status} ${failure.code}`)
    return gatewayError(failure.status, failure.code, failure.message)
  }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return gatewayError(502, 'upstream_error', 'The model provider returned a malformed answer')
  }
  const tokens = tokensUsed(
    json.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined,
    requestBody.length,
    text.length
  )
  await ctx.runMutation(internal.inference.record, { userId: gate.userId, kind: 'llm', tokens })
  console.log(`[gateway] llm plan=${gate.plan} tokens=${tokens} upstreamMs=${Date.now() - started}`)
  // The upstream model is the instance's business; clients asked for the Murmur alias.
  return new Response(JSON.stringify({ ...json, model: MURMUR_MODELS.llm }), { status: 200, headers: JSON_HEADERS })
})

/**
 * Murmur's formatting endpoint: the transcript and the dictation's context in, the text to insert
 * out. The text engine (packages/text-engine) builds the prompt, verifies the answer, retries once
 * in strict mode and falls back to its rule-based cleanup; every model round trip is billed.
 *
 *   POST /v1/format
 *   { transcript, context: { category, tone, app?, language?, precedingText?, instructions?,
 *                           dictionary?: [{ word, aliases }], keepVerbatim?: [] } }
 *   -> { text, pressEnter, status, modelText?, llmMs, stages, model }
 */
export const format = httpAction(async (ctx, request) => {
  const identity = await identityOf(ctx)
  if (!identity) return gatewayError(401, 'unauthorized', 'Sign in to use Murmur models')
  const upstream = readUpstreams(process.env).llm
  if (!upstream)
    return gatewayError(503, 'not_configured', 'This Murmur instance does not offer a managed formatting model')

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return gatewayError(400, 'bad_request', 'Body must be JSON')
  }
  const parsed = parseFormatRequest(input)
  if (!parsed.ok) return gatewayError(400, 'bad_request', parsed.message)

  const gate = await ctx.runMutation(internal.inference.authorize, {
    clerkId: identity.subject,
    kind: 'llm',
    degradable: true
  })
  if (!gate.ok) return limitError(gate.refusal, gate.plan, gate.planState, process.env)

  const model = upstreamModelFor(upstream, gate.plan)
  let tokens = 0
  let calls = 0
  const started = Date.now()
  const complete = async (messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> => {
    calls++
    const res = await upstreamChat(upstream, model, messages, opts)
    tokens += res.tokens
    return res.result
  }
  // Past Pro's soft fair-use cap the engine runs without a model: rule-based text, never an error.
  const formatted = await formatTranscript(
    { transcript: parsed.request.transcript, mode: 'smart', context: parsed.request.context },
    gate.paused ? null : complete
  )
  if (calls > 0) await ctx.runMutation(internal.inference.record, { userId: gate.userId, kind: 'llm', tokens })
  console.log(
    `[gateway] format plan=${gate.plan} outcome=${formatted.status.outcome} attempts=${formatted.status.attempts} tokens=${tokens} paused=${gate.paused !== null} ms=${Date.now() - started}`
  )
  const body = gate.paused
    ? {
        ...formatted,
        status: { ...formatted.status, detail: 'fair use' },
        limit: limitDetail(gate.paused, gate.plan, gate.planState, process.env),
        model: MURMUR_MODELS.llm
      }
    : { ...formatted, model: MURMUR_MODELS.llm }
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS })
})

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message)
  }
}

/** One chat completion against the instance's model; throws an `UpstreamError` the engine reports as a failure. */
async function upstreamChat(
  upstream: Upstream,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions
): Promise<{ result: ChatResult; tokens: number }> {
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: Math.max(1, Math.min(MAX_COMPLETION_TOKENS, Math.floor(opts.maxTokens ?? 1024))),
    stream: false
  })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`
  let res: Response
  try {
    res = await fetch(`${upstream.baseUrl}/chat/completions`, { method: 'POST', headers, body })
  } catch (err) {
    console.error('[gateway] llm upstream unreachable', err instanceof Error ? err.message : err)
    throw new UpstreamError('Could not reach the model provider behind this instance', 502, 'upstream_error')
  }
  const text = await res.text()
  if (!res.ok) {
    const failure = describeUpstreamFailure(res.status, text)
    console.warn(`[gateway] llm upstream ${res.status} -> ${failure.status} ${failure.code}`)
    throw new UpstreamError(failure.message, failure.status, failure.code)
  }
  let json: {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; finish_reason?: string }>
    usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new UpstreamError('The model provider returned a malformed answer', 502, 'upstream_error')
  }
  const choice = json.choices?.[0]
  const content = choice?.message?.content
  const answer = Array.isArray(content) ? content.map((c) => c.text ?? '').join('') : (content ?? '')
  return {
    result: { text: answer, finishReason: choice?.finish_reason, model, usage: json.usage },
    tokens: tokensUsed(json.usage, body.length, text.length)
  }
}
