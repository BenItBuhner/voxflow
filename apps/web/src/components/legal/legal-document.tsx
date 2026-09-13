import Link from 'next/link'
import type { ReactNode } from 'react'
import { Section } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'

/*
 * A legal page in the site's voice: a serif title, a lede, then numbered sections with plain
 * prose. Structure comes from space and the one raised card that holds the text; no rules.
 */
export interface LegalSection {
  id: string
  title: string
  body: ReactNode
}

export function LegalDocument({
  eyebrow,
  title,
  lede,
  updated,
  sections,
  related
}: {
  eyebrow: string
  title: string
  lede: ReactNode
  updated: string
  sections: LegalSection[]
  related: { href: string; label: string }
}) {
  return (
    <Section>
      <div className="max-w-2xl">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="serif-display mt-5 text-title text-balance sm:text-display">{title}</h1>
        <p className="mt-5 text-lead text-pretty text-muted-foreground">{lede}</p>
        <p className="mt-3 text-meta text-muted-foreground">
          Last updated {updated}. Also read the{' '}
          <Link
            href={related.href}
            className="underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
          >
            {related.label}
          </Link>
          .
        </p>
      </div>
      <div className="mt-section grid gap-card lg:grid-cols-[minmax(0,1fr)_16rem]">
        <Surface as="article" className="legal-prose max-w-none">
          {sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-24 py-row first:pt-0 last:pb-0"
            >
              <h2 className="serif-display text-heading">
                <span className="mr-3 text-muted-foreground tabular-nums">{index + 1}.</span>
                {section.title}
              </h2>
              <div className="mt-3 grid gap-3 text-body text-pretty text-foreground/85">
                {section.body}
              </div>
            </section>
          ))}
        </Surface>
        <nav aria-label="Sections" className="hidden lg:block">
          <div className="sticky top-24">
            <div className="eyebrow">Contents</div>
            <ol className="mt-4 grid gap-2 text-note">
              {sections.map((section, index) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="mr-2 tabular-nums">{index + 1}.</span>
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>
      </div>
    </Section>
  )
}

/** A bulleted list inside a section, in the site's quiet style. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="grid gap-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span
            aria-hidden
            className="mt-2 inline-flex size-1.5 shrink-0 rounded-full bg-foreground/50"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** A definition-style table without lines: what is stored and why. */
export function Facts({ rows }: { rows: Array<{ term: string; detail: ReactNode }> }) {
  return (
    <dl className="grid gap-2">
      {rows.map((row) => (
        <div
          key={row.term}
          className="well grid gap-1 rounded-md px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4"
        >
          <dt className="text-note font-medium">{row.term}</dt>
          <dd className="text-note text-muted-foreground">{row.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
