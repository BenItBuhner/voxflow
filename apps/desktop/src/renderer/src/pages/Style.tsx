import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Play, Plus, Sparkles, Trash2, WandSparkles } from 'lucide-react'
import type { AppRule, FormattingMode, Tone } from '@shared/settings'
import { LLM_INSTRUCTIONS_MAX } from '@shared/settings'
import { MURMUR_LLM_MODEL } from '@shared/inference'
import type { LlmStatus, PreviewResult, ProviderTestResult } from '@shared/types'
import { LLM_PRESETS } from '@core/stt/presets'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Badge, Segmented } from '@renderer/components/ui/misc'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { ModelField, SecretInput, TestResult } from '@renderer/components/ProviderForm'
import { planTitle, useInference } from '@renderer/hooks/useInference'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn, uid } from '@renderer/lib/utils'

/** The Murmur entry of the formatting-model server picker; only offered by cloud builds. */
const MURMUR_LLM_PRESET = { id: 'murmur', name: 'Murmur (included with your account)' }

// ---- option catalogues -----------------------------------------------------------------------

interface Level<T extends string> {
  value: T
  label: string
  hint: string
}

const TONES: Level<Tone>[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Casual in chat apps, professional in email and documents, neutral elsewhere.'
  },
  { value: 'casual', label: 'Casual', hint: 'Relaxed, contractions, fragments are fine.' },
  { value: 'neutral', label: 'Neutral', hint: 'Clean sentences, faithful to how you talk.' },
  { value: 'professional', label: 'Professional', hint: 'Complete sentences, no slang.' }
]

const MODES: Level<FormattingMode>[] = [
  { value: 'off', label: 'Off', hint: 'Insert exactly what the speech model heard.' },
  {
    value: 'light',
    label: 'Light',
    hint: 'Rules only, instant: filler sounds, spoken commands, casing, punctuation spacing and your dictionary. Numbers and phrasing stay as heard.'
  },
  {
    value: 'smart',
    label: 'Smart',
    hint: 'The formatting model turns the raw transcript into what you meant to type: fillers, stumbles and self-corrections go, numbers and lists are written the way a person types them, and the result is checked so that nothing you said, and no number, is changed or lost. If the model misbehaves or is slow, the Light result goes in.'
  }
]

function LevelRow<T extends string>({
  title,
  levels,
  value,
  onChange
}: {
  title: React.ReactNode
  levels: Level<T>[]
  value: T
  onChange: (v: T) => void
}): React.JSX.Element {
  const current = levels.find((l) => l.value === value)
  return (
    <SettingRow title={title} description={current?.hint}>
      <Segmented<T>
        value={value}
        onChange={onChange}
        options={levels.map(({ value: v, label }) => ({ value: v, label }))}
      />
    </SettingRow>
  )
}

/** Local text state that follows `source` whenever it changes (e.g. after a sync), without effects. */
function useSyncedText(source: string): [string, (v: string) => void] {
  const [text, setText] = useState(source)
  const [seen, setSeen] = useState(source)
  if (seen !== source) {
    setSeen(source)
    setText(source)
  }
  return [text, setText]
}

// ---- page ------------------------------------------------------------------------------------

export function StylePage(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const inference = useInference()
  const f = settings.formatting
  const murmurLlm = inference.routing.llm === 'murmur'
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [llmPreset, setLlmPreset] = useState(() =>
    inference.offersMurmur && f.llm.source === 'murmur'
      ? MURMUR_LLM_PRESET.id
      : f.llm.sameAsStt
        ? 'same'
        : 'custom'
  )
  const [instructions, setInstructions] = useSyncedText(f.instructions)
  const serverOptions = inference.offersMurmur ? [MURMUR_LLM_PRESET, ...LLM_PRESETS] : LLM_PRESETS

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setDiscoverError(undefined)
    const r = await window.murmur.llm.listModels()
    setDiscovering(false)
    if (r.ok) setDiscovered(r.models)
    else setDiscoverError(r.error)
  }
  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    const r = await window.murmur.llm.test()
    setTesting(false)
    setResult(r)
  }
  const choosePreset = (id: string): void => {
    setLlmPreset(id)
    if (id === MURMUR_LLM_PRESET.id) {
      void patch({ formatting: { llm: { source: 'murmur' } } })
      return
    }
    const p = LLM_PRESETS.find((x) => x.id === id)!
    if (id === 'same') void patch({ formatting: { llm: { source: 'custom', sameAsStt: true } } })
    else
      void patch({
        formatting: {
          llm: {
            source: 'custom',
            sameAsStt: false,
            baseUrl: p.baseUrl,
            model: p.defaultModel || f.llm.model
          }
        }
      })
  }
  const saveInstructions = (): void => {
    const next = instructions.slice(0, LLM_INSTRUCTIONS_MAX)
    if (next !== f.instructions) void patch({ formatting: { instructions: next } })
  }

  const addRule = (): void => {
    const rule: AppRule = { id: uid(), match: '', tone: 'auto' }
    void patch({ formatting: { appRules: [...f.appRules, rule] } })
  }
  const updateRule = (id: string, partial: Partial<AppRule>): void => {
    void patch({
      formatting: {
        appRules: f.appRules.map((r) => {
          if (r.id !== id) return r
          const next: AppRule = { ...r, ...partial }
          // Optional overrides are removed, not set to undefined, so sync sees a clean record.
          for (const key of Object.keys(partial) as Array<keyof AppRule>) {
            if (partial[key] === undefined) delete next[key]
          }
          return next
        })
      }
    })
  }
  const removeRule = (id: string): void =>
    void patch({ formatting: { appRules: f.appRules.filter((r) => r.id !== id) } })

  const modelReady = inference.llmReady

  return (
    <div className="space-y-section">
      <PageHeader
        title="Style"
        description="How raw speech becomes finished text. The formatting model reads the destination on its own: chat stays casual, email gets full sentences, code editors keep identifiers exact, terminals get one line. What is left to choose is how it should sound and anything you want to tell it."
      />

      <Section title="Formatting">
        <LevelRow
          title="Mode"
          levels={MODES}
          value={f.mode}
          onChange={(v) => void patch({ formatting: { mode: v } })}
        />
        <LevelRow
          title="Tone"
          levels={TONES}
          value={f.tone}
          onChange={(v) => void patch({ formatting: { tone: v } })}
        />
        <SettingRow
          title="Your instructions"
          description={`Told to the model on every dictation, ahead of the tone. Per-app rules below can add more. ${instructions.length}/${LLM_INSTRUCTIONS_MAX}`}
          vertical
        >
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value.slice(0, LLM_INSTRUCTIONS_MAX))}
            onBlur={saveInstructions}
            placeholder={
              'Use British spelling.\nWrite dates as 2026-09-06.\nNever use the Oxford comma.\nKeep my sign-off exactly as I say it.'
            }
            className="min-h-24 text-note"
            spellCheck={false}
          />
        </SettingRow>
        <SettingRow
          title="Trailing space"
          description="Add a space after each dictation so the next one flows on naturally. Text that ends with a line break is left alone."
        >
          <Switch
            checked={f.trailingSpace}
            onCheckedChange={(v) => void patch({ formatting: { trailingSpace: v } })}
          />
        </SettingRow>
      </Section>

      <Section
        title="Formatting model"
        description={
          murmurLlm
            ? 'The formatting model that comes with your account. It receives the raw transcript together with where the text is going, and its answer is verified before anything is inserted.'
            : 'An OpenAI-compatible chat model. Fast small models (Groq gpt-oss-20b, gpt-4o-mini, Cerebras) keep the round trip under a second. It receives the raw transcript together with where the text is going, and its answer is verified before anything is inserted.'
        }
      >
        <SettingRow
          title="Server"
          description={
            llmPreset === 'same' && murmurLlm
              ? 'Follows your speech model, which is Murmur’s.'
              : undefined
          }
        >
          <Select value={llmPreset} onValueChange={choosePreset}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {serverOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {murmurLlm ? (
          <SettingRow
            title="Model"
            description={
              inference.signedIn
                ? `Provided by this Murmur instance on your ${planTitle(inference.planState)}.`
                : 'Sign in to use Murmur models.'
            }
          >
            <Badge variant="outline" className="font-mono">
              {inference.status?.models.llm ?? MURMUR_LLM_MODEL}
            </Badge>
          </SettingRow>
        ) : (
          <>
            {!f.llm.sameAsStt && (
              <>
                <SettingRow title="Base URL" vertical>
                  <Input
                    value={f.llm.baseUrl}
                    onChange={(e) =>
                      void patch({ formatting: { llm: { baseUrl: e.target.value.trim() } } })
                    }
                    placeholder="https://api.example.com/v1"
                    className="font-mono text-note"
                    spellCheck={false}
                  />
                </SettingRow>
                <SettingRow title="API key" vertical>
                  <SecretInput slot="llm" />
                </SettingRow>
              </>
            )}
            <SettingRow title="Model" vertical>
              <div className="w-full">
                <ModelField
                  value={f.llm.model}
                  onChange={(m) => void patch({ formatting: { llm: { model: m } } })}
                  known={LLM_PRESETS.find((p) => p.id === llmPreset)?.models ?? []}
                  discovered={discovered}
                  discovering={discovering}
                  onDiscover={discover}
                  discoverError={discoverError}
                  placeholder="e.g. openai/gpt-oss-20b"
                />
              </div>
            </SettingRow>
          </>
        )}
        <SettingRow
          title="Timeout"
          description="If the model is slower than this, the Light result is inserted instead."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={60}
              className="w-20 text-right"
              value={Math.round(f.llm.timeoutMs / 1000)}
              onChange={(e) =>
                void patch({
                  formatting: { llm: { timeoutMs: Math.max(1000, Number(e.target.value) * 1000) } }
                })
              }
            />
            <span className="text-sm text-muted-foreground">s</span>
          </div>
        </SettingRow>
        <SettingRow
          title="Test model"
          description="Sends a messy sentence and checks that it comes back clean."
          vertical
        >
          <div className="flex w-full items-center gap-3">
            <Button onClick={test} disabled={testing || !modelReady}>
              {testing ? <Loader2 className="animate-spin" /> : <Play />} Run test
            </Button>
            {!modelReady && (
              <span className="text-note text-muted-foreground">
                {murmurLlm ? 'Sign in first.' : 'Choose a server and model first.'}
              </span>
            )}
          </div>
          {result && (
            <div className="w-full">
              <TestResult
                result={result}
                onPickModel={(m) => void patch({ formatting: { llm: { model: m } } })}
              />
            </div>
          )}
        </SettingRow>
      </Section>

      <Section
        title="Per-app rules"
        description="Match on the window title or process name; the first matching rule wins. Anything left on “Default” follows the settings above."
        actions={
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus /> Add rule
          </Button>
        }
      >
        {f.appRules.length === 0 ? (
          <div className="py-2 text-note text-muted-foreground">
            No rules. Examples: “slack” → casual; “Code.exe” → formatting off; “outlook” →
            professional with extra instructions.
          </div>
        ) : (
          f.appRules.map((r) => (
            <RuleEditor key={r.id} rule={r} onChange={updateRule} onRemove={removeRule} />
          ))
        )}
      </Section>

      <Playground modelReady={modelReady && f.mode === 'smart'} />
    </div>
  )
}

// ---- per-app rule ----------------------------------------------------------------------------

function RuleSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  width = 'w-40'
}: {
  label: string
  value: T | undefined
  options: Array<{ value: T; label: string }>
  onChange: (v: T | undefined) => void
  width?: string
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 eyebrow">
      {label}
      <Select
        value={value ?? 'inherit'}
        onValueChange={(v) => onChange(v === 'inherit' ? undefined : (v as T))}
      >
        <SelectTrigger className={cn(width, 'normal-case tracking-normal')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Default</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

function RuleEditor({
  rule: r,
  onChange,
  onRemove
}: {
  rule: AppRule
  onChange: (id: string, partial: Partial<AppRule>) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const [instructions, setInstructions] = useSyncedText(r.instructions ?? '')
  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <Input
          value={r.match}
          placeholder="slack, outlook, Code.exe…"
          onChange={(e) => onChange(r.id, { match: e.target.value })}
          className="flex-1"
        />
        <Button variant="ghost" size="icon-sm" onClick={() => onRemove(r.id)} title="Remove rule">
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <RuleSelect
          label="Tone"
          value={r.tone === 'auto' ? undefined : r.tone}
          options={TONES.filter((t) => t.value !== 'auto').map(({ value, label }) => ({
            value,
            label
          }))}
          onChange={(v) => onChange(r.id, { tone: v ?? 'auto' })}
          width="w-36"
        />
        <RuleSelect
          label="Mode"
          value={r.formatting}
          options={MODES.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => onChange(r.id, { formatting: v })}
          width="w-32"
        />
        <label className="flex flex-col gap-1.5 eyebrow">
          Trailing space
          <Select
            value={r.trailingSpace === undefined ? 'inherit' : r.trailingSpace ? 'on' : 'off'}
            onValueChange={(v) =>
              onChange(r.id, { trailingSpace: v === 'inherit' ? undefined : v === 'on' })
            }
          >
            <SelectTrigger className="w-32 normal-case tracking-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Default</SelectItem>
              <SelectItem value="on">On</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <Input
        value={instructions}
        onChange={(e) => setInstructions(e.target.value.slice(0, LLM_INSTRUCTIONS_MAX))}
        onBlur={() => {
          const next = instructions.trim()
          if (next !== (r.instructions ?? '')) onChange(r.id, { instructions: next || undefined })
        }}
        placeholder="Extra model instructions for this app only, e.g. “Keep it to one short paragraph.”"
        className="text-note"
      />
    </div>
  )
}

// ---- playground ------------------------------------------------------------------------------

const SAMPLE =
  'um so okay here are three things for today, first finish the the deck, second email the vendor about, you know, the one million two hundred thousand dollar quote, and third book the flights for, I mean, twenty five people at five pm, no, six pm'

function outcomeBadge(status: LlmStatus): React.JSX.Element {
  switch (status.outcome) {
    case 'used':
      return status.retriedAfter ? (
        <Badge variant="success" title={`First answer rejected: ${status.retriedAfter}`}>
          model used · after a strict retry
        </Badge>
      ) : (
        <Badge variant="success">model used</Badge>
      )
    case 'rejected':
      return <Badge variant="destructive">model rejected: {status.detail}</Badge>
    case 'failed':
      return <Badge variant="destructive">model failed: {status.detail}</Badge>
    default:
      return <Badge variant="outline">model skipped: {status.detail}</Badge>
  }
}

function Playground({ modelReady }: { modelReady: boolean }): React.JSX.Element {
  const [raw, setRaw] = useState(SAMPLE)
  const [app, setApp] = useState('')
  const [out, setOut] = useState<PreviewResult | null>(null)
  const [running, setRunning] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    if (!raw.trim()) {
      requestId.current++
      return
    }
    const id = ++requestId.current
    const t = setTimeout(() => {
      void window.murmur.pipeline.preview({ raw, app }).then((r) => {
        if (requestId.current === id)
          setOut((prev) => (prev?.smart ? { ...r, smart: undefined } : r))
      })
    }, 150)
    return () => clearTimeout(t)
  }, [raw, app])

  const runModel = async (): Promise<void> => {
    setRunning(true)
    const id = ++requestId.current
    try {
      const r = await window.murmur.pipeline.preview({ raw, app, smart: true })
      if (requestId.current === id) setOut(r)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Section
      title="Try it"
      description="Paste a messy transcript to see what Light mode inserts, which settings apply for a given app, and what the model makes of it."
    >
      <div className="space-y-4 py-1">
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="min-h-24 text-note"
          placeholder="Type or paste a raw transcript…"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-note text-muted-foreground">
            As if dictating into
            <Input
              value={app}
              onChange={(e) => setApp(e.target.value)}
              placeholder="any text field"
              className="w-44"
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={runModel}
            disabled={!modelReady || running || !raw.trim()}
            title={modelReady ? undefined : 'Choose Smart mode and configure a model first'}
          >
            {running ? <Loader2 className="animate-spin" /> : <Sparkles />} Run with model
          </Button>
        </div>

        {out && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-caption">
              <Badge variant="outline">
                {out.style.category === 'unknown' ? 'text field' : out.style.category}
              </Badge>
              {out.style.ruleMatch && (
                <Badge variant="secondary">rule “{out.style.ruleMatch}”</Badge>
              )}
              <Badge variant="secondary">tone {out.style.tone}</Badge>
              <Badge variant="secondary">mode {out.style.mode}</Badge>
            </div>

            <div>
              <div className="mb-1.5 flex items-center gap-2 eyebrow">
                <WandSparkles className="size-3.5" /> Light
                <span className="normal-case tracking-normal font-normal">
                  · {out.light.wordCount} words
                  {out.light.pressEnter && ' · presses Enter'}
                </span>
              </div>
              <div className="well whitespace-pre-wrap rounded-md px-3.5 py-2.5 text-note">
                {out.light.text || (
                  <span className="text-muted-foreground">(nothing to insert)</span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {out.light.stages.length === 0 ? (
                  <span className="text-caption text-muted-foreground">
                    No stage changed the text.
                  </span>
                ) : (
                  out.light.stages.map((s) => (
                    <Badge key={s} variant="outline">
                      {s}
                    </Badge>
                  ))
                )}
              </div>
            </div>

            {out.smart && (
              <div>
                <div className="mb-1.5 flex items-center gap-2 eyebrow">
                  <Sparkles className="size-3.5" /> Smart
                  <span className="normal-case tracking-normal font-normal">
                    · {out.smart.llmMs} ms
                    {out.smart.status.attempts && out.smart.status.attempts > 1
                      ? ` · ${out.smart.status.attempts} attempts`
                      : ''}
                  </span>
                  {outcomeBadge(out.smart.status)}
                </div>
                {(out.smart.text || out.smart.modelText) && (
                  <div className="well whitespace-pre-wrap rounded-md px-3.5 py-2.5 text-note">
                    {out.smart.text ?? out.smart.modelText}
                  </div>
                )}
                {out.smart.status.outcome === 'rejected' && out.smart.modelText && (
                  <p className="mt-1 text-meta text-muted-foreground">
                    This is what the model returned; the Light text above would have been inserted.
                  </p>
                )}
                {out.smart.stages.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {out.smart.stages.map((s) => (
                      <Badge key={s} variant="outline">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  )
}
