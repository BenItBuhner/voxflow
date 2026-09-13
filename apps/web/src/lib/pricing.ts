/**
 * The plan structure: a reverse trial into a residual free tier, and one paid tier at half the
 * price of the tool Murmur is usually compared with. Local mode (your own provider, no account)
 * stays free and is listed as its own column so nobody thinks an account is required. The numbers
 * mirror packages/backend/convex/lib/plans.ts, which enforces them.
 */
export const PRICING = {
  trialDays: 14,
  freeWordsPerWeek: 500,
  freeAudioMinutesPerWeek: 7,
  freeDictationsPerDay: 12,
  freeClipSeconds: 60,
  freeRequestsPerMinute: 20,
  proMonthly: 7.5,
  proYearly: 72,
  proClipMinutes: 10,
  proRequestsPerMinute: 60,
  proFairUseHours: 30,
  proHardCapHours: 60
} as const

export type Billing = 'monthly' | 'yearly'

export function proPerMonth(billing: Billing): number {
  return billing === 'monthly' ? PRICING.proMonthly : PRICING.proYearly / 12
}

export function formatPrice(amount: number): string {
  return amount % 1 === 0 ? `$${amount}` : `$${amount.toFixed(2)}`
}

/** Where a pricing CTA lands: the account page, with the chosen interval pre-selected for Pro. */
export function upgradeHref(billing: Billing): string {
  return `/account?upgrade=${billing}`
}

export interface Tier {
  id: 'local' | 'free' | 'pro'
  name: string
  summary: string
  features: string[]
  cta: { label: string; href: '/download' | '/account' }
}

export const TIERS: readonly Tier[] = [
  {
    id: 'local',
    name: 'Local',
    summary: 'No account. A speech model you connect, or a local one.',
    features: [
      'The whole engine: the model on the raw transcript, verified numbers',
      'Any OpenAI-compatible provider, Deepgram, ElevenLabs or a local whisper server',
      'Dictionary, snippets and style, on this device',
      'Nothing leaves the device but the clip being transcribed'
    ],
    cta: { label: 'Download', href: '/download' }
  },
  {
    id: 'free',
    name: 'Free',
    summary: `${PRICING.trialDays} days of Pro first, no card. Then a free tier that stays.`,
    features: [
      'Murmur’s speech and formatting models included',
      `${PRICING.freeWordsPerWeek} words a week after the trial`,
      'Dictionary, snippets, style and stats in step on every device',
      `Clips up to a minute, ${PRICING.freeDictationsPerDay} dictations a day`
    ],
    cta: { label: 'Create a free account', href: '/account' }
  },
  {
    id: 'pro',
    name: 'Pro',
    summary: 'Unlimited dictation on Murmur’s models, on every device.',
    features: [
      'Unlimited words, within fair use',
      'Smart formatting always on',
      `Clips up to ${PRICING.proClipMinutes} minutes, ${PRICING.proRequestsPerMinute} requests a minute`,
      'Dictation history synced across devices, opt-in',
      'Cancel any time; you keep the free tier'
    ],
    cta: { label: 'Upgrade to Pro', href: '/account' }
  }
]

export const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'What counts as a word?',
    a: 'The words in the transcript Murmur’s speech model returns, counted over the last seven days (UTC). Formatting does not add words, and dictating with a provider of your own under Models never counts.'
  },
  {
    q: 'What happens when the trial ends?',
    a: `Your account moves to the free tier: ${PRICING.freeWordsPerWeek} words a week on Murmur’s models, and everything keeps syncing. Nothing is deleted. Switching a device to your own provider keeps it unlimited at no charge.`
  },
  {
    q: 'Do I need an account at all?',
    a: 'No. Local mode is free for as long as you like: connect a speech model of your own or run one on your machine, and the full engine runs without signing in.'
  },
  {
    q: 'How is Pro billed?',
    a: `${formatPrice(PRICING.proMonthly)} a month, or ${formatPrice(PRICING.proYearly)} a year, which works out to ${formatPrice(proPerMonth('yearly'))} a month. Payment is by card through Stripe from your account page; the same page opens Stripe’s billing portal to change the card, switch between monthly and yearly, or cancel.`
  },
  {
    q: 'Can I cancel? Do I get a refund?',
    a: 'Cancel any time from the account page; Pro stays on until the end of the period you paid for, then the account moves to the free tier. If you cancel within 14 days of your first payment, ask and it is refunded in full. The details are in the terms.'
  },
  {
    q: 'Is there a lifetime plan?',
    a: 'No. Every dictation costs inference, so a one-time price would be a promise to stop serving you at some point. Local mode is the pay-once-or-never option, and it costs nothing.'
  },
  {
    q: 'What does fair use mean for Pro?',
    a: `Clips up to ${PRICING.proClipMinutes} minutes, ${PRICING.proRequestsPerMinute} requests a minute, and ${PRICING.proFairUseHours} hours of audio a month, which nobody dictating by hand gets near. Past it, formatting falls back to the rule-based cleanup rather than stopping; past ${PRICING.proHardCapHours} hours transcription pauses until the next month.`
  },
  {
    q: 'What are the free tier’s other limits?',
    a: `Besides the ${PRICING.freeWordsPerWeek} words a week: ${PRICING.freeAudioMinutesPerWeek} minutes of audio a week, ${PRICING.freeDictationsPerDay} dictations a day, clips up to a minute and ${PRICING.freeRequestsPerMinute} requests a minute. They exist to keep silence-heavy or automated use from costing more than the words suggest; ordinary dictation only ever meets the word cap.`
  }
]
