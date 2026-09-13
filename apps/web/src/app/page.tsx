import { Engine } from '@/components/landing/engine'
import { FinalCta } from '@/components/landing/final-cta'
import { Hero } from '@/components/landing/hero'
import { HowItWorks } from '@/components/landing/how-it-works'
import { Models } from '@/components/landing/models'
import { Platforms } from '@/components/landing/platforms'
import { Principles } from '@/components/landing/principles'
import { fetchLatestRelease } from '@/lib/releases'

/* Prerendered; the release details in the hero and platform cards refresh every ten minutes
   (REVALIDATE_SECONDS; Next needs the literal here). */
export const revalidate = 600

export default async function HomePage() {
  const manifest = await fetchLatestRelease()
  return (
    <>
      <Hero manifest={manifest} />
      <HowItWorks />
      <Engine />
      <Models />
      <Platforms manifest={manifest} />
      <Principles />
      <FinalCta />
    </>
  )
}
