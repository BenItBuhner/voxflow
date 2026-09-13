import React, { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { ArrowRight, Clock3, Flame, Gauge, Type } from 'lucide-react'
import type { HistoryEntry, OverlayState } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/input'
import { Badge, Banner, Card, CardContent } from '@renderer/components/ui/misc'
import { KeyCaps, platformFor } from '@renderer/components/KeyCaps'
import { Appear, CountUp, Rolling, arrive, item, leave, list } from '@renderer/components/motion'
import { UpdateBanner } from '@renderer/components/Updates'
import { useCloud } from '@renderer/hooks/useCloud'
import { useInference, type InferenceView } from '@renderer/hooks/useInference'
import { useSettings } from '@renderer/hooks/useSettings'
import { formatDuration, formatNumber, formatRelative } from '@renderer/lib/utils'
import { formatResetTime, meterValue } from '@shared/limits'
import type { Route } from '@renderer/components/Shell'

const TYPING_WPM = 40

/** A recent-list row: rises in a beat after the row above it (`custom` is its index). */
const row: Variants = {
  initial: { opacity: 0, y: 10 },
  enter: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.36, ease: arrive, delay: 0.05 + i * 0.045 }
  })
}

export function HomePage({
  state,
  onNavigate
}: {
  state: OverlayState
  onNavigate: (r: Route) => void
}): React.JSX.Element {
  const { settings, info } = useSettings()
  const { clerk, status } = useCloud()
  const inference = useInference()
  const [recent, setRecent] = useState<HistoryEntry[]>([])
  const platform = platformFor(info?.platform)
  const firstName = clerk.firstName ?? status?.user?.name?.split(' ')[0]

  useEffect(() => {
    const load = (): void => void window.murmur.history.list(5).then((r) => setRecent(r.entries))
    load()
    const unsubs = [
      window.murmur.history.onAdded((e) =>
        setRecent((prev) => [e, ...prev.filter((x) => x.id !== e.id)].slice(0, 5))
      ),
      window.murmur.history.onChanged(load)
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  const stats = settings.stats
  const speechMin = stats.totalSpeechMs / 60000
  const wpm = speechMin > 0 ? Math.round(stats.totalWords / speechMin) : 0
  const savedMs = Math.max(0, (stats.totalWords / TYPING_WPM) * 60000 - stats.totalSpeechMs)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const configured = inference.sttReady
  const murmurModels = inference.routing.stt === 'murmur'

  const lastLatency = useMemo(() => recent.find((e) => !e.error)?.timings, [recent])

  return (
    <div className="space-y-section">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="serif-display text-title">
            {greeting}
            {firstName ? `, ${firstName}` : ''}.
          </h1>
          <p className="mt-2.5 text-lead text-muted-foreground">
            Click into any text field, hold your shortcut, speak, let go.
          </p>
          <PlanLine inference={inference} onOpen={() => onNavigate('account')} />
        </div>
        <Badge
          variant={
            state.phase === 'listening'
              ? 'record'
              : state.phase === 'disabled'
                ? 'secondary'
                : 'success'
          }
          className="mt-3 h-6 px-2.5 text-xs transition-colors duration-300"
        >
          <Rolling
            text={
              state.phase === 'listening'
                ? 'Listening'
                : state.phase === 'processing'
                  ? 'Transcribing'
                  : state.phase === 'disabled'
                    ? 'Paused'
                    : 'Ready'
            }
          />
        </Badge>
      </div>

      <Appear show={!configured}>
        <Banner tone="record" className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">
              {murmurModels
                ? 'Sign in to use Murmur’s speech model'
                : 'Connect a speech model to start dictating'}
            </div>
            <div className="text-note text-muted-foreground">
              {murmurModels
                ? 'Your account includes speech and formatting models. Or connect your own provider under Models.'
                : 'Murmur needs a transcription endpoint. OpenAI, Groq, Deepgram, or any local whisper server works.'}
            </div>
          </div>
          <Button onClick={() => onNavigate(murmurModels ? 'account' : 'providers')}>
            {murmurModels ? 'Account' : 'Set up'} <ArrowRight />
          </Button>
        </Banner>
      </Appear>

      <UpdateBanner onNavigate={onNavigate} />

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardContent className="space-y-5 pt-card">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Hold to dictate</div>
              <KeyCaps
                keys={settings.hotkeys.pushToTalk}
                platform={platform}
                sideSensitive={settings.hotkeys.sideSensitive}
                size="lg"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {settings.hotkeys.handsFreeTrigger === 'tap'
                  ? 'Tap for hands-free'
                  : settings.hotkeys.handsFreeTrigger === 'double-tap'
                    ? 'Double-tap for hands-free'
                    : 'Hands-free'}
              </div>
              <KeyCaps
                keys={
                  settings.hotkeys.handsFreeTrigger === 'off'
                    ? settings.hotkeys.handsFree
                    : settings.hotkeys.pushToTalk
                }
                platform={platform}
                sideSensitive={settings.hotkeys.sideSensitive}
                size="lg"
              />
            </div>
            {settings.hotkeys.commandMode.length > 0 && (
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Edit selected text by voice</div>
                <KeyCaps
                  keys={settings.hotkeys.commandMode}
                  platform={platform}
                  sideSensitive={settings.hotkeys.sideSensitive}
                  size="lg"
                />
              </div>
            )}
            <div className="pt-1">
              <div className="mb-2 text-note text-muted-foreground">
                Practice here — click the box, hold the shortcut and say something.
              </div>
              <Textarea
                placeholder="Your words will appear here…"
                className="min-h-24 resize-none text-lead"
              />
            </div>
          </CardContent>
        </Card>

        <motion.div
          className="grid grid-cols-2 gap-3"
          variants={list}
          initial="initial"
          animate="enter"
        >
          <Stat icon={<Type />} label="Words dictated">
            <CountUp value={stats.totalWords} format={formatNumber} />
          </Stat>
          <Stat
            icon={<Gauge />}
            label="Speaking pace"
            hint={wpm ? `vs ~${TYPING_WPM} typing` : undefined}
          >
            {wpm ? <CountUp value={wpm} format={(n) => `${n} wpm`} /> : '—'}
          </Stat>
          <Stat icon={<Clock3 />} label="Time saved">
            {savedMs > 0 ? <CountUp value={savedMs} format={formatDuration} /> : '—'}
          </Stat>
          <Stat icon={<Flame />} label="Day streak">
            {stats.streakDays ? <CountUp value={stats.streakDays} /> : '—'}
          </Stat>
        </motion.div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Recent</h2>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('history')}>
            View all <ArrowRight />
          </Button>
        </div>
        {recent.length === 0 ? (
          <div className="well rounded-xl px-6 py-12 text-center text-note text-muted-foreground">
            Nothing yet. Your dictations show up here with their timing breakdown.
          </div>
        ) : (
          /* A list card: tight padding, and each row a surface one radius step in (20 - 8 = 12). */
          <div className="surface-raised rounded-xl p-card-tight">
            {/* Rows arrive one after another; entries dictated while this page is open slide in at the top. */}
            <AnimatePresence>
              {recent.map((e, i) => (
                <motion.div
                  key={e.id}
                  layout="position"
                  custom={i}
                  variants={row}
                  initial="initial"
                  animate="enter"
                  exit={{ opacity: 0, height: 0, transition: { duration: 0.18, ease: leave } }}
                  className="overflow-hidden rounded-md transition-colors hover:bg-accent/60"
                >
                  <div className="flex items-start gap-4 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lead">
                        {e.error ? (
                          <span className="text-destructive">{e.error}</span>
                        ) : (
                          e.finalText
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-caption text-muted-foreground">
                        <span>{formatRelative(e.createdAt)}</span>
                        {e.appName && <span>· {e.appName}</span>}
                        <span>· {e.wordCount} words</span>
                        {settings.general.showLatencyInHistory && !e.error && (
                          <span>· {e.timings.totalMs} ms</span>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <Appear show={!!lastLatency && settings.general.showLatencyInHistory}>
        <section className="space-y-3">
          <h2 className="eyebrow">Last dictation, where the time went</h2>
          {lastLatency && <LatencyBar t={lastLatency} />}
        </section>
      </Appear>
    </div>
  )
}

/**
 * Where the account stands, in one quiet line under the greeting: the trial's days, the free week's
 * words, a paused formatting model. Nothing when there is nothing to say; never a banner.
 */
function PlanLine({
  inference,
  onOpen
}: {
  inference: InferenceView
  onOpen: () => void
}): React.JSX.Element | null {
  if (!inference.offersMurmur || !inference.signedIn || !inference.status) return null
  if (inference.routing.stt !== 'murmur' && inference.planState !== 'trial') return null
  let text: string | null = null
  if (inference.planState === 'trial') {
    const days = inference.trialDaysLeft
    text = `Pro trial · ${days === 1 ? 'last day' : `${days} days left`}`
  } else if (inference.planState === 'free') {
    const words = inference.meters.find((m) => m.limit === 'wordsPerWeek')
    if (words)
      text = words.exceeded
        ? `Free plan · this week's words are used up · more ${formatResetTime(words.resetsAt)}`
        : `Free plan · ${meterValue(words)} this week`
  } else if (inference.formattingPaused) {
    const paused = inference.meters.find((m) => m.limit === 'fairUseSttSecondsPerMonth')
    text = `Pro · formatting paused${paused ? ` until ${formatResetTime(paused.resetsAt).replace(/^on /, '')}` : ''} (fair use)`
  }
  if (!text) return null
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-3 -ml-1 rounded-full px-1 text-meta text-muted-foreground transition-colors hover:text-foreground"
    >
      {text}
    </button>
  )
}

function Stat({
  icon,
  label,
  children,
  hint
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <motion.div variants={item}>
      <Card className="h-full">
        <CardContent className="pt-card">
          <div className="flex items-center gap-2 text-meta text-muted-foreground [&>svg]:size-3.5 [&>svg]:stroke-[1.75]">
            {icon}
            {label}
          </div>
          <div className="serif-display mt-3 text-numeral tabular-nums">{children}</div>
          {hint && <div className="mt-1 text-caption text-muted-foreground">{hint}</div>}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/**
 * Where a dictation's time went, stage by stage. The bar grows in from the left the first time it
 * is shown, and its segments glide to their new shares when it is fed another dictation. On its
 * own it is a card; `nested` inside another card it becomes a well one radius step in.
 */
export function LatencyBar({
  t,
  nested
}: {
  t: HistoryEntry['timings']
  nested?: boolean
}): React.JSX.Element {
  const parts = [
    { label: 'Silence trim', ms: t.vadMs, color: 'bg-chart-1' },
    { label: 'Speech to text', ms: t.sttMs, color: 'bg-chart-2' },
    { label: 'Cleanup', ms: t.formatMs, color: 'bg-chart-3' },
    { label: 'Smart format', ms: t.llmMs, color: 'bg-chart-4' },
    { label: 'Insert', ms: t.injectMs, color: 'bg-chart-5' }
  ].filter((p) => p.ms > 0)
  const total = Math.max(1, t.totalMs)
  return (
    <div className={nested ? 'well rounded-md p-4' : 'surface-raised rounded-xl p-card'}>
      <div
        className={`flex h-2 w-full overflow-hidden rounded-full ${nested ? 'bg-input' : 'bg-muted'}`}
      >
        {parts.map((p, i) => (
          <motion.div
            key={p.label}
            className={p.color}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(1, (p.ms / total) * 100)}%` }}
            transition={{ duration: 0.7, ease: arrive, delay: 0.1 + i * 0.05 }}
            title={`${p.label}: ${p.ms} ms`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-meta text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${p.color}`} /> {p.label}{' '}
            <span className="tabular-nums text-foreground">
              <CountUp value={p.ms} duration={0.7} format={(n) => `${n} ms`} />
            </span>
          </span>
        ))}
        <span className="ml-auto">
          Release to inserted:{' '}
          <span className="font-medium tabular-nums text-foreground">
            <CountUp value={t.totalMs} duration={0.7} format={(n) => `${n} ms`} />
          </span>
        </span>
      </div>
    </div>
  )
}
