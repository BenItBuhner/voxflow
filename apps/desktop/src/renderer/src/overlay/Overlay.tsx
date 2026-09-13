import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { describeLimit, type LimitNotice } from '@shared/limits'
import type { OverlayState } from '@shared/types'
import { cn } from '@renderer/lib/utils'

const BAR_COUNT = 18
const BAR_STEP_MS = 45
const IDLE_WIDTH = 56
const IDLE_HEIGHT = 6
const PILL_HEIGHT = 44
const PILL_PAD_X = 16
/** The limit notice: two lines and its buttons, at the sheet radius rather than a capsule. */
const LIMIT_HEIGHT = 84
const LIMIT_PAD_X = 20
/** How long an outgoing layer keeps fading; must cover `overlay-layer-out` in globals.css. */
const LEAVE_MS = 240
const FLAT_LEVELS: readonly number[] = Array(BAR_COUNT).fill(0.05)

interface Props {
  state: OverlayState
  level: number
  micError?: string
  /** The pill's buttons, shown on an error whose recording can be sent again. */
  onRetry?: (id: string) => void
  onDismiss?: () => void
  /** The two ways forward from a plan limit: the web account page, or the user's own provider. */
  onUpgrade?: (url: string) => void
  onOwnProvider?: () => void
  /** The pointer entered or left the pill (main decides whether the window takes clicks). */
  onHover?: (over: boolean) => void
}

/** A refusal on a plan limit: the pill explains it instead of showing the bare error. */
function isLimitStop(s: OverlayState): s is OverlayState & { limit: LimitNotice } {
  return s.phase === 'error' && !!s.limit
}

/** One set of pill contents. The current layer renders live props; leaving layers are frozen. */
interface Layer {
  key: string
  state: OverlayState
  leaving: boolean
  levels: readonly number[]
}

interface Stack {
  key: string
  layers: Layer[]
}

/**
 * Everything that changes *what* the pill shows. Progress within a phase (elapsed time, levels,
 * the hands-free badge) updates the current layer in place instead of cross-fading.
 */
function contentKey(s: OverlayState): string {
  switch (s.phase) {
    case 'idle':
      return 'idle'
    case 'listening':
      return `listening:${s.mode === 'command' ? 'command' : 'dictation'}`
    default:
      return `${s.phase}:${s.mode ?? ''}:${s.message ?? ''}:${s.retryId ?? ''}:${s.limit?.limit ?? ''}`
  }
}

function labelFor(s: OverlayState): string {
  switch (s.phase) {
    case 'listening':
      if (s.mode === 'command') return 'Command'
      return s.locked ? 'Hands-free' : ''
    case 'processing':
      return s.mode === 'command' ? 'Editing…' : 'Transcribing…'
    case 'success':
      if (s.message) return s.message
      return s.limit ? describeLimit(s.limit, Date.now(), 'formatting').title : 'Inserted'
    case 'error':
      return s.message ?? 'Something went wrong'
    case 'disabled':
      return 'Paused'
    default:
      return ''
  }
}

/**
 * The overlay pill. A single element morphs between every state: its width follows the measured
 * content, its height, colour and shadow transition, and the old and new contents cross-fade on top
 * of each other while it does. The idle indicator is the same element collapsed to a thin bar, so
 * starting a dictation grows the bar into the pill instead of swapping two elements.
 */
export function Overlay({
  state,
  level,
  micError,
  onRetry,
  onDismiss,
  onUpgrade,
  onOwnProvider,
  onHover
}: Props): React.JSX.Element {
  const key = contentKey(state)
  const idle = state.phase === 'idle'
  const listening = state.phase === 'listening'
  const limitStop = isLimitStop(state)
  const interactive = state.phase === 'error' && (!!state.retryId || limitStop)

  // ---- waveform: a new sample slides in on a fixed cadence, independent of the frame rate -----
  const [levels, setLevels] = useState<readonly number[]>(FLAT_LEVELS)
  const levelRef = useRef(level)
  useEffect(() => {
    levelRef.current = level
  }, [level])
  useEffect(() => {
    if (!listening) return
    let raf = 0
    let last = 0
    let fresh = true
    const tick = (now: number): void => {
      if (now - last >= BAR_STEP_MS) {
        last = now
        const lvl = levelRef.current
        const sample = Math.max(0.08, Math.min(1, lvl + (Math.random() - 0.5) * 0.08 * lvl))
        setLevels((prev) => {
          const next = [...(fresh ? FLAT_LEVELS : prev), sample]
          fresh = false
          if (next.length > BAR_COUNT) next.shift()
          return next
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [listening])

  // ---- layer stack: the current contents plus whatever is still fading out ------------------
  // Derived from the previous render's stack (React's "adjust state during render" pattern).
  const [stack, setStack] = useState<Stack>(() => ({
    key,
    layers: idle ? [] : [{ key, state, leaving: false, levels: FLAT_LEVELS }]
  }))
  const current = stack.layers.find((l) => !l.leaving)
  if (stack.key !== key) {
    const next = stack.layers.filter((l) => l.leaving && l.key !== key)
    if (current) next.push({ ...current, leaving: true, levels })
    if (!idle) next.push({ key, state, leaving: false, levels: FLAT_LEVELS })
    setStack({ key, layers: next })
  } else if (current && current.state !== state) {
    // Keep the live layer's snapshot fresh so it freezes on its latest contents when it leaves.
    setStack({ key, layers: stack.layers.map((l) => (l === current ? { ...l, state } : l)) })
  }
  useEffect(() => {
    if (!stack.layers.some((l) => l.leaving)) return
    const timer = window.setTimeout(() => {
      setStack((s) => ({ ...s, layers: s.layers.filter((l) => !l.leaving) }))
    }, LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [stack])

  // ---- width follows the current contents ---------------------------------------------------
  // ResizeObserver reports the initial size on observe() and runs before paint; flushSync makes
  // the new width land in the same frame so the CSS transition starts from the previous one.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [contentWidth, setContentWidth] = useState(0)
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.offsetWidth
      flushSync(() => setContentWidth(Math.ceil(w)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [key])

  const padX = limitStop ? LIMIT_PAD_X : PILL_PAD_X
  const width = idle ? IDLE_WIDTH : Math.max(IDLE_WIDTH, contentWidth + padX * 2)
  const height = idle ? IDLE_HEIGHT : limitStop ? LIMIT_HEIGHT : PILL_HEIGHT
  const phase = state.phase

  return (
    <div className="flex h-full w-full items-end justify-center pb-3">
      <div
        title={idle ? micError : undefined}
        style={{ width, height }}
        onPointerEnter={interactive ? () => onHover?.(true) : undefined}
        onPointerLeave={interactive ? () => onHover?.(false) : undefined}
        className={cn(
          'overlay-pill relative overflow-hidden text-note font-medium text-overlay-foreground',
          // Two lines of explanation sit better on the sheet radius than in a capsule.
          limitStop ? 'rounded-2xl' : 'rounded-full',
          // The pill floats over other windows: the overlay elevation, and a thin light catch on
          // its top edge rather than an outline, so it reads as a surface with a light on it.
          idle
            ? micError
              ? 'bg-destructive/70 shadow-[0_1px_4px_rgba(0,0,0,0.35)]'
              : 'bg-overlay/60 shadow-[0_1px_4px_rgba(0,0,0,0.35)]'
            : 'shadow-[0_6px_24px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]',
          !idle && 'bg-overlay/95',
          // A plan limit is not a fault: it keeps the pill's own colour and speaks calmly.
          phase === 'error' && !limitStop && 'bg-overlay-error/95',
          phase === 'success' && 'bg-overlay-success/95',
          phase === 'disabled' && 'bg-overlay-disabled/90 text-overlay-foreground/70',
          state.mode === 'command' && listening && 'bg-overlay-command/95'
        )}
      >
        {stack.layers.map((layer) => (
          <div
            key={layer.key}
            className={cn(
              'overlay-layer',
              layer.leaving ? 'overlay-layer-out' : 'overlay-layer-in'
            )}
          >
            <div
              ref={layer.leaving ? undefined : contentRef}
              className={cn(
                'flex items-center gap-3 whitespace-nowrap',
                isLimitStop(layer.leaving ? layer.state : state) ? 'h-[84px]' : 'h-11'
              )}
            >
              <Contents
                state={layer.leaving ? layer.state : state}
                levels={layer.leaving ? layer.levels : levels}
                onRetry={layer.leaving ? undefined : onRetry}
                onDismiss={layer.leaving ? undefined : onDismiss}
                onUpgrade={layer.leaving ? undefined : onUpgrade}
                onOwnProvider={layer.leaving ? undefined : onOwnProvider}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Contents({
  state,
  levels,
  onRetry,
  onDismiss,
  onUpgrade,
  onOwnProvider
}: {
  state: OverlayState
  levels: readonly number[]
  onRetry?: (id: string) => void
  onDismiss?: () => void
  onUpgrade?: (url: string) => void
  onOwnProvider?: () => void
}): React.JSX.Element | null {
  const label = labelFor(state)
  const elapsed = state.elapsedSec ?? 0
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  if (isLimitStop(state)) {
    return (
      <LimitStop
        limit={state.limit}
        retryId={state.retryId}
        onRetry={onRetry}
        onDismiss={onDismiss}
        onUpgrade={onUpgrade}
        onOwnProvider={onOwnProvider}
      />
    )
  }
  switch (state.phase) {
    case 'listening': {
      const command = state.mode === 'command'
      return (
        <>
          <span className="relative flex size-2.5">
            <span
              className={cn(
                'absolute inline-flex size-full rounded-full opacity-70 animate-pulse-soft',
                command ? 'bg-overlay-command-foreground' : 'bg-record'
              )}
            />
            <span
              className={cn(
                'relative inline-flex size-2.5 rounded-full',
                command ? 'bg-overlay-command-foreground' : 'bg-record'
              )}
            />
          </span>
          <div className="flex h-6 items-center gap-[3px]">
            {levels.map((v, i) => (
              <span
                key={i}
                className={cn(
                  'block w-[3px] rounded-full transition-[height] duration-75',
                  command ? 'bg-overlay-command-foreground/90' : 'bg-overlay-foreground'
                )}
                style={{ height: `${Math.max(3, Math.round(v * 22))}px`, opacity: 0.55 + v * 0.45 }}
              />
            ))}
          </div>
          <span className="tabular-nums text-overlay-foreground/70">{elapsedLabel}</span>
          {label && (
            <span className="flex items-center gap-1 rounded-full bg-overlay-foreground/10 px-2 py-0.5 text-caption text-overlay-foreground/85 animate-fade-in">
              {state.locked && !command && <LockIcon />}
              {label}
            </span>
          )}
        </>
      )
    }
    case 'processing':
      return (
        <>
          <span className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block size-1.5 rounded-full bg-overlay-foreground animate-bounce-dot"
                style={{ animationDelay: `${i * 140}ms` }}
              />
            ))}
          </span>
          <span className="text-overlay-foreground/85">{label}</span>
        </>
      )
    case 'success': {
      // Text that went in with rule-based cleanup only: say so in passing, and when it comes back.
      const soft = state.limit ? describeLimit(state.limit, Date.now(), 'formatting') : null
      return (
        <>
          <CheckIcon />
          <span className="max-w-[420px] truncate" title={soft?.detail}>
            {label}
          </span>
          {soft && state.limit?.resetsAt !== null && state.limit?.resetsAt !== undefined && (
            <span className="max-w-[160px] truncate text-meta text-overlay-foreground/60">
              {soft.detail.slice(soft.detail.lastIndexOf('resets'))}
            </span>
          )}
        </>
      )
    }
    case 'error': {
      const retryId = state.retryId
      if (!retryId) {
        return (
          <>
            <WarnIcon />
            <span className="max-w-[260px] truncate">{label}</span>
          </>
        )
      }
      // The recording is stored: offer to send it again instead of making the user say it all over.
      return (
        <>
          <WarnIcon />
          <span className="max-w-[170px] truncate" title={label}>
            {label}
          </span>
          <button
            type="button"
            onClick={() => onRetry?.(retryId)}
            className="flex h-7 items-center gap-1.5 rounded-full bg-overlay-foreground/15 px-3 text-meta font-semibold text-overlay-foreground transition-colors hover:bg-overlay-foreground/28 active:bg-overlay-foreground/35"
          >
            <RetryIcon /> Retry
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => onDismiss?.()}
            className="-ml-1 flex size-7 items-center justify-center rounded-full text-overlay-foreground/70 transition-colors hover:bg-overlay-foreground/15 hover:text-overlay-foreground"
          >
            <CloseIcon />
          </button>
        </>
      )
    }
    case 'disabled':
      return (
        <>
          <PauseIcon />
          <span>{label}</span>
        </>
      )
    default:
      return null
  }
}

/**
 * A refusal on a plan limit. Not a fault, so no red: what ran out and when it comes back, then the
 * two ways forward (the account page, or the user's own provider) beside Retry, since the
 * recording is kept and can be sent again once the limit has reset or the route has changed.
 */
function LimitStop({
  limit,
  retryId,
  onRetry,
  onDismiss,
  onUpgrade,
  onOwnProvider
}: {
  limit: LimitNotice
  retryId?: string
  onRetry?: (id: string) => void
  onDismiss?: () => void
  onUpgrade?: (url: string) => void
  onOwnProvider?: () => void
}): React.JSX.Element {
  const copy = describeLimit(limit, Date.now())
  const upgrade = copy.upgradeHelps ? limit.upgradeUrl : null
  const button =
    'flex h-7 items-center gap-1.5 rounded-full px-3 text-meta font-semibold transition-colors'
  const tonal = cn(
    button,
    'bg-overlay-foreground/15 text-overlay-foreground hover:bg-overlay-foreground/28 active:bg-overlay-foreground/35'
  )
  return (
    <div className="flex w-[520px] max-w-[520px] flex-col gap-2 whitespace-nowrap">
      <div className="flex items-center gap-3">
        <LimitIcon />
        <span className="min-w-0 flex-1 truncate" title={limit.message}>
          {copy.title}
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => onDismiss?.()}
          className="-mr-1.5 flex size-7 items-center justify-center rounded-full text-overlay-foreground/70 transition-colors hover:bg-overlay-foreground/15 hover:text-overlay-foreground"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex items-center gap-2 pl-7">
        <span
          className="min-w-0 flex-1 truncate text-meta font-normal text-overlay-foreground/65"
          title={copy.detail}
        >
          {copy.detail}
        </span>
        {upgrade && (
          <button
            type="button"
            onClick={() => onUpgrade?.(upgrade)}
            className={cn(
              button,
              'bg-overlay-foreground text-overlay hover:bg-overlay-foreground/90 active:bg-overlay-foreground/80'
            )}
          >
            Upgrade
          </button>
        )}
        <button type="button" onClick={() => onOwnProvider?.()} className={tonal}>
          Use my own model
        </button>
        {retryId && (
          <button type="button" onClick={() => onRetry?.(retryId)} className={tonal}>
            <RetryIcon /> Retry
          </button>
        )}
      </div>
    </div>
  )
}

function LimitIcon(): React.JSX.Element {
  return (
    <svg
      className="shrink-0 text-warning"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function LockIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
function CheckIcon(): React.JSX.Element {
  return (
    <svg
      className="overlay-check text-overlay-success-foreground"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12l5 5L20 6" />
    </svg>
  )
}
function WarnIcon(): React.JSX.Element {
  return (
    <svg
      className="text-overlay-error-foreground"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  )
}
function RetryIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  )
}
function CloseIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
function PauseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}
