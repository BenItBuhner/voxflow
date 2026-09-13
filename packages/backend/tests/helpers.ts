import { convexTest } from 'convex-test'
import type { UserIdentity } from 'convex/server'
import { vi } from 'vitest'
import schema from '../convex/schema'

export const modules = import.meta.glob('../convex/**/*.*s')

export function setup() {
  return convexTest(schema, modules)
}

export const ada: Partial<UserIdentity> = {
  subject: 'user_ada',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  pictureUrl: 'https://img.clerk.com/ada.png'
}

export const bob: Partial<UserIdentity> = {
  subject: 'user_bob',
  email: 'bob@example.com',
  givenName: 'Bob',
  familyName: 'Builder'
}

// ---- managed inference gateway -----------------------------------------------------------------

/** A PCM WAV header followed by `seconds` of silence. */
export function makeWav(seconds: number, sampleRate = 16_000, channels = 1, bits = 16): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate * channels * (bits / 8))
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * channels * bits) / 8, true)
  view.setUint16(32, (channels * bits) / 8, true)
  view.setUint16(34, bits, true)
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  // Bytes that look like multipart syntax must survive inside the binary part.
  const marker = new TextEncoder().encode('\r\n--boundary--\r\n')
  if (dataBytes > marker.length * 2) out.set(marker, 44 + Math.floor(dataBytes / 2))
  return out
}

export const STT_ENV = {
  MURMUR_INFERENCE_STT_URL: 'https://stt.example.test/v1/',
  MURMUR_INFERENCE_STT_KEY: 'sk-stt-secret',
  MURMUR_INFERENCE_STT_MODEL: 'whisper-large-v3-turbo'
}
export const LLM_ENV = {
  MURMUR_INFERENCE_LLM_URL: 'https://llm.example.test/v1',
  MURMUR_INFERENCE_LLM_KEY: 'sk-llm-secret',
  MURMUR_INFERENCE_LLM_MODEL: 'llama-3.1-8b-instant',
  MURMUR_INFERENCE_LLM_PRO_MODEL: 'llama-3.3-70b-versatile'
}

export function stubEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
}

export interface Captured {
  url: string
  init: RequestInit
}

/** Replace global fetch with a recorder that answers with `respond`. */
export function stubFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>
): Captured[] {
  const calls: Captured[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      return await respond(url, init)
    })
  )
  return calls
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function sttRequest(
  wav: Uint8Array,
  extra: Record<string, string | string[]> = {},
  model = 'murmur-transcribe'
): Promise<RequestInit> {
  const form = new FormData()
  form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  for (const [k, v] of Object.entries(extra))
    for (const value of Array.isArray(v) ? v : [v]) form.append(k, value)
  // Let the platform serialize the multipart body and pick the boundary, as the apps do.
  const req = new Request('https://client.test/', { method: 'POST', body: form })
  return {
    method: 'POST',
    headers: { 'content-type': req.headers.get('content-type')! },
    body: await req.arrayBuffer()
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json' }

/** A `/v1/chat/completions` request as the apps send it. */
export function chatRequest(content = 'hello there'): RequestInit {
  return {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: 'murmur-format', messages: [{ role: 'user', content }] })
  }
}

/** A `/v1/format` request as the apps send it. */
export function formatRequest(
  transcript: string,
  context: Record<string, unknown> = {}
): RequestInit {
  return {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      transcript,
      context: { category: 'chat', tone: 'casual', app: 'Slack', ...context }
    })
  }
}

/** An upstream chat completion answering `content`. */
export const chatAnswer = (content: string, finish = 'stop', tokens = 40): Response =>
  jsonResponse({
    choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: tokens - 5, completion_tokens: 5, total_tokens: tokens }
  })
