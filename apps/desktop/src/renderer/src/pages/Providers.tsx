import React, { useEffect, useMemo, useState } from 'react'
import { Check, Cloud, ExternalLink, KeyRound, Loader2, Play } from 'lucide-react'
import type { ProviderTestResult } from '@shared/types'
import type { InferenceSource } from '@shared/inference'
import { STT_PRESETS, findPreset } from '@core/stt/presets'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Badge, Banner } from '@renderer/components/ui/misc'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { ModelField, SecretInput, TestResult } from '@renderer/components/ProviderForm'
import { LanguageSelect } from '@renderer/components/LanguageSelect'
import {
  minutesLabel,
  planTitle,
  useInference,
  type InferenceView
} from '@renderer/hooks/useInference'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn } from '@renderer/lib/utils'
import { planStateLabel } from '@shared/limits'

export function ProvidersPage({
  embedded,
  onReady
}: {
  embedded?: boolean
  onReady?: (ok: boolean) => void
}): React.JSX.Element {
  const { settings, patch } = useSettings()
  const inference = useInference()
  const stt = settings.stt
  const murmur = inference.routing.stt === 'murmur'

  return (
    <div className="space-y-section">
      {!embedded && (
        <PageHeader
          title="Models"
          description={
            inference.offersMurmur
              ? 'Where your audio goes to become text: the models that come with your account, or a provider you run or pay for yourself.'
              : 'Where your audio goes to become text. Everything runs against your own account or your own machine.'
          }
        />
      )}

      {inference.offersMurmur && (
        <SourceChooser
          value={stt.source}
          inference={inference}
          onChange={(source) => void patch({ stt: { source } })}
        />
      )}
      {inference.cloudEnabled && !inference.managedAvailable && (
        <Banner tone="neutral" className="text-note text-muted-foreground">
          This Murmur instance does not provide speech models of its own, so Murmur uses the
          provider you connect here.
        </Banner>
      )}

      {murmur ? (
        <MurmurSpeechSection inference={inference} onReady={onReady} />
      ) : (
        <OwnProviderSection onReady={onReady} />
      )}

      <Section title="Recognition">
        <SettingRow
          title="Language"
          description="Locks the speech model to one language: faster, more accurate, and no surprise switches on unclear words. The formatting model is told the same language. Auto-detect handles code-switching."
        >
          <LanguageSelect />
        </SettingRow>
        <SettingRow
          title="Bias with dictionary"
          description="Sends your dictionary and snippet triggers as a prompt so rare words are spelled right the first time."
        >
          <Switch
            checked={stt.useDictionaryPrompt}
            onCheckedChange={(v) => void patch({ stt: { useDictionaryPrompt: v } })}
          />
        </SettingRow>
        <SettingRow title="Timeout" description="Give up on a transcription after this long.">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={2}
              max={120}
              className="w-20 text-right"
              value={Math.round(stt.timeoutMs / 1000)}
              onChange={(e) =>
                void patch({ stt: { timeoutMs: Math.max(2000, Number(e.target.value) * 1000) } })
              }
            />
            <span className="text-sm text-muted-foreground">s</span>
          </div>
        </SettingRow>
      </Section>

      {!embedded && (
        <div className="flex flex-wrap gap-2 text-meta text-muted-foreground">
          {murmur ? (
            <>
              <Badge variant="outline">murmur</Badge>
              {inference.status?.models.stt && (
                <Badge variant="outline">{inference.status.models.stt}</Badge>
              )}
              <Badge variant="success">{planTitle(inference.planState)}</Badge>
            </>
          ) : (
            <>
              <Badge variant="outline">{stt.kind}</Badge>
              {stt.model && <Badge variant="outline">{stt.model}</Badge>}
              {findPreset(stt.presetId).local && <Badge variant="success">local</Badge>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Murmur models vs. the user's own provider. Only rendered in builds that talk to an instance. */
function SourceChooser({
  value,
  inference,
  onChange
}: {
  value: InferenceSource
  inference: InferenceView
  onChange: (v: InferenceSource) => void
}): React.JSX.Element {
  const options: Array<{
    value: InferenceSource
    title: string
    description: string
    icon: React.ReactNode
    meta?: string
  }> = [
    {
      value: 'murmur',
      title: 'Murmur models',
      description:
        'Included with your account. Nothing to set up: your recording goes to this Murmur instance, which transcribes and formats it with the models it provides.',
      icon: <Cloud />,
      meta: inference.minutes
        ? `${planTitle(inference.planState)} · ${minutesLabel(inference.minutes)}`
        : planTitle(inference.planState)
    },
    {
      value: 'custom',
      title: 'Your own provider',
      description:
        'OpenAI, Groq, Deepgram, ElevenLabs or a local whisper server with your own key. Audio goes straight from this computer to that provider and never touches Murmur’s servers.',
      icon: <KeyRound />
    }
  ]
  // The choice shows as elevation: the selected source is a raised card, the other a well.
  return (
    <div role="radiogroup" aria-label="Speech model source" className="grid gap-3 sm:grid-cols-2">
      {options.map((o) => {
        const selected = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex flex-col gap-2 rounded-xl p-card text-left transition-[background-color,box-shadow] duration-200',
              selected ? 'surface-raised' : 'well text-muted-foreground hover:bg-accent'
            )}
          >
            <div className="flex items-center gap-2 text-sm font-medium [&>svg]:size-4 [&>svg]:text-muted-foreground">
              {o.icon}
              <span className={cn('flex-1', selected && 'text-foreground')}>{o.title}</span>
              {selected && <Check className="size-4 text-primary" />}
            </div>
            <p className="text-note leading-relaxed text-muted-foreground">{o.description}</p>
            {o.meta && <span className="text-meta text-muted-foreground">{o.meta}</span>}
          </button>
        )
      })}
    </div>
  )
}

function MurmurSpeechSection({
  inference,
  onReady
}: {
  inference: InferenceView
  onReady?: (ok: boolean) => void
}): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    const r = await window.murmur.stt.test()
    setTesting(false)
    setResult(r)
    onReady?.(r.ok)
  }
  const minutes = inference.minutes
  const share = minutes && minutes.limit > 0 ? Math.min(1, minutes.used / minutes.limit) : 0
  return (
    <Section title="Speech to text">
      <SettingRow
        title="Model"
        description="Provided by this Murmur instance for your account. Your dictionary still biases recognition, and everything below still applies."
      >
        <Badge variant="outline" className="font-mono">
          {inference.status?.models.stt ?? 'murmur-transcribe'}
        </Badge>
      </SettingRow>
      <SettingRow
        title="Plan"
        description={
          inference.signedIn
            ? minutes
              ? 'Transcription minutes reset at the start of every month.'
              : 'Waiting for your account status…'
            : 'Sign in to use Murmur models.'
        }
        vertical
      >
        <div className="flex w-full items-center gap-3">
          <Badge variant={inference.plan === 'pro' ? 'success' : 'secondary'}>
            {planStateLabel(inference.planState)}
          </Badge>
          {minutes && (
            <>
              <div className="well h-1.5 flex-1 overflow-hidden rounded-full">
                <div
                  className={cn(
                    'h-full rounded-full',
                    share >= 0.9 ? 'bg-destructive' : 'bg-primary'
                  )}
                  style={{ width: `${Math.max(2, share * 100)}%` }}
                />
              </div>
              <span className="text-meta tabular-nums text-muted-foreground">
                {minutesLabel(minutes)}
              </span>
            </>
          )}
        </div>
      </SettingRow>
      <SettingRow
        title="Test connection"
        description="Transcribes an 11-second built-in clip through Murmur so you can see real latency before you rely on it."
        vertical
      >
        <div className="flex w-full items-center gap-3">
          <Button onClick={test} disabled={testing || !inference.signedIn}>
            {testing ? <Loader2 className="animate-spin" /> : <Play />} Run test
          </Button>
          {!inference.signedIn && (
            <span className="text-note text-muted-foreground">Sign in first.</span>
          )}
        </div>
        {result && (
          <div className="w-full">
            <TestResult result={result} />
          </div>
        )}
      </SettingRow>
    </Section>
  )
}

/** The bring-your-own form: presets, base URL, key, model discovery, fallback and a live test. */
function OwnProviderSection({ onReady }: { onReady?: (ok: boolean) => void }): React.JSX.Element {
  const { settings, patch } = useSettings()
  const stt = settings.stt
  const preset = findPreset(stt.presetId)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)

  useEffect(() => {
    setDiscovered(null)
    setDiscoverError(undefined)
    setResult(null)
  }, [stt.baseUrl, stt.kind])

  const choosePreset = async (id: string): Promise<void> => {
    const p = findPreset(id)
    await patch({
      stt: { presetId: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.defaultModel }
    })
  }

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setDiscoverError(undefined)
    const r = await window.murmur.stt.listModels()
    setDiscovering(false)
    if (r.ok) {
      setDiscovered(r.models)
      if (!r.models.length)
        setDiscoverError('The server returned an empty model list; type the model id instead.')
    } else setDiscoverError(r.error)
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    const r = await window.murmur.stt.test()
    setTesting(false)
    setResult(r)
    onReady?.(r.ok)
  }

  const knownModels = useMemo(() => preset.models, [preset])
  const configured = !!stt.baseUrl && !!stt.model

  return (
    <Section title="Speech to text">
      <SettingRow
        title="Provider"
        description={
          preset.note ?? 'Pick a preset or point Murmur at any OpenAI-compatible server.'
        }
      >
        <Select value={stt.presetId} onValueChange={(v) => void choosePreset(v)}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STT_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Base URL"
        description={
          preset.local
            ? 'Your local server. No audio leaves this machine.'
            : 'Include the /v1 path if the server uses one.'
        }
        vertical
      >
        <Input
          value={stt.baseUrl}
          onChange={(e) => void patch({ stt: { baseUrl: e.target.value.trim() } })}
          placeholder="https://api.example.com/v1"
          className="font-mono text-note"
          spellCheck={false}
        />
      </SettingRow>
      <SettingRow
        title="API key"
        description={
          preset.requiresKey
            ? 'Stored encrypted with your OS keychain.'
            : 'Optional for local servers.'
        }
        vertical
      >
        <SecretInput slot="stt" />
      </SettingRow>
      <SettingRow title="Model" vertical>
        <div className="w-full">
          <ModelField
            value={stt.model}
            onChange={(m) => void patch({ stt: { model: m } })}
            known={knownModels}
            discovered={discovered}
            discovering={discovering}
            onDiscover={discover}
            discoverError={discoverError}
            label="Primary model"
          />
        </div>
      </SettingRow>
      <SettingRow
        title="Fallback model"
        description="Tried automatically when the primary model errors or times out."
        vertical
      >
        <div className="w-full">
          <ModelField
            value={stt.fallbackModel}
            onChange={(m) => void patch({ stt: { fallbackModel: m } })}
            known={knownModels.filter((m) => m !== stt.model)}
            discovered={discovered}
            discovering={discovering}
            onDiscover={discover}
            placeholder="none"
            label="Fallback (optional)"
          />
        </div>
      </SettingRow>
      <SettingRow
        title="Test connection"
        description="Transcribes an 11-second built-in clip so you can see real latency before you rely on it."
        vertical
      >
        <div className="flex w-full items-center gap-3">
          <Button onClick={test} disabled={testing || !configured}>
            {testing ? <Loader2 className="animate-spin" /> : <Play />} Run test
          </Button>
          {!configured && (
            <span className="text-note text-muted-foreground">
              Enter a base URL and model first.
            </span>
          )}
          {preset.docsUrl && (
            <Button
              variant="link"
              size="sm"
              className="ml-auto"
              onClick={() => void window.murmur.app.openExternal(preset.docsUrl!)}
            >
              Provider docs <ExternalLink />
            </Button>
          )}
        </div>
        {result && (
          <div className="w-full">
            <TestResult result={result} onPickModel={(m) => void patch({ stt: { model: m } })} />
          </div>
        )}
      </SettingRow>
    </Section>
  )
}
