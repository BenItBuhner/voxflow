'use client'

import { useAction } from 'convex/react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import { api, type BillingStatus, type InferenceStatus } from '@/lib/backend-api'
import { cn } from '@/lib/cn'
import {
  describeReset,
  displayedMeters,
  exhaustedNotice,
  formatLongDate,
  formatUtcDate,
  meterView,
  planLabel,
  trialDaysLeft,
  type BillingInterval,
  type MeterView
} from '@/lib/entitlements'
import { formatNumber, usagePeriod } from '@/lib/format'
import { formatPrice, PRICING, proPerMonth } from '@/lib/pricing'

/*
 * The plan card: where the account stands (trial, free tier or Pro), every meter that applies,
 * and the way up or out. Checkout and the billing portal are Stripe pages the backend hands us a
 * URL for; without billing configured the upgrade panel says so instead of pretending.
 */
export function PlanCard({
  status,
  billing,
  now,
  upgrade
}: {
  status: InferenceStatus | null
  billing: BillingStatus | null
  now: number
  upgrade: BillingInterval | null
}) {
  const state = status?.planState ?? 'free'
  const period = usagePeriod(now)
  const thisMonth = status && status.usage.period === period ? status.usage : null
  const requests = (thisMonth?.sttRequests ?? 0) + (thisMonth?.llmRequests ?? 0)
  const meters = status ? displayedMeters(status).map(meterView) : []
  const notice = status ? exhaustedNotice(status, now) : null

  return (
    <Surface className="flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow">Plan</div>
          <h2 className="serif-display mt-2 text-heading">{status ? planLabel(state) : '…'}</h2>
        </div>
        {status && (
          <Chip tone={state === 'pro' ? 'success' : state === 'trial' ? 'card' : 'well'}>
            {planLabel(state)}
          </Chip>
        )}
      </div>

      <p className="mt-2 text-body text-muted-foreground">
        {status ? (
          <PlanSummary status={status} billing={billing} now={now} />
        ) : (
          'Waiting for your account status…'
        )}
      </p>

      {notice && <Notice tone={status?.plan === 'free' ? 'record' : 'warning'}>{notice}</Notice>}
      {billing?.subscription?.paymentFailedAt != null &&
        billing.subscription.status !== 'canceled' && (
          <Notice tone="record">
            The last payment did not go through. Update the card under Manage billing; Stripe
            retries for a few days before Pro pauses.
          </Notice>
        )}

      {status && status.available && (
        <div className="mt-card grid gap-2">
          {meters.map((meter) => (
            <MeterBar key={meter.limit} meter={meter} now={now} />
          ))}
          <div className="well flex items-baseline justify-between rounded-md px-4 py-3 text-note">
            <span className="text-muted-foreground">Requests this month</span>
            <span className="font-medium tabular-nums">{formatNumber(requests)}</span>
          </div>
        </div>
      )}

      {status && state !== 'pro' && (
        <UpgradePanel billing={billing} initial={upgrade ?? 'year'} state={state} />
      )}
      {status && state === 'pro' && <BillingPanel billing={billing} />}
    </Surface>
  )
}

function PlanSummary({
  status,
  billing,
  now
}: {
  status: InferenceStatus
  billing: BillingStatus | null
  now: number
}) {
  if (!status.available)
    return (
      <>
        This Murmur instance does not provide models of its own; the apps use the provider you
        connect under Models.
      </>
    )
  if (status.planState === 'trial') {
    const days = status.trialEndsAt ? trialDaysLeft(status.trialEndsAt, now) : 0
    return (
      <>
        {days === 0 ? 'Ends today' : days === 1 ? 'One day left' : `${days} days left`}
        {status.trialEndsAt ? `, until ${formatUtcDate(status.trialEndsAt)}` : ''}. Everything Pro
        has: unlimited words within fair use, clips up to{' '}
        {Math.round(status.limits.maxClipSeconds / 60)} minutes, {status.limits.requestsPerMinute}{' '}
        requests a minute. Then the free tier: {PRICING.freeWordsPerWeek} words a week, unless you
        upgrade.
      </>
    )
  }
  if (status.planState === 'free')
    return (
      <>
        {PRICING.freeWordsPerWeek} words a week on Murmur’s speech and formatting models,{' '}
        {PRICING.freeAudioMinutesPerWeek} minutes of audio a week, {PRICING.freeDictationsPerDay}{' '}
        dictations a day, clips up to a minute. Your dictionary, snippets, style and stats keep
        syncing.
      </>
    )
  const sub = billing?.subscription
  return (
    <>
      Unlimited words within fair use: {PRICING.proFairUseHours} hours of audio a month, clips up to{' '}
      {Math.round(status.limits.maxClipSeconds / 60)} minutes, {status.limits.requestsPerMinute}{' '}
      requests a minute.{' '}
      {sub
        ? sub.cancelAtPeriodEnd
          ? `Cancelled: Pro stays on until ${formatLongDate(sub.currentPeriodEnd)}, then the free tier.`
          : `Renews ${formatLongDate(sub.currentPeriodEnd)}, ${sub.interval === 'year' ? `${formatPrice(PRICING.proYearly)} a year` : `${formatPrice(PRICING.proMonthly)} a month`}.`
        : 'Granted by the operator; nothing to pay.'}
    </>
  )
}

function Notice({ tone, children }: { tone: 'record' | 'warning'; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'mt-4 rounded-lg px-4 py-3 text-body',
        tone === 'record' ? 'bg-record/12 text-foreground' : 'bg-warning/16 text-foreground'
      )}
    >
      {children}
    </div>
  )
}

/* A meter: the label and figure over a track; the track is the one functional thin mark. */
function MeterBar({ meter, now }: { meter: MeterView; now: number }) {
  return (
    <div className="well rounded-md px-4 py-3">
      <div className="flex items-baseline justify-between gap-4 text-note">
        <span className="text-muted-foreground">{meter.label}</span>
        <span className="font-medium tabular-nums">{meter.display}</span>
      </div>
      <div
        className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-input"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={meter.allowed}
        aria-valuenow={Math.min(meter.used, meter.allowed)}
        aria-label={meter.label}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            meter.ratio >= 0.9 ? 'bg-record' : 'bg-foreground/70'
          )}
          style={{ width: `${Math.round(meter.ratio * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 text-caption text-muted-foreground">
        {meter.exceeded ? 'Frees up' : 'Moves'} {describeReset(meter.resetsAt, now)}
      </div>
    </div>
  )
}

/** Monthly or yearly, then Stripe Checkout. */
function UpgradePanel({
  billing,
  initial,
  state
}: {
  billing: BillingStatus | null
  initial: BillingInterval
  state: 'trial' | 'free'
}) {
  const [interval, setInterval] = useState<BillingInterval>(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createCheckout = useAction(api.billing.createCheckoutSession)
  const configured = billing?.configured === true
  const price = interval === 'year' ? PRICING.proYearly : PRICING.proMonthly

  const start = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const { url } = await createCheckout({ interval })
      window.location.assign(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setPending(false)
    }
  }

  return (
    <div className="well mt-card rounded-md px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-body font-medium">
            {state === 'trial' ? 'Keep Pro after the trial' : 'Upgrade to Pro'}
          </div>
          <div className="mt-0.5 text-meta text-muted-foreground">
            {formatPrice(proPerMonth(interval === 'year' ? 'yearly' : 'monthly'))} a month
            {interval === 'year'
              ? `, ${formatPrice(PRICING.proYearly)} billed yearly`
              : ', billed monthly'}
            . Cancel any time from this page.
          </div>
        </div>
        <IntervalToggle value={interval} onChange={setInterval} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void start()} disabled={!configured || pending}>
          {pending
            ? 'Opening Stripe…'
            : `Upgrade to Pro, ${formatPrice(price)} ${interval === 'year' ? 'a year' : 'a month'}`}
        </Button>
        <span className="text-meta text-muted-foreground">
          {configured ? (
            <>
              Card payment on Stripe’s checkout page. See the{' '}
              <Link href="/terms" className="underline decoration-foreground/30 underline-offset-4">
                terms
              </Link>
              .
            </>
          ) : billing ? (
            'Checkout opens here when billing goes live on this instance.'
          ) : (
            'Checking billing…'
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-note text-record">
          {error}
        </p>
      )}
    </div>
  )
}

/** Segmented control as on the pricing page: a well track with an ink thumb. */
function IntervalToggle({
  value,
  onChange
}: {
  value: BillingInterval
  onChange: (interval: BillingInterval) => void
}) {
  const options: Array<{ value: BillingInterval; label: string; hint?: string }> = [
    { value: 'month', label: 'Monthly' },
    { value: 'year', label: 'Yearly', hint: 'save 20%' }
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Billing period"
      className="inline-flex h-10 items-center rounded-full bg-card p-1 shadow-raised"
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
              'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-note font-medium transition-colors duration-200',
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

/** Stripe's Customer Portal: card, interval, invoices, cancellation. */
function BillingPanel({ billing }: { billing: BillingStatus | null }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createPortal = useAction(api.billing.createPortalSession)
  const open = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const { url } = await createPortal({})
      window.location.assign(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open billing')
      setPending(false)
    }
  }
  if (!billing) return null
  return (
    <div className="well mt-card flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-3.5">
      <div>
        <div className="text-body font-medium">Billing</div>
        <div className="text-meta text-muted-foreground">
          {billing.portalAvailable
            ? 'Change the card, switch between monthly and yearly, download invoices or cancel.'
            : 'This subscription is not managed through Stripe.'}
        </div>
      </div>
      {billing.portalAvailable && (
        <Button
          variant="tonal"
          size="sm"
          onClick={() => void open()}
          disabled={pending || !billing.configured}
        >
          {pending ? 'Opening Stripe…' : 'Manage billing'}
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-note text-record">
          {error}
        </p>
      )}
    </div>
  )
}

/** Stripe sent the visitor back here. */
export function CheckoutNotice({
  outcome,
  planState
}: {
  outcome: 'success' | 'cancelled'
  planState: InferenceStatus['planState'] | null
}) {
  if (outcome === 'cancelled')
    return (
      <Notice tone="warning">
        Checkout was cancelled and nothing was charged. Your plan is unchanged.
      </Notice>
    )
  return (
    <div role="status" className="rounded-xl bg-success/12 px-5 py-4 text-body">
      {planState === 'pro' ? (
        <>Thank you. You are on Pro; every device on this account has it now.</>
      ) : (
        <>
          Thank you. Pro switches on as soon as Stripe confirms the payment, usually within a few
          seconds; this page updates by itself.
        </>
      )}
    </div>
  )
}
