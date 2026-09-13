/**
 * The plan structure: a reverse trial into a residual free tier, and one paid tier at half the
 * price of the tool Murmur is usually compared with. Local mode (your own provider, no account)
 * stays free and is listed as its own column so nobody thinks an account is required.
 */
export const PRICING = {
  trialDays: 14,
  freeWordsPerWeek: 500,
  freeClipMinutes: 2,
  freeRequestsPerMinute: 20,
  proMonthly: 7.5,
  proYearly: 72,
  proClipMinutes: 10,
  proRequestsPerMinute: 60
} as const

export type Billing = 'monthly' | 'yearly'

export function proPerMonth(billing: Billing): number {
  return billing === 'monthly' ? PRICING.proMonthly : PRICING.proYearly / 12
}

export function formatPrice(amount: number): string {
  return amount % 1 === 0 ? `$${amount}` : `$${amount.toFixed(2)}`
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
      `Clips up to ${PRICING.freeClipMinutes} minutes, ${PRICING.freeRequestsPerMinute} requests a minute`
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
    cta: { label: `Start ${PRICING.trialDays} days of Pro`, href: '/account' }
  }
]

export const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'What counts as a word?',
    a: 'The words in the text Murmur inserts, counted over a rolling seven days. Dictating with a provider of your own under Models never counts.'
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
    a: `${formatPrice(PRICING.proMonthly)} a month, or ${formatPrice(PRICING.proYearly)} a year, which works out to ${formatPrice(proPerMonth('yearly'))} a month. Checkout is not open yet; until it is, every account is on the free tier and this page shows what is coming.`
  },
  {
    q: 'Is there a lifetime plan?',
    a: 'No. Every dictation costs inference, so a one-time price would be a promise to stop serving you at some point. Local mode is the pay-once-or-never option, and it costs nothing.'
  },
  {
    q: 'What does fair use mean for Pro?',
    a: `Clips up to ${PRICING.proClipMinutes} minutes, ${PRICING.proRequestsPerMinute} requests a minute, and a ceiling on audio hours a month that nobody dictating by hand gets near. Past it, formatting falls back to the rule-based cleanup rather than stopping.`
  }
]
