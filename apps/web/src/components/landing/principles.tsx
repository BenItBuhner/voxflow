import { Section, SectionHeading } from '@/components/ui/section'
import { repoUrl } from '@/lib/site'

const PRINCIPLES = [
  {
    title: 'Recordings never leave the device',
    body: 'Every dictation’s audio stays with its History entry on your machine so you can play it back or retry a failed one. Nothing is uploaded except the clip being transcribed.'
  },
  {
    title: 'Keys and model choices are device settings',
    body: 'Which speech model a device uses and any API keys of your own are never synced. An account syncs your dictionary, snippets, style and stats, and history only if you ask.'
  },
  {
    title: 'Updates you can check',
    body: 'Both apps update from GitHub Releases and verify each download against the release’s SHA256SUMS.txt. Releases without one are shown but never installed unattended.'
  },
  {
    title: 'Open source, MIT',
    body: 'The desktop app, the Android app, the text engine and the backend are one repository. Read the prompt the model gets and the checks its answer must pass.'
  }
]

export function Principles() {
  return (
    <Section id="principles">
      <SectionHeading
        eyebrow="On your terms"
        title="Dictation hears everything you say. Murmur is built like it knows that."
      />
      <dl className="mt-section grid gap-x-12 gap-y-10 sm:grid-cols-2">
        {PRINCIPLES.map((p) => (
          <div key={p.title} className="max-w-md">
            <dt className="text-lead font-semibold tracking-tight">{p.title}</dt>
            <dd className="mt-2 text-body text-pretty text-muted-foreground">{p.body}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-10 text-body text-muted-foreground">
        <a
          href={repoUrl()}
          className="text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
        >
          Read the source
        </a>
      </p>
    </Section>
  )
}
