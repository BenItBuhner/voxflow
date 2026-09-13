import type { Metadata } from 'next'
import Link from 'next/link'
import { Bullets, Facts, LegalDocument, type LegalSection } from '@/components/legal/legal-document'
import { repoUrl } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What Murmur sends where, what an account stores, how long it is kept, and how to delete it. Written from the code, not from a template.'
}

const UPDATED = '13 September 2026'

/*
 * Every statement below describes what the code in the repository does today: the apps
 * (apps/desktop, apps/android), the backend (packages/backend/convex) and this site. Where the
 * behaviour depends on how an instance is configured, it says so.
 */
const SECTIONS: LegalSection[] = [
  {
    id: 'short',
    title: 'The short version',
    body: (
      <>
        <p>
          Murmur turns speech into text. The audio of a dictation stays on your device; the only
          thing that leaves it is the clip being transcribed, sent to the speech model you are
          using, and the transcript being cleaned up, sent to the formatting model. Without an
          account nothing reaches a Murmur server at all. With an account, Murmur stores what it
          takes to keep your devices in step (dictionary, snippets, style, stats, the device list,
          and dictation history only if you switch that on), your plan, and counters of how much of
          its models you used. It never stores your audio or your transcripts on its servers.
        </p>
      </>
    )
  },
  {
    id: 'local',
    title: 'Without an account',
    body: (
      <>
        <p>
          In Local mode the apps talk to the speech and formatting providers you configure under
          Models and Style, with keys you enter, or to a model running on your own machine. Those
          providers receive the clip and the transcript under their own terms. Murmur has no server
          in that path and receives nothing.
        </p>
        <Bullets
          items={[
            'Recordings, history, dictionary, snippets and settings live in the app’s data folder on the device. “Keep recordings” (on by default) stores each dictation’s audio next to its History entry so you can play it back or send it again; off, only failed dictations keep their audio until they succeed or are deleted.',
            'The apps check GitHub Releases for updates and download them from there; GitHub sees the request like any download.',
            'Nothing in the apps reports usage or crashes anywhere.'
          ]}
        />
      </>
    )
  },
  {
    id: 'account',
    title: 'What an account stores',
    body: (
      <>
        <p>
          Signing in creates a record on the instance’s Convex deployment keyed by your Clerk user
          id. Clerk handles identity (your email address, name, avatar and sign-in method) under{' '}
          <a
            href="https://clerk.com/legal/privacy"
            className="underline decoration-foreground/30 underline-offset-4"
            rel="noreferrer"
          >
            its privacy policy
          </a>
          ; Murmur copies the email, display name and avatar URL from it. Then, per table:
        </p>
        <Facts
          rows={[
            {
              term: 'Dictionary',
              detail: 'Each term, its aliases and whether it matches by sound.'
            },
            { term: 'Snippets', detail: 'Trigger phrase and the text it expands to.' },
            {
              term: 'Style',
              detail:
                'Formatting mode, tone, trailing space, your instructions for the model, dictation language, per-app rules (app name match, tone, instructions), and whether history sync is on.'
            },
            {
              term: 'Stats',
              detail:
                'Total words, dictations, speech time, day streak, the calendar day of the last dictation.'
            },
            {
              term: 'Devices',
              detail:
                'A per-install id, the name you gave the device, platform, app version, last seen.'
            },
            {
              term: 'History (opt-in)',
              detail:
                'Only if you turn on history sync: for each dictation the raw and final text, word count, speech duration, the app it was typed into, the provider and model, and which device it came from. Off by default because it contains what you said.'
            },
            {
              term: 'Plan',
              detail:
                'Trial, free or Pro, when the trial ends, your Stripe customer id, and a snapshot of the subscription (status, monthly or yearly, current period end, whether it is set to cancel, whether the last payment failed).'
            },
            {
              term: 'Usage',
              detail:
                'Per UTC month: seconds of audio transcribed, formatting tokens, request counts. Per UTC day: words in the transcripts, seconds of audio, transcription and formatting counts. Counts only, never the text.'
            }
          ]}
        />
        <p>
          Which provider a device dictates with and any API keys of your own are device settings.
          They are never sent to the account.
        </p>
      </>
    )
  },
  {
    id: 'models',
    title: 'Dictating with Murmur’s models',
    body: (
      <>
        <p>
          With an account the apps use the speech and formatting models the instance provides by
          default. Requests go through the instance’s gateway (a Convex HTTP action) with your
          session token, and from there to the providers the operator configured:
        </p>
        <Bullets
          items={[
            'Transcription: the audio clip is forwarded, as is, to the speech provider together with the dictation language and, when set, a short prompt built from your dictionary. The transcript comes back to your device. The gateway measures the clip’s length and counts the words in the transcript for your plan, and keeps nothing else.',
            'Formatting: the transcript and the dictation’s context (the kind of app you are typing into and its name, the text before the cursor when the app can read it, your instructions, the dictation language, dictionary terms and phrases to keep verbatim) are sent to the language-model provider. The cleaned text comes back to your device. The gateway records the tokens used, not the text.',
            'Logs: the gateway logs the plan, clip length, word and token counts, and how long the provider took. Not the audio, not the text.'
          ]}
        />
        <p>
          The provider behind each model is a configuration of the instance, not of the app. On the
          instance run from this repository the speech model is served by Groq and the formatting
          model by an OpenAI-compatible provider chosen by the operator; both receive the content
          only to answer the request, under their own terms. If the instance changes providers, this
          page changes with it.
        </p>
      </>
    )
  },
  {
    id: 'billing',
    title: 'Payments',
    body: (
      <>
        <p>
          Pro is paid through Stripe. Checkout and the billing portal are Stripe pages; your card
          details go to Stripe and never pass through Murmur. Stripe tells Murmur when a
          subscription starts, changes, ends or fails to renew, and Murmur keeps the snapshot listed
          above so the apps know your plan. Stripe keeps its own records (invoices, payment methods)
          under{' '}
          <a
            href="https://stripe.com/privacy"
            className="underline decoration-foreground/30 underline-offset-4"
            rel="noreferrer"
          >
            its privacy policy
          </a>
          .
        </p>
      </>
    )
  },
  {
    id: 'retention',
    title: 'How long it is kept',
    body: (
      <>
        <Bullets
          items={[
            'Synced data stays until you change or delete it in the apps, or delete the account.',
            'Synced history is capped at 5,000 entries per account; the oldest are removed as new ones arrive.',
            'Usage counters stay with the account so the plan can be enforced; they are deleted with it.',
            'Deleting your account (Delete my data in the app’s Account page, or deleting the Clerk account) removes every table above in one step: dictionary, snippets, rules, preferences, stats, devices, history and usage, then the account record itself. Stripe retains what it must for accounting.'
          ]}
        />
      </>
    )
  },
  {
    id: 'services',
    title: 'Who runs what',
    body: (
      <>
        <Facts
          rows={[
            { term: 'Clerk', detail: 'Sign-in and the identity behind the account.' },
            {
              term: 'Convex',
              detail: 'The database and functions that hold the account data and run the gateway.'
            },
            {
              term: 'Speech and language-model providers',
              detail:
                'Transcription and formatting for accounts using Murmur’s models (see section 4).'
            },
            { term: 'Stripe', detail: 'Payments, invoices and the billing portal.' },
            { term: 'Vercel', detail: 'Hosts this website.' },
            { term: 'GitHub', detail: 'Hosts the source code, the releases and the downloads.' }
          ]}
        />
        <p>
          This website sets no analytics and loads no third-party script anywhere except the account
          page, where Clerk’s sign-in runs. Fonts are served from this site.
        </p>
      </>
    )
  },
  {
    id: 'choices',
    title: 'Your choices',
    body: (
      <>
        <Bullets
          items={[
            'Use Local mode: no account, your own provider or a local model, nothing sent to Murmur.',
            'Keep history on the device: history sync is off unless you turn it on.',
            'Turn off “Keep recordings” to drop audio once a dictation succeeds.',
            'Delete your data at any time from the app’s Account page; it takes effect immediately.'
          ]}
        />
      </>
    )
  },
  {
    id: 'contact',
    title: 'Questions',
    body: (
      <>
        <p>
          The code is the reference:{' '}
          <a
            href={repoUrl()}
            className="underline decoration-foreground/30 underline-offset-4"
            rel="noreferrer"
          >
            the repository
          </a>{' '}
          holds the apps, the backend and this site, and{' '}
          <a
            href={`${repoUrl()}/issues`}
            className="underline decoration-foreground/30 underline-offset-4"
            rel="noreferrer"
          >
            its issue tracker
          </a>{' '}
          is where to ask. Changes to this page are made in the same repository, with its history.
          The{' '}
          <Link href="/terms" className="underline decoration-foreground/30 underline-offset-4">
            terms
          </Link>{' '}
          cover the subscription itself.
        </p>
      </>
    )
  }
]

export default function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="Privacy"
      title="What goes where, and what stays."
      lede="Written from the code in the repository rather than from a template: what the apps send, what an account stores, how long it is kept, and how to delete it."
      updated={UPDATED}
      sections={SECTIONS}
      related={{ href: '/terms', label: 'terms' }}
    />
  )
}
