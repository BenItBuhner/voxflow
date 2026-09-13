import type { LimitNotice } from './limits'
import type { InstallKind } from './updates'

export type DictationMode = 'hold' | 'hands-free' | 'command'

export type OverlayPhase = 'idle' | 'listening' | 'processing' | 'success' | 'error' | 'disabled'

export interface OverlayState {
  phase: OverlayPhase
  mode?: DictationMode
  message?: string
  /** Seconds elapsed while listening. */
  elapsedSec?: number
  /** Visible when the user has an active hands-free lock. */
  locked?: boolean
  /**
   * Error phase only: the history entry whose stored recording can be sent again. The pill shows a
   * Retry button and stays up until the user acts on it (or gives up on them after a while).
   */
  retryId?: string
  /**
   * A plan limit the Murmur instance applied to this dictation. On the error phase it is what
   * refused the request (the pill explains it and offers Upgrade and the user's own provider next
   * to Retry); on the success phase the text went in with rule-based cleanup only because the
   * formatting model was paused or refused, and the pill says so quietly.
   */
  limit?: LimitNotice
}

export interface StageTimings {
  /** Speech duration captured, before trimming. */
  recordMs: number
  vadMs: number
  sttMs: number
  formatMs: number
  llmMs: number
  injectMs: number
  /** Hotkey release/stop -> text inserted. */
  totalMs: number
}

/**
 * What happened in the smart-formatting stage, so the History view can explain the result.
 *   used      the model's answer passed the verifier and was inserted
 *   rejected  every attempt failed the verifier; the rule-based text was inserted
 *   failed    the request errored or timed out; the rule-based text was inserted
 *   skipped   the model was not asked (mode, too short, no model configured)
 */
export type LlmOutcome = 'used' | 'rejected' | 'failed' | 'skipped'

export interface LlmStatus {
  outcome: LlmOutcome
  /** Verifier reason, error message, or why it was skipped. */
  detail?: string
  /** Model round trips made. */
  attempts?: number
  /** Set when the first answer was rejected and a strict retry was needed. */
  retriedAfter?: string
}

export interface HistoryEntry {
  id: string
  createdAt: number
  mode: DictationMode
  rawText: string
  finalText: string
  wordCount: number
  speechMs: number
  appName?: string
  provider: string
  model: string
  injected: boolean
  injectionMethod?: string
  llmUsed: boolean
  llm?: LlmStatus
  /** Rule-based stages that changed the text, in order. */
  stages?: string[]
  timings: StageTimings
  error?: string
  /**
   * File name of the stored audio (16 kHz mono WAV) in the recordings directory, when it was kept.
   * A failed dictation always keeps its recording so it can be retried; whether successful ones do
   * is the "Keep recordings" setting.
   */
  recording?: string
  /** How many times this dictation has been sent for transcription (absent means once). */
  attempts?: number
  /** Set on entries that arrived through account history sync from another device. */
  deviceId?: string
  deviceName?: string
  remote?: boolean
}

export interface SttModelInfo {
  id: string
  ownedBy?: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  text?: string
  latencyMs?: number
  suggestedModels?: string[]
}

export interface HotkeyCapture {
  keys: number[]
  label: string
  valid: boolean
  reason?: string
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  arch: string
  electron: string
  hookBackend: 'uiohook' | 'globalShortcut' | 'none'
  injectionBackend: string
  sessionType?: string
  /** How this copy was installed; decides which release file updates use. */
  installKind: InstallKind
  userDataPath: string
  logPath: string
}

export interface ActiveWindowInfo {
  title: string
  app: string
  pid?: number
}

export interface DictationEvent {
  state: OverlayState
  lastEntry?: HistoryEntry
}

/** Settings playground: run a transcript through the pipeline as if dictated into a given app. */
export interface PreviewRequest {
  raw: string
  /** Process/app name to classify (e.g. "slack", "Code.exe"); blank means an unknown text field. */
  app?: string
  title?: string
  /** Also ask the smart-formatting model (when configured and applicable). */
  smart?: boolean
}

export interface PreviewResult {
  /** The rule-based text: what "light" mode inserts and what every fallback inserts. */
  light: {
    text: string
    stages: string[]
    wordCount: number
    pressEnter: boolean
  }
  style: {
    category: string
    ruleMatch?: string
    tone: string
    mode: string
  }
  smart?: {
    status: LlmStatus
    /** Final text after the verifier and the finishing pass. */
    text?: string
    /** Cleaned model output of the last attempt. */
    modelText?: string
    llmMs: number
    stages: string[]
  }
}
