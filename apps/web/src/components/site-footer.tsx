import Link from 'next/link'
import type { ReactNode } from 'react'
import { Container } from '@/components/ui/section'
import { Wordmark } from '@/components/wordmark'
import { latestDownloadBase, releasesUrl, repoUrl, SITE_TAGLINE } from '@/lib/site'

const PRODUCT = [
  { href: '/#engine', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/download', label: 'Download' },
  { href: '/account', label: 'Account' }
] as const

const LEGAL = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' }
] as const

/** The footer is the page's rail: one tonal step below the canvas, no rule between them. */
export function SiteFooter() {
  const source = [
    { href: repoUrl(), label: 'Source on GitHub' },
    { href: releasesUrl(), label: 'All releases' },
    { href: `${latestDownloadBase()}/SHA256SUMS.txt`, label: 'Checksums' },
    { href: `${repoUrl()}/issues`, label: 'Report a problem' }
  ]
  return (
    <footer className="mt-auto bg-sidebar py-16">
      <Container>
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-4 text-body text-muted-foreground">{SITE_TAGLINE}</p>
          </div>
          <FooterColumn title="Product">
            {PRODUCT.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="footer-link">
                  {item.label}
                </Link>
              </li>
            ))}
          </FooterColumn>
          <FooterColumn title="Source">
            {source.map((item) => (
              <li key={item.href}>
                <a href={item.href} className="footer-link" rel="noreferrer">
                  {item.label}
                </a>
              </li>
            ))}
          </FooterColumn>
          <FooterColumn title="Legal">
            {LEGAL.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="footer-link">
                  {item.label}
                </Link>
              </li>
            ))}
          </FooterColumn>
        </div>
        <div className="mt-section flex flex-wrap items-center justify-between gap-3 text-meta text-muted-foreground">
          <span>MIT licensed. Windows, Linux and Android; macOS experimental.</span>
          <span>Recordings never leave your device.</span>
        </div>
      </Container>
    </footer>
  )
}

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="eyebrow">{title}</div>
      <ul className="mt-4 space-y-2.5 text-body [&_.footer-link]:text-foreground/80 [&_.footer-link]:transition-colors [&_.footer-link:hover]:text-foreground">
        {children}
      </ul>
    </div>
  )
}
