import type { ReactNode } from 'react'
import { ButtonLink } from '@/components/ui/button'
import { Section, SectionHeading } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'

const OWN = [
  'Any OpenAI-compatible speech endpoint: OpenAI, Groq, Mistral Voxtral, a local whisper server',
  'Deepgram and ElevenLabs natively, with your dictionary sent as key terms',
  'One-click model discovery, a fallback model and a built-in latency test',
  'Keys stay on the device. No account, nothing is uploaded.'
]

const MURMUR = [
  'Speech and formatting models included, nothing to configure',
  'Dictionary, snippets, style and stats in step on desktop and Android',
  'Dictation history sync, opt-in, because it contains what you said',
  'Works offline from a local mirror; edits queue and replay in order'
]

export function Models() {
  return (
    <Section id="models">
      <SectionHeading
        eyebrow="Your models, or Murmur's"
        title="Bring a key, run a local model, or sign in and skip all of that."
        lede="Every build works on its own with a speech model you connect. An account adds Murmur's models and keeps your settings the same on every device. Switch between the two per device, any time."
      />
      <div className="mt-section grid gap-card md:grid-cols-2">
        <Plan
          title="Your own provider"
          subtitle="Local mode. Free, forever, no account."
          items={OWN}
          action={
            <ButtonLink href="/download" variant="tonal">
              Download and connect a model
            </ButtonLink>
          }
        />
        <Plan
          title="Murmur's models"
          subtitle="With an account. Free tier, 14-day Pro trial, Pro from $6 a month."
          items={MURMUR}
          action={<ButtonLink href="/pricing">See pricing</ButtonLink>}
        />
      </div>
    </Section>
  )
}

function Plan({
  title,
  subtitle,
  items,
  action
}: {
  title: string
  subtitle: string
  items: string[]
  action: ReactNode
}) {
  return (
    <Surface className="flex flex-col">
      <h3 className="serif-display text-heading">{title}</h3>
      <p className="mt-1.5 text-body text-muted-foreground">{subtitle}</p>
      <ul className="mt-6 flex-1 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex gap-3 text-lead">
            <span
              aria-hidden
              className="mt-2.5 inline-flex size-1.5 shrink-0 rounded-full bg-foreground/50"
            />
            <span className="text-foreground/85">{item}</span>
          </li>
        ))}
      </ul>
      <div className="mt-8">{action}</div>
    </Surface>
  )
}
