import type { Metadata } from 'next'
import Link from 'next/link'
import { Bullets, Facts, LegalDocument, type LegalSection } from '@/components/legal/legal-document'
import { formatPrice, PRICING, proPerMonth } from '@/lib/pricing'
import { repoUrl } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Terms',
  description:
    'The terms of Murmur’s hosted service in plain language: the trial, the free tier, the Pro subscription, fair use, cancellation and refunds.'
}

const UPDATED = '13 September 2026'

const SECTIONS: LegalSection[] = [
  {
    id: 'scope',
    title: 'What these terms cover',
    body: (
      <>
        <p>
          The Murmur apps are open source under the MIT licence; that licence, not this page,
          governs the software itself. These terms cover the hosted service you reach by signing in:
          the account, the sync between your devices, the speech and formatting models Murmur
          provides, and the Pro subscription. Using the service means you accept them. If you use
          the apps in Local mode, with your own provider and no account, nothing here applies to
          you.
        </p>
      </>
    )
  },
  {
    id: 'account',
    title: 'Your account',
    body: (
      <>
        <Bullets
          items={[
            'One account per person. You are responsible for what happens under it and for keeping the sign-in method that guards it (Clerk) secure.',
            'You must be at least 16, or the age at which you can agree to terms like these where you live.',
            'You can delete your account and everything it holds at any time from the app’s Account page. The privacy page lists exactly what that removes.'
          ]}
        />
      </>
    )
  },
  {
    id: 'trial',
    title: 'The trial',
    body: (
      <>
        <p>
          Every new account starts with {PRICING.trialDays} days of Pro. No card is asked for and
          nothing is charged; when the {PRICING.trialDays} days end the account moves to the free
          tier by itself, unless you have subscribed. The trial is once per person: making further
          accounts to start it again is not allowed, and such accounts may be closed.
        </p>
      </>
    )
  },
  {
    id: 'free',
    title: 'The free tier',
    body: (
      <>
        <p>
          After the trial the account keeps syncing and keeps access to Murmur’s models within these
          limits:
        </p>
        <Facts
          rows={[
            {
              term: 'Words',
              detail: `${PRICING.freeWordsPerWeek} words over any 7 days (UTC), counted from the transcripts Murmur’s speech model returns.`
            },
            {
              term: 'Audio',
              detail: `${PRICING.freeAudioMinutesPerWeek} minutes of audio over the same 7 days.`
            },
            {
              term: 'Dictations',
              detail: `${PRICING.freeDictationsPerDay} a day (UTC), counted separately for transcription and for formatting.`
            },
            { term: 'Clips', detail: 'Up to one minute each.' },
            {
              term: 'Requests',
              detail: `${PRICING.freeRequestsPerMinute} a minute, and the monthly ceilings the apps show on the account page.`
            }
          ]}
        />
        <p>
          When a limit is reached the app says which one and when it frees up, and dictation with a
          provider of your own keeps working regardless. The free tier is provided as is and may be
          changed or withdrawn; existing accounts get at least 30 days’ notice on this page.
        </p>
      </>
    )
  },
  {
    id: 'pro',
    title: 'Pro and how it is billed',
    body: (
      <>
        <Facts
          rows={[
            {
              term: 'Price',
              detail: `${formatPrice(PRICING.proMonthly)} a month, or ${formatPrice(PRICING.proYearly)} a year (${formatPrice(proPerMonth('yearly'))} a month). Prices are in US dollars and exclude any tax your country adds at checkout.`
            },
            {
              term: 'Payment',
              detail:
                'By card through Stripe. The subscription renews automatically at the end of each month or year until you cancel.'
            },
            {
              term: 'Failed payments',
              detail:
                'Stripe retries a failed renewal for a few days and the account page tells you; if it still fails, the subscription ends and the account moves to the free tier.'
            },
            {
              term: 'Price changes',
              detail:
                'A price change is announced at least 30 days ahead and applies from your next renewal after that; you can cancel before it does.'
            }
          ]}
        />
      </>
    )
  },
  {
    id: 'fair-use',
    title: 'Fair use',
    body: (
      <>
        <p>
          Pro has no word count. Behind “unlimited” sit limits that nobody dictating by hand
          reaches, there to keep automated or bulk use from being paid for by everyone else:
        </p>
        <Bullets
          items={[
            `Past ${PRICING.proFairUseHours} hours of audio in a calendar month (UTC), the formatting model pauses and dictation continues with the rule-based cleanup, at ${PRICING.freeRequestsPerMinute} requests a minute.`,
            `Past ${PRICING.proHardCapHours} hours in a month, transcription with Murmur’s models pauses until the next month. Your own provider keeps working.`,
            `Clips up to ${PRICING.proClipMinutes} minutes; ${PRICING.proRequestsPerMinute} requests a minute.`,
            'The service is for dictation by the account holder. Feeding it recordings in bulk, sharing an account, reselling access or wrapping the gateway in another product is not fair use, and such accounts may be limited or closed.'
          ]}
        />
      </>
    )
  },
  {
    id: 'cancel',
    title: 'Cancelling and refunds',
    body: (
      <>
        <Bullets
          items={[
            'Cancel any time from the account page (Manage billing opens Stripe’s portal). Pro stays on until the end of the period you have paid for, then the account moves to the free tier. Nothing is deleted.',
            'If you cancel within 14 days of your first payment and ask, that payment is refunded in full.',
            'Otherwise payments are not refunded for the remainder of a period. If the service was unavailable for a substantial part of a period you paid for, ask and it is credited or refunded.',
            'Disputing a charge with your card issuer instead of asking closes the account while the dispute is open.'
          ]}
        />
      </>
    )
  },
  {
    id: 'service',
    title: 'The service itself',
    body: (
      <>
        <Bullets
          items={[
            'Murmur’s models run on third-party providers chosen by the operator; the provider or the model behind a plan may change. When a provider is unavailable the apps fall back to rule-based cleanup, and to your own provider if you have one configured.',
            'The service is offered as is, with reasonable effort to keep it running, and without a guarantee of uptime or of any particular accuracy. Speech recognition makes mistakes; check what it types before you send it.',
            'What you dictate is yours. It is processed only to provide the service, as the privacy page describes, and is not used to train models by Murmur.',
            'Accounts used to break the law, to harm the service or other users, or against these terms may be suspended or closed.'
          ]}
        />
      </>
    )
  },
  {
    id: 'liability',
    title: 'Liability',
    body: (
      <>
        <p>
          To the extent the law where you live allows, Murmur’s liability for anything arising from
          the service is limited to what you paid for it in the twelve months before the claim, and
          excludes indirect losses such as lost work or lost profit. Nothing here limits rights
          consumer law gives you that cannot be limited by contract.
        </p>
      </>
    )
  },
  {
    id: 'changes',
    title: 'Changes and contact',
    body: (
      <>
        <p>
          These terms may change; the date at the top says when, and changes that reduce what you
          get are announced 30 days ahead. Questions and notices go through{' '}
          <a
            href={`${repoUrl()}/issues`}
            className="underline decoration-foreground/30 underline-offset-4"
            rel="noreferrer"
          >
            the repository’s issue tracker
          </a>
          . The{' '}
          <Link href="/privacy" className="underline decoration-foreground/30 underline-offset-4">
            privacy page
          </Link>{' '}
          is part of these terms.
        </p>
      </>
    )
  }
]

export default function TermsPage() {
  return (
    <LegalDocument
      eyebrow="Terms"
      title="The deal, in plain words."
      lede={`A ${PRICING.trialDays}-day trial with no card, a free tier that stays, and a Pro subscription you can cancel from the page you bought it on. What each of those means, and what fair use means behind “unlimited”.`}
      updated={UPDATED}
      sections={SECTIONS}
      related={{ href: '/privacy', label: 'privacy page' }}
    />
  )
}
