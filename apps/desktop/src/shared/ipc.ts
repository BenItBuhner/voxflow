import type { Accent } from './settings'

/**
 * Single source of truth for IPC channel names. Main, preload and both renderers
 * import from here so a typo fails at compile time instead of silently at runtime.
 */
export const IPC = {
  // renderer -> main (invoke)
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsReset: 'settings:reset',
  secretSet: 'secret:set',
  secretHas: 'secret:has',
  historyList: 'history:list',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  historyReinsert: 'history:reinsert',
  historyRetry: 'history:retry',
  historyAudio: 'history:audio',
  recordingsInfo: 'recordings:info',
  recordingsClear: 'recordings:clear',
  sttListModels: 'stt:list-models',
  sttTest: 'stt:test',
  llmListModels: 'llm:list-models',
  llmTest: 'llm:test',
  hotkeyCaptureStart: 'hotkey:capture-start',
  hotkeyCaptureStop: 'hotkey:capture-stop',
  hotkeyLabel: 'hotkey:label',
  dictationToggle: 'dictation:toggle',
  dictationCancel: 'dictation:cancel',
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
  appOpenLogs: 'app:open-logs',
  appSetEnabled: 'app:set-enabled',
  appQuit: 'app:quit',
  onboardingComplete: 'onboarding:complete',
  injectTest: 'inject:test',
  pipelinePreview: 'pipeline:preview',
  cloudConfig: 'cloud:config',
  cloudStatus: 'cloud:status',
  cloudAuthState: 'cloud:auth-state',
  cloudSyncNow: 'cloud:sync-now',
  cloudRemoveDevice: 'cloud:remove-device',
  cloudDeleteData: 'cloud:delete-data',
  cloudSetHistorySync: 'cloud:set-history-sync',
  cloudSkipAccount: 'cloud:skip-account',
  cloudSignedOut: 'cloud:signed-out',
  updatesStatus: 'updates:status',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesCancelDownload: 'updates:cancel-download',
  updatesInstall: 'updates:install',
  updatesSkip: 'updates:skip',
  updatesReveal: 'updates:reveal',
  updatesOpenReleases: 'updates:open-releases',
  updatesAckUpdated: 'updates:ack-updated',
  themeSystemAccent: 'theme:system-accent',
  /** The settings window reports the colours it resolved so the native chrome can match. */
  themeReport: 'theme:report',

  // main -> renderer (send)
  settingsChanged: 'settings:changed',
  themeSystemAccentChanged: 'theme:system-accent-changed',
  historyAdded: 'history:added',
  historyChanged: 'history:changed',
  hotkeyCaptured: 'hotkey:captured',
  dictationState: 'dictation:state',
  enabledChanged: 'app:enabled-changed',
  navigate: 'app:navigate',
  cloudStatusChanged: 'cloud:status-changed',
  updatesStatusChanged: 'updates:status-changed',
  cloudTokenRequest: 'cloud:token-request',
  // renderer -> main (send)
  cloudTokenResponse: 'cloud:token-response',

  // overlay <-> main
  overlayState: 'overlay:state',
  overlayPlaySound: 'overlay:play-sound',
  overlayTheme: 'overlay:theme',
  /** The user pressed Retry / the dismiss cross on the pill (overlay -> main). */
  overlayRetry: 'overlay:retry',
  overlayDismiss: 'overlay:dismiss',
  /** The pill's Upgrade button: open the account page in the browser (overlay -> main). */
  overlayOpenUrl: 'overlay:open-url',
  /** The pill's "use my own provider" button: open the Models page (overlay -> main). */
  overlayOpenModels: 'overlay:open-models',
  /** The pointer entered or left the pill; main makes the window clickable only while it is over. */
  overlayHover: 'overlay:hover',
  audioConfigure: 'audio:configure',
  audioStart: 'audio:start',
  audioStop: 'audio:stop',
  audioChunk: 'audio:chunk',
  audioStopped: 'audio:stopped',
  audioStatus: 'audio:status',
  audioLevel: 'audio:level'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface AudioConfigureMessage {
  deviceId: string
  keepWarm: boolean
  preBufferMs: number
  noiseSuppression: boolean
  autoGainControl: boolean
  soundVolume: number
}

/**
 * Everything a renderer needs to build the palette (see shared/theme.ts). Main resolves the
 * light/dark mode (it knows the OS setting) and the OS accent colour; the renderers do the maths.
 */
export interface ThemeMessage {
  mode: 'light' | 'dark'
  accent: Accent
  accentColor: string
  tintedSurfaces: boolean
  /** `#rrggbb` accent published by the desktop environment, when there is one. */
  systemAccent: string | null
}

/** Colours the settings window resolved, for the native title bar and window background. */
export interface ThemeReport {
  mode: 'light' | 'dark'
  background: string
  foreground: string
}

export interface AudioStartMessage {
  sessionId: string
  includePreBuffer: boolean
}

export interface AudioChunkMessage {
  sessionId: string
  /** Int16 little-endian PCM, 16 kHz mono. */
  pcm: ArrayBuffer
  level: number
}

export interface AudioStoppedMessage {
  sessionId: string
  sampleRate: number
  totalSamples: number
}

export interface AudioStatusMessage {
  ready: boolean
  warm: boolean
  deviceLabel?: string
  error?: string
}

export type SoundName = 'start' | 'stop' | 'lock' | 'error' | 'cancel'

/** What the recordings directory holds, for the settings page. */
export interface RecordingsInfo {
  count: number
  bytes: number
}

export interface RetryResult {
  ok: boolean
  error?: string
}
