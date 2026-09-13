import type { Metadata } from 'next'
import Link from 'next/link'
import { Faq } from '@/components/pricing/faq'
import { Plans } from '@/components/pricing/plans'
import { Section } from '@/components/ui/section'
import { formatPrice, PRICING, proPerMonth } from '@/lib/pricing'

export const metadata: Metadata = {
  title: 'Pricing',
  description: `Murmur Pro is ${formatPrice(PRICING.proMonthly)} a month or ${formatPrice(PRICING.proYearly)} a year. Every account starts with ${PRICING.trialDays} days of Pro, no card, and keeps a free tier. Local mode with your own model is free forever.`
}

export default function PricingPage() {
  return (
    <>
      <Section className="pb-8 sm:pb-10">
        <div className="mx-auto max-w-2xl text-center">
          <div className="eyebrow">Pricing</div>
          <h1 className="serif-display mt-5 text-title text-balance sm:text-display">
            Free to start. {formatPrice(proPerMonth('yearly'))} a month if you stay.
          </h1>
          <p className="mt-6 text-lead text-pretty text-muted-foreground">
            Every account begins with {PRICING.trialDays} days of Pro and no card, then keeps a free
            tier. Pro is {formatPrice(PRICING.proMonthly)} a month or{' '}
            {formatPrice(PRICING.proYearly)} a year. And if you would rather bring your own speech
            model, Murmur is free without an account at all.
          </p>
        </div>
      </Section>

      <Section className="pt-0 sm:pt-0">
        <Plans />
        <p className="mx-auto mt-8 max-w-2xl text-center text-note text-muted-foreground">
          Pro checkout is not open yet: today every account is on the free tier, and this page shows
          the plan it grows into. Prices in USD. Your plan and this month’s usage are on your{' '}
          <Link
            href="/account"
            className="text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
          >
            account page
          </Link>
          .
        </p>
      </Section>

      <Section>
        <Faq />
      </Section>
    </>
  )
}
