'use client'

import { useState } from 'react'
import { ButtonLink } from '@/components/ui/button'
import { Chip } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import { cn } from '@/lib/cn'
import { formatPrice, PRICING, proPerMonth, TIERS, type Billing, type Tier } from '@/lib/pricing'

export function Plans() {
  const [billing, setBilling] = useState<Billing>('yearly')
  return (
    <div>
      <div className="flex justify-center">
        <BillingToggle value={billing} onChange={setBilling} />
      </div>
      <div className="mt-section grid gap-card lg:grid-cols-3">
        {TIERS.map((tier) => (
          <PlanCard key={tier.id} tier={tier} billing={billing} />
        ))}
      </div>
    </div>
  )
}

/** Segmented control as in the apps: a well track with an ink thumb, a pill inside a pill. */
function BillingToggle({ value, onChange }: { value: Billing; onChange: (b: Billing) => void }) {
  const options: Array<{ value: Billing; label: string; hint?: string }> = [
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly', hint: 'save 20%' }
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      className="well inline-flex h-11 items-center rounded-full p-1"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-full px-4 text-body font-medium transition-colors duration-200',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
            {option.hint && (
              <span
                className={cn(
                  'text-caption',
                  active ? 'text-primary-foreground/70' : 'text-muted-foreground/80'
                )}
              >
                {option.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* The plan on offer is the raised card; the others are wells on the canvas: elevation, not a ring. */
function PlanCard({ tier, billing }: { tier: Tier; billing: Billing }) {
  const featured = tier.id === 'pro'
  return (
    <Surface role={featured ? 'raised' : 'well'} className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="serif-display text-heading">{tier.name}</h2>
        {tier.id === 'free' && <Chip tone="card">{PRICING.trialDays}-day Pro trial</Chip>}
      </div>
      <p className="mt-1.5 min-h-10 text-body text-muted-foreground">{tier.summary}</p>

      <div className="mt-6 flex items-baseline gap-2">
        <span className="serif-display text-numeral tabular-nums">
          {tier.id === 'pro' ? formatPrice(proPerMonth(billing)) : '$0'}
        </span>
        <span className="text-body text-muted-foreground">
          {tier.id === 'pro'
            ? billing === 'monthly'
              ? 'a month'
              : `a month, ${formatPrice(PRICING.proYearly)} billed yearly`
            : tier.id === 'free'
              ? 'after the trial'
              : 'no account'}
        </span>
      </div>

      <ul className="mt-7 flex-1 space-y-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex gap-3 text-body">
            <span
              aria-hidden
              className="mt-2 inline-flex size-1.5 shrink-0 rounded-full bg-foreground/50"
            />
            <span className="text-foreground/85">{feature}</span>
          </li>
        ))}
      </ul>

      <ButtonLink
        href={tier.cta.href}
        variant={tier.id === 'local' ? 'raised' : 'primary'}
        className="mt-8 w-full"
      >
        {tier.cta.label}
      </ButtonLink>
    </Surface>
  )
}
