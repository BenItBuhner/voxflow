import { v, type Infer } from 'convex/values'
import { meterValidator } from './entitlements'
import { billingIntervalValidator, planStateValidator, planValidator } from './plans'

/**
 * Validators shared by the schema, the public function signatures and the tests. The wire shapes
 * returned to clients deliberately mirror the desktop app's local types (apps/desktop/src/shared)
 * so a synced record drops straight into the offline mirror.
 */

export const toneValidator = v.union(
  v.literal('auto'),
  v.literal('casual'),
  v.literal('neutral'),
  v.literal('professional')
)
export type Tone = Infer<typeof toneValidator>

export const formattingModeValidator = v.union(v.literal('off'), v.literal('light'), v.literal('smart'))
export type FormattingMode = Infer<typeof formattingModeValidator>

/**
 * Knobs of the rule-based cleanup the apps had before the text engine (v0.5). Existing preference
 * documents and app rules still carry them, so they stay valid here; current clients neither send
 * nor read them, and they are never used by the gateway.
 */
const hesitationLevelValidator = v.union(v.literal('off'), v.literal('light'), v.literal('thorough'))
const repetitionScopeValidator = v.union(v.literal('words'), v.literal('phrases'), v.literal('thorough'))
const listsModeValidator = v.union(v.literal('off'), v.literal('spoken'), v.literal('auto'))
const listStyleValidator = v.union(v.literal('auto'), v.literal('bullets'), v.literal('numbers'))
const bulletMarkerValidator = v.union(v.literal('-'), v.literal('•'), v.literal('*'))
const numbersModeValidator = v.union(v.literal('off'), v.literal('smart'), v.literal('all'))
const llmFreedomValidator = v.union(v.literal('strict'), v.literal('balanced'), v.literal('natural'))
const llmStructureValidator = v.union(v.literal('keep'), v.literal('assist'))

/** @deprecated Kept only so documents written by v0.4 clients keep validating. */
export const legacyFormattingFields = {
  removeFillers: v.optional(v.boolean()),
  fillerWords: v.optional(v.array(v.string())),
  hesitations: v.optional(hesitationLevelValidator),
  hesitationPhrases: v.optional(v.array(v.string())),
  collapseRepeats: v.optional(v.boolean()),
  repetitionScope: v.optional(repetitionScopeValidator),
  spokenCommands: v.optional(v.boolean()),
  selfCorrections: v.optional(v.boolean()),
  autoCapitalize: v.optional(v.boolean()),
  pressEnterCommand: v.optional(v.boolean()),
  lists: v.optional(listsModeValidator),
  listStyle: v.optional(listStyleValidator),
  bulletMarker: v.optional(bulletMarkerValidator),
  numbers: v.optional(numbersModeValidator),
  llmFreedom: v.optional(llmFreedomValidator),
  llmStructure: v.optional(llmStructureValidator)
}

/** @deprecated As `legacyFormattingFields`, for per-app rules. */
export const legacyAppRuleFields = {
  lists: v.optional(listsModeValidator),
  numbers: v.optional(numbersModeValidator),
  freedom: v.optional(llmFreedomValidator)
}

export const platformValidator = v.union(
  v.literal('win32'),
  v.literal('darwin'),
  v.literal('linux'),
  v.literal('android'),
  v.literal('ios'),
  v.literal('web')
)
export type Platform = Infer<typeof platformValidator>

export const dictationModeValidator = v.union(
  v.literal('hold'),
  v.literal('hands-free'),
  v.literal('command')
)

/**
 * Style preferences that follow the user across devices: whether to format, how it should sound,
 * the trailing space and the user's instructions for the model. Everything else the engine derives
 * from the destination. Provider connections and API keys never sync.
 */
export const formattingPreferencesValidator = v.object({
  mode: v.optional(formattingModeValidator),
  tone: v.optional(toneValidator),
  trailingSpace: v.optional(v.boolean()),
  /** Free-form guidance for the formatting model. */
  llmInstructions: v.optional(v.string()),
  ...legacyFormattingFields
})
export type FormattingPreferences = Infer<typeof formattingPreferencesValidator>

export const syncPreferencesValidator = v.object({
  /** Opt-in: mirror dictation history across devices. Off by default because it contains dictated text. */
  history: v.optional(v.boolean())
})
export type SyncPreferences = Infer<typeof syncPreferencesValidator>

export const preferencesPatchValidator = v.object({
  formatting: v.optional(formattingPreferencesValidator),
  /**
   * Dictation language ("auto" or an ISO-639-1 code). Both apps lock the speech model to it and
   * tell the formatting model to write in it, so unclear speech is not guessed as another language.
   */
  language: v.optional(v.string()),
  sync: v.optional(syncPreferencesValidator)
})
export type PreferencesPatch = Infer<typeof preferencesPatchValidator>

export const preferencesDtoValidator = v.object({
  formatting: v.optional(formattingPreferencesValidator),
  language: v.optional(v.string()),
  sync: v.optional(syncPreferencesValidator),
  updatedAt: v.number()
})
export type PreferencesDto = Infer<typeof preferencesDtoValidator>

export const dictionaryEntryDtoValidator = v.object({
  id: v.id('dictionaryEntries'),
  word: v.string(),
  aliases: v.array(v.string()),
  fuzzy: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number()
})
export type DictionaryEntryDto = Infer<typeof dictionaryEntryDtoValidator>

export const dictionaryEntryInputValidator = v.object({
  word: v.string(),
  aliases: v.optional(v.array(v.string())),
  fuzzy: v.optional(v.boolean()),
  createdAt: v.optional(v.number())
})
export type DictionaryEntryInput = Infer<typeof dictionaryEntryInputValidator>

export const snippetDtoValidator = v.object({
  id: v.id('snippets'),
  trigger: v.string(),
  content: v.string(),
  createdAt: v.number(),
  updatedAt: v.number()
})
export type SnippetDto = Infer<typeof snippetDtoValidator>

export const snippetInputValidator = v.object({
  trigger: v.string(),
  content: v.string(),
  createdAt: v.optional(v.number())
})
export type SnippetInput = Infer<typeof snippetInputValidator>

/** Per-app overrides; every field optional so a rule only carries what the user set. */
export const appRuleOverrides = {
  formatting: v.optional(formattingModeValidator),
  trailingSpace: v.optional(v.boolean()),
  instructions: v.optional(v.string()),
  ...legacyAppRuleFields
}

export const appRuleDtoValidator = v.object({
  id: v.id('appRules'),
  match: v.string(),
  tone: toneValidator,
  ...appRuleOverrides,
  createdAt: v.number(),
  updatedAt: v.number()
})
export type AppRuleDto = Infer<typeof appRuleDtoValidator>

export const appRuleInputValidator = v.object({
  match: v.string(),
  tone: v.optional(toneValidator),
  ...appRuleOverrides,
  createdAt: v.optional(v.number())
})
export type AppRuleInput = Infer<typeof appRuleInputValidator>

export const statsDtoValidator = v.object({
  totalWords: v.number(),
  totalSessions: v.number(),
  totalSpeechMs: v.number(),
  streakDays: v.number(),
  lastSessionDay: v.string(),
  updatedAt: v.number()
})
export type StatsDto = Infer<typeof statsDtoValidator>

export const deviceDtoValidator = v.object({
  id: v.id('devices'),
  deviceId: v.string(),
  name: v.string(),
  platform: platformValidator,
  appVersion: v.string(),
  lastSeenAt: v.number(),
  createdAt: v.number()
})
export type DeviceDto = Infer<typeof deviceDtoValidator>

export const historyEntryInputValidator = v.object({
  entryId: v.string(),
  createdAt: v.number(),
  mode: dictationModeValidator,
  rawText: v.optional(v.string()),
  finalText: v.string(),
  wordCount: v.number(),
  speechMs: v.number(),
  appName: v.optional(v.string()),
  provider: v.string(),
  model: v.string(),
  llmUsed: v.boolean()
})
export type HistoryEntryInput = Infer<typeof historyEntryInputValidator>

export const historyEntryDtoValidator = v.object({
  id: v.id('historyEntries'),
  entryId: v.string(),
  deviceId: v.string(),
  deviceName: v.optional(v.string()),
  createdAt: v.number(),
  mode: dictationModeValidator,
  rawText: v.optional(v.string()),
  finalText: v.string(),
  wordCount: v.number(),
  speechMs: v.number(),
  appName: v.optional(v.string()),
  provider: v.string(),
  model: v.string(),
  llmUsed: v.boolean()
})
export type HistoryEntryDto = Infer<typeof historyEntryDtoValidator>

/** Stripe's subscription statuses, as the webhook reports them. */
export const subscriptionStatusValidator = v.union(
  v.literal('active'),
  v.literal('trialing'),
  v.literal('past_due'),
  v.literal('canceled'),
  v.literal('unpaid'),
  v.literal('incomplete'),
  v.literal('incomplete_expired'),
  v.literal('paused')
)
export type SubscriptionStatus = Infer<typeof subscriptionStatusValidator>

/** The subscription snapshot kept on the user row; billing webhooks are its only writer. */
export const subscriptionValidator = v.object({
  /** Stripe subscription id (`sub_…`). */
  id: v.string(),
  status: subscriptionStatusValidator,
  priceId: v.string(),
  interval: billingIntervalValidator,
  /** End of the paid period, epoch ms. */
  currentPeriodEnd: v.number(),
  cancelAtPeriodEnd: v.boolean(),
  /** Last failed invoice, epoch ms; cleared when the subscription is active again. */
  paymentFailedAt: v.optional(v.number()),
  /** `created` of the Stripe event that produced this snapshot (ms); older events are ignored. */
  eventAt: v.number()
})
export type Subscription = Infer<typeof subscriptionValidator>

export const userDtoValidator = v.object({
  id: v.id('users'),
  clerkId: v.string(),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  /** Tier whose limits apply (see lib/plans.ts); `pro` during the trial. */
  plan: planValidator,
  /** Where the account is in its lifecycle: trial, residual free tier or paid. */
  planState: planStateValidator,
  /** When the 14-day trial ends or ended, epoch ms. */
  trialEndsAt: v.optional(v.number()),
  onboardingCompletedAt: v.optional(v.number()),
  onboardingVersion: v.optional(v.number()),
  createdAt: v.number()
})
export type UserDto = Infer<typeof userDtoValidator>

export const inferenceKindValidator = v.union(v.literal('stt'), v.literal('llm'))

/** What a client needs to know about the instance's managed models and this account's allowance. */
export const inferenceStatusValidator = v.object({
  /** The instance offers at least the managed speech model. */
  available: v.boolean(),
  models: v.object({
    stt: v.union(v.string(), v.null()),
    llm: v.union(v.string(), v.null())
  }),
  /** Tier whose limits apply; `pro` during the trial. */
  plan: planValidator,
  planState: planStateValidator,
  trialEndsAt: v.union(v.number(), v.null()),
  limits: v.object({
    sttSecondsPerMonth: v.number(),
    llmTokensPerMonth: v.number(),
    requestsPerMinute: v.number(),
    maxClipSeconds: v.number()
  }),
  /** The most recent month with any usage; clients treat other months as zero. */
  usage: v.object({
    period: v.string(),
    sttSeconds: v.number(),
    sttRequests: v.number(),
    llmTokens: v.number(),
    llmRequests: v.number()
  }),
  /** Pro past its soft fair-use cap: /v1/format answers with rule-based text. */
  formattingPaused: v.boolean(),
  upgradeUrl: v.union(v.string(), v.null()),
  /** The rolling week and the day the client asked about; null without a `day` argument. */
  window: v.union(
    v.object({
      day: v.string(),
      weekStart: v.string(),
      words: v.number(),
      sttSeconds: v.number(),
      dictationsToday: v.number()
    }),
    v.null()
  ),
  /** Every limit that applies to the tier and where it stands; empty without a `day` argument. */
  meters: v.array(meterValidator),
  resets: v.union(
    v.object({
      day: v.number(),
      week: v.union(v.number(), v.null()),
      month: v.number()
    }),
    v.null()
  )
})
export type InferenceStatus = Infer<typeof inferenceStatusValidator>

/** The account's billing state as the web account page shows it. */
export const billingStatusValidator = v.object({
  /** Stripe keys and both prices are set on the deployment. */
  configured: v.boolean(),
  /** The account has a Stripe customer, so the Customer Portal can open. */
  portalAvailable: v.boolean(),
  upgradeUrl: v.union(v.string(), v.null()),
  subscription: v.union(
    v.object({
      status: subscriptionStatusValidator,
      interval: billingIntervalValidator,
      currentPeriodEnd: v.number(),
      cancelAtPeriodEnd: v.boolean(),
      paymentFailedAt: v.union(v.number(), v.null())
    }),
    v.null()
  )
})
export type BillingStatus = Infer<typeof billingStatusValidator>
