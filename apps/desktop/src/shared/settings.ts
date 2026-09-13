import { z } from 'zod'
import { replacementModel } from './models'
import { ACCENT_PRESET_IDS } from './theme'

export const SETTINGS_VERSION = 4

/**
 * Where a model runs: the Murmur instance's managed models (cloud builds only) or a provider the
 * user configured on this device. See shared/inference.ts for how the effective source is decided.
 */
export const inferenceSourceSchema = z.enum(['murmur', 'custom'])

export const handsFreeTriggerSchema = z.enum(['tap', 'double-tap', 'off'])
export type HandsFreeTrigger = z.infer<typeof handsFreeTriggerSchema>

export const formattingModeSchema = z.enum(['off', 'light', 'smart'])
export type FormattingMode = z.infer<typeof formattingModeSchema>

export const toneSchema = z.enum(['auto', 'casual', 'neutral', 'professional'])
export type Tone = z.infer<typeof toneSchema>

export const LLM_INSTRUCTIONS_MAX = 2000

export const injectionMethodSchema = z.enum(['auto', 'paste', 'type', 'clipboard'])
export type InjectionMethod = z.infer<typeof injectionMethodSchema>

export const overlayPositionSchema = z.enum(['bottom-center', 'top-center', 'bottom-right'])
export type OverlayPosition = z.infer<typeof overlayPositionSchema>

export const themeSchema = z.enum(['system', 'light', 'dark'])
export type Theme = z.infer<typeof themeSchema>

/**
 * Where the accent colour comes from: nothing (Murmur's monochrome look), the operating system's
 * accent colour, one of the built-in presets, or a colour the user picked.
 */
export const accentSchema = z.enum(['neutral', 'system', ...ACCENT_PRESET_IDS, 'custom'])
export type Accent = z.infer<typeof accentSchema>

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #rrggbb')

export const sttProviderKindSchema = z.enum(['openai-compatible', 'deepgram', 'elevenlabs'])
export type SttProviderKind = z.infer<typeof sttProviderKindSchema>

export const dictionaryEntrySchema = z.object({
  id: z.string(),
  word: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  fuzzy: z.boolean().default(false),
  createdAt: z.number().default(0)
})
export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>

export const snippetSchema = z.object({
  id: z.string(),
  trigger: z.string().min(1),
  content: z.string(),
  createdAt: z.number().default(0)
})
export type Snippet = z.infer<typeof snippetSchema>

/**
 * A per-app override, matched on the window title or process name. Everything the destination
 * needs beyond this (lists, digits, layout, how far the model may go) the engine derives from the
 * app category itself, so a rule only carries what a person would actually want to say about an
 * app: how it should sound, whether to format at all, and any extra guidance for the model.
 */
export const appRuleSchema = z.object({
  id: z.string(),
  match: z.string().min(1),
  tone: toneSchema.default('auto'),
  formatting: formattingModeSchema.optional(),
  trailingSpace: z.boolean().optional(),
  /** Extra guidance for the model in this app only; appended to the global instructions. */
  instructions: z.string().max(LLM_INSTRUCTIONS_MAX).optional()
})
export type AppRule = z.infer<typeof appRuleSchema>

export const hotkeySchema = z.array(z.number().int()).max(3)

export const settingsSchema = z.object({
  version: z.number().default(SETTINGS_VERSION),
  onboardingComplete: z.boolean().default(false),
  general: z
    .object({
      launchAtLogin: z.boolean().default(false),
      startMinimized: z.boolean().default(true),
      theme: themeSchema.default('system'),
      accent: accentSchema.default('neutral'),
      /** Seed colour for the `custom` accent. */
      accentColor: hexColorSchema.catch('#ff5a36').default('#ff5a36'),
      /** Material You style tonal surfaces: backgrounds and cards take a soft tint of the accent. */
      tintedSurfaces: z.boolean().default(false),
      sounds: z.boolean().default(true),
      soundVolume: z.number().min(0).max(1).default(0.35),
      overlayPosition: overlayPositionSchema.default('bottom-center'),
      showOverlayWhenIdle: z.boolean().default(true),
      showLatencyInHistory: z.boolean().default(true)
    })
    .prefault({}),
  hotkeys: z
    .object({
      // uiohook keycodes (see core/hotkey/keys.ts). Empty array disables the binding.
      pushToTalk: hotkeySchema.default([29, 3675]), // Ctrl + Meta/Win
      handsFree: hotkeySchema.default([29, 3675, 57]), // Ctrl + Meta + Space
      commandMode: hotkeySchema.default([56, 3675]), // Alt + Meta
      handsFreeTrigger: handsFreeTriggerSchema.default('tap'),
      tapThresholdMs: z.number().int().min(80).max(1500).default(350),
      doubleTapWindowMs: z.number().int().min(100).max(1500).default(400),
      sideSensitive: z.boolean().default(false),
      escapeCancels: z.boolean().default(true)
    })
    .prefault({}),
  audio: z
    .object({
      deviceId: z.string().default('default'),
      keepMicWarm: z.boolean().default(true),
      preBufferMs: z.number().int().min(0).max(1500).default(350),
      trimSilence: z.boolean().default(true),
      skipIfSilent: z.boolean().default(true),
      silenceThresholdDb: z.number().min(-80).max(-10).default(-48),
      /**
       * Hands-free / locked sessions run until the user stops them unless this is on.
       * Off by default so a leftover 300s cap never cuts someone off mid-thought.
       */
      limitDuration: z.boolean().default(false),
      /** Used only when `limitDuration` is on. */
      maxDurationSec: z.number().int().min(5).max(1800).default(300),
      noiseSuppression: z.boolean().default(true),
      autoGainControl: z.boolean().default(true),
      /**
       * Store the audio of every dictation next to its History entry (play it back, send it again).
       * Off, only failed dictations keep their audio, and only until they succeed or are deleted.
       */
      keepRecordings: z.boolean().default(true)
    })
    .prefault({}),
  stt: z
    .object({
      /**
       * Managed Murmur models by default in cloud builds; ignored (always the user's own provider)
       * in local builds. The fields below describe the user's own provider only.
       */
      source: inferenceSourceSchema.default('murmur'),
      kind: sttProviderKindSchema.default('openai-compatible'),
      presetId: z.string().default('custom'),
      baseUrl: z.string().default(''),
      // Encrypted with Electron safeStorage when available; see main/store/secrets.ts
      apiKeyEnc: z.string().default(''),
      model: z.string().default(''),
      fallbackModel: z.string().default(''),
      language: z.string().default('auto'),
      useDictionaryPrompt: z.boolean().default(true),
      timeoutMs: z.number().int().min(2000).max(120000).default(45000)
    })
    .prefault({}),
  /**
   * How speech becomes text. The engine (packages/text-engine) does the language work with the
   * formatting model and adapts to the destination on its own; what is left to choose is whether
   * to use the model, how the result should sound, and anything you want to tell the model.
   */
  formatting: z
    .object({
      mode: formattingModeSchema.default('smart'),
      tone: toneSchema.default('auto'),
      /** Free-form guidance for the model ("British spelling", "dates as ISO"). Synced. */
      instructions: z.string().max(LLM_INSTRUCTIONS_MAX).default(''),
      /** Add a space after each dictation so the next one flows on naturally. */
      trailingSpace: z.boolean().default(true),
      appRules: z.array(appRuleSchema).default([]),
      /** The formatting model connection. Device-local; never synced. */
      llm: z
        .object({
          /** As for `stt.source`. `custom` with `sameAsStt` follows the speech model's server. */
          source: inferenceSourceSchema.default('murmur'),
          sameAsStt: z.boolean().default(true),
          baseUrl: z.string().default(''),
          apiKeyEnc: z.string().default(''),
          model: z.string().default(''),
          timeoutMs: z.number().int().min(1000).max(60000).default(8000)
        })
        .prefault({})
    })
    .prefault({}),
  injection: z
    .object({
      method: injectionMethodSchema.default('auto'),
      restoreClipboard: z.boolean().default(true),
      restoreClipboardDelayMs: z.number().int().min(50).max(5000).default(400),
      typeChunkSize: z.number().int().min(1).max(512).default(64),
      typeChunkDelayMs: z.number().int().min(0).max(100).default(2)
    })
    .prefault({}),
  dictionary: z.array(dictionaryEntrySchema).default([]),
  snippets: z.array(snippetSchema).default([]),
  stats: z
    .object({
      totalWords: z.number().default(0),
      totalSessions: z.number().default(0),
      totalSpeechMs: z.number().default(0),
      streakDays: z.number().default(0),
      lastSessionDay: z.string().default('')
    })
    .prefault({}),
  cloud: z
    .object({
      /** Stable per-install id reported to the account's device list. Generated on first run. */
      deviceId: z.string().default(''),
      deviceName: z.string().default(''),
      /** `optional` account mode: the user chose to keep using Murmur without an account. */
      accountSkipped: z.boolean().default(false),
      /** Clerk user id of the last signed-in account; lets the app open offline after a restart. */
      lastSignedInUserId: z.string().default(''),
      /** Account whose cloud data absorbed this device's pre-account local data. */
      importedForUserId: z.string().default(''),
      /** Mirror of the account preference; history stays local unless the user opts in. */
      historySync: z.boolean().default(false)
    })
    .prefault({}),
  /** Device-local update preferences (never synced; each install decides for itself). */
  updates: z
    .object({
      /** Look for new releases on start and every few hours. */
      autoCheck: z.boolean().default(true),
      /**
       * Download updates in the background and install them without asking once no dictation is
       * running. Installs that cannot update themselves (portable, unknown layouts) only download.
       */
      autoInstall: z.boolean().default(true),
      /** Offer pre-releases (vX.Y.Z-beta.N). Always on while running a pre-release build. */
      includePrereleases: z.boolean().default(false),
      /** Version the user chose to skip; ignored until a newer one appears or they check manually. */
      skippedVersion: z.string().default('')
    })
    .prefault({})
})

export type Settings = z.infer<typeof settingsSchema>
export type SettingsInput = z.input<typeof settingsSchema>

/**
 * Bring a settings file written by an older build up to date before validation.
 *
 * v1 files predate model sources. An install that had connected its own speech provider keeps
 * using it (and its formatting server) instead of being switched to the instance's models the day
 * the app gains cloud support; an install that never connected one gets the new defaults.
 *
 * v2 files carry the rule-based cleanup knobs (fillers, hesitations, repeats, lists, numbers,
 * model freedom, ...) that the engine no longer has. They are dropped by the schema; the model
 * instructions move from `formatting.llm.instructions` to `formatting.instructions`.
 *
 * v3 files may still name a model its provider has since retired (shared/models.ts). The model is
 * swapped for the provider's recommended replacement once; a v4 file is the user's own choice and
 * is left alone even if it names a retired id.
 */
export function migrateSettings(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  let input = raw as Record<string, unknown>
  const version = typeof input.version === 'number' ? input.version : 0
  const stt = isRecord(input.stt) ? input.stt : undefined
  if (stt && stt.source === undefined && typeof stt.baseUrl === 'string' && stt.baseUrl.trim()) {
    const formatting = isRecord(input.formatting) ? input.formatting : {}
    const llm = isRecord(formatting.llm) ? formatting.llm : {}
    input = {
      ...input,
      stt: { ...stt, source: 'custom' },
      formatting: {
        ...formatting,
        llm: llm.source === undefined ? { ...llm, source: 'custom' } : llm
      }
    }
  }
  const formatting = isRecord(input.formatting) ? input.formatting : undefined
  const llm = formatting && isRecord(formatting.llm) ? formatting.llm : undefined
  if (
    formatting &&
    llm &&
    typeof llm.instructions === 'string' &&
    formatting.instructions === undefined
  ) {
    const { instructions, ...rest } = llm
    input = { ...input, formatting: { ...formatting, instructions, llm: rest } }
  }
  if (version < 4) input = replaceRetiredModels(input)
  return input === raw ? raw : { ...input, version: SETTINGS_VERSION }
}

/**
 * Move the speech model, its fallback and the formatting model off ids their provider retired.
 * The formatting model is judged against the server it actually talks to ("same as speech" means
 * the speech server). Returns the same object when nothing needed changing.
 */
function replaceRetiredModels(input: Record<string, unknown>): Record<string, unknown> {
  const stt = isRecord(input.stt) ? input.stt : undefined
  const formatting = isRecord(input.formatting) ? input.formatting : undefined
  const llm = formatting && isRecord(formatting.llm) ? formatting.llm : undefined
  const sttBaseUrl = typeof stt?.baseUrl === 'string' ? stt.baseUrl : ''
  let out = input
  if (stt && sttBaseUrl) {
    let next = stt
    for (const key of ['model', 'fallbackModel'] as const) {
      const model = next[key]
      const replacement = typeof model === 'string' ? replacementModel(sttBaseUrl, model) : null
      if (replacement) next = { ...next, [key]: replacement }
    }
    if (next !== stt) out = { ...out, stt: next }
  }
  if (formatting && llm && typeof llm.model === 'string') {
    const sameAsStt = llm.sameAsStt !== false
    const baseUrl = sameAsStt ? sttBaseUrl : typeof llm.baseUrl === 'string' ? llm.baseUrl : ''
    const replacement = baseUrl ? replacementModel(baseUrl, llm.model) : null
    if (replacement)
      out = { ...out, formatting: { ...formatting, llm: { ...llm, model: replacement } } }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSettings(raw: unknown): Settings {
  raw = migrateSettings(raw)
  const result = settingsSchema.safeParse(raw ?? {})
  // Whatever the file said, what comes out is at the current version: a later write records that
  // every migration has run, so a choice the user makes afterwards is never migrated again.
  if (result.success) return { ...result.data, version: SETTINGS_VERSION }
  // Salvage whatever validates by re-parsing section by section so one bad field
  // never wipes the whole configuration.
  const base = settingsSchema.parse({})
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw as Record<string, unknown>
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(settingsSchema.shape) as Array<keyof Settings>) {
    if (!(key in input)) continue
    const sectionSchema = settingsSchema.shape[key]
    const parsed = sectionSchema.safeParse(input[key])
    if (parsed.success) out[key] = parsed.data
  }
  return settingsSchema.parse({ ...out, version: SETTINGS_VERSION })
}

export const defaultSettings = (): Settings => settingsSchema.parse({})

/** Milliseconds until a listening session is force-stopped, or `null` when the user left the cap off. */
export function sessionDurationLimitMs(audio: Settings['audio']): number | null {
  if (!audio.limitDuration) return null
  return audio.maxDurationSec * 1000
}
