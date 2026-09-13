import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatTranscript } from '../src/format'
import type { ChatMessage, ChatOptions, ChatResult } from '../src/types'
import { contextOf, loadFixtures, scoreText, summarize, type Score } from './score'

/**
 * The corpus against a real model:
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=https://api.groq.com/openai/v1 MURMUR_API_KEY=... \
 *   MURMUR_LLM_MODEL=openai/gpt-oss-20b npm run test:live
 *
 * Prints a per-fixture report, writes eval/last-run.json (ignored by git) with every prompt,
 * answer and verdict, and fails when fewer than MURMUR_EVAL_MIN_PASS (default 0.8) of the fixtures
 * pass. The gate is a floor, not a target: read the report.
 */

const baseUrl = process.env.MURMUR_BASE_URL ?? ''
const apiKey = process.env.MURMUR_API_KEY ?? ''
const model = process.env.MURMUR_LLM_MODEL ?? ''
const enabled = !!process.env.MURMUR_LIVE && !!baseUrl && !!model
const minPass = Number(process.env.MURMUR_EVAL_MIN_PASS ?? '0.8')

async function complete(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1024,
      stream: false
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    usage?: ChatResult['usage']
  }
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    finishReason: json.choices?.[0]?.finish_reason,
    usage: json.usage
  }
}

describe.skipIf(!enabled)('eval corpus (live)', () => {
  it(`passes at least ${Math.round(minPass * 100)}% of the fixtures with ${model}`, async () => {
    const fixtures = loadFixtures()
    const scores: Score[] = []
    const runs: unknown[] = []
    let totalMs = 0
    for (const f of fixtures) {
      const result = await formatTranscript(
        { transcript: f.transcript, mode: 'smart', context: contextOf(f) },
        complete
      )
      totalMs += result.llmMs
      const score = scoreText(f, result.text, result)
      if (result.status.outcome !== 'used')
        score.checks.push({
          name: 'model used',
          pass: false,
          detail: JSON.stringify(result.status)
        })
      score.pass = score.checks.every((c) => c.pass)
      scores.push(score)
      runs.push({ id: f.id, transcript: f.transcript, result, score })
      console.log(
        `${score.pass ? 'ok  ' : 'FAIL'} ${f.id} (${result.llmMs} ms, ${result.status.outcome}${result.status.attempts > 1 ? `, ${result.status.attempts} attempts` : ''}) -> ${JSON.stringify(result.text)}`
      )
    }
    const dir = resolve(__dirname)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'last-run.json'),
      JSON.stringify({ model, at: new Date().toISOString(), totalMs, runs }, null, 2)
    )
    const report = summarize(scores)
    console.log(
      `\n[live] ${model}: ${report}\n[live] mean latency ${Math.round(totalMs / fixtures.length)} ms`
    )
    const rate = scores.filter((s) => s.pass).length / scores.length
    expect(rate, report).toBeGreaterThanOrEqual(minPass)
  })
})
