'use client'

import { SignIn, useClerk } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from 'convex/react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useSyncExternalStore } from 'react'
import { CheckoutNotice, PlanCard } from '@/components/account/plan-card'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { api, type DeviceDto, type StatsDto, type UserDto } from '@/lib/backend-api'
import { checkoutOutcome, upgradeIntent, usageDayUtc } from '@/lib/entitlements'
import { formatNumber, formatRelative } from '@/lib/format'
import { PRICING } from '@/lib/pricing'

const MINUTE = 60_000
const subscribeNever = (): (() => void) => () => {}
const readMinute = (): number => Math.floor(Date.now() / MINUTE) * MINUTE

/** The clock at minute resolution: stable within a render, so usage periods and "last seen" agree. */
function useNow(): number {
  return useSyncExternalStore(subscribeNever, readMinute, readMinute)
}

export function AccountView() {
  return (
    <>
      <AuthLoading>
        <Placeholder />
      </AuthLoading>
      <Unauthenticated>
        <SignedOut />
      </Unauthenticated>
      <Authenticated>
        <SignedInAccount />
      </Authenticated>
    </>
  )
}

function Placeholder() {
  return (
    <Surface className="min-h-64 animate-pulse-soft">
      <div className="well h-4 w-40 rounded-md" />
      <div className="well mt-4 h-4 w-72 rounded-md" />
    </Surface>
  )
}

function SignedOut() {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[1fr_auto]">
      <div className="max-w-lg">
        <h2 className="serif-display text-heading">Sign in to Murmur</h2>
        <p className="mt-3 text-lead text-muted-foreground">
          The same account the desktop and Android apps use. Your dictionary, snippets, style and
          stats follow it to every device; the model you dictate with and any keys of your own stay
          on the device.
        </p>
        <ul className="mt-6 space-y-2.5 text-body text-foreground/85">
          <li>{PRICING.trialDays} days of Pro to start, no card; a free tier after that.</li>
          <li>See your plan, the days left in the trial and your usage against each limit.</li>
          <li>Upgrade to Pro, change the card or cancel, all from here.</li>
          <li>Every device that has connected to the account.</li>
        </ul>
      </div>
      <div className="flex justify-center lg:justify-end">
        <SignIn routing="hash" withSignUp fallback={<Placeholder />} />
      </div>
    </div>
  )
}

function SignedInAccount() {
  const ensure = useMutation(api.users.ensure)
  useEffect(() => {
    // Provisions the account row on first contact (which starts the trial), exactly as the apps do.
    void ensure({})
  }, [ensure])

  const now = useNow()
  const params = useSearchParams()
  const upgrade = upgradeIntent(params.get('upgrade'))
  const checkout = checkoutOutcome(params.get('checkout'))

  const me = useQuery(api.users.me)
  // The backend keys daily usage by UTC day; passing it keeps the query stable within a day.
  const status = useQuery(api.inference.status, { day: usageDayUtc(now) })
  const billing = useQuery(api.billing.status)
  const stats = useQuery(api.stats.get)
  const devices = useQuery(api.devices.list)

  return (
    <div className="grid gap-card">
      {checkout && <CheckoutNotice outcome={checkout} planState={status?.planState ?? null} />}
      <ProfileCard user={me ?? null} />
      <div className="grid gap-card lg:grid-cols-[1.15fr_0.85fr]">
        <PlanCard status={status ?? null} billing={billing ?? null} now={now} upgrade={upgrade} />
        <StatsCard stats={stats ?? null} />
      </div>
      <DevicesCard devices={devices ?? null} />
    </div>
  )
}

function ProfileCard({ user }: { user: UserDto | null }) {
  const clerk = useClerk()
  const name = user?.name || 'Your account'
  return (
    <Surface className="flex flex-wrap items-center gap-4">
      {user?.imageUrl ? (
        // Clerk profile images come from a third-party host that changes per instance.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.imageUrl} alt="" className="size-12 rounded-full object-cover" />
      ) : (
        <span className="well inline-flex size-12 items-center justify-center rounded-full text-muted-foreground">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
          </svg>
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-lead font-semibold tracking-tight">{name}</div>
        {user?.email && (
          <div className="truncate text-note text-muted-foreground">{user.email}</div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="tonal" size="sm" onClick={() => void clerk.openUserProfile()}>
          Manage account
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void clerk.signOut({ redirectUrl: '/account' })}
        >
          Sign out
        </Button>
      </div>
    </Surface>
  )
}

function StatsCard({ stats }: { stats: StatsDto | null }) {
  const minutes = stats ? Math.round(stats.totalSpeechMs / 60_000) : 0
  const items = [
    { label: 'Words dictated', value: stats ? formatNumber(stats.totalWords) : '—' },
    { label: 'Dictations', value: stats ? formatNumber(stats.totalSessions) : '—' },
    { label: 'Minutes spoken', value: stats ? formatNumber(minutes) : '—' },
    { label: 'Day streak', value: stats ? formatNumber(stats.streakDays) : '—' }
  ]
  return (
    <Surface>
      <div className="eyebrow">Across your devices</div>
      <h2 className="serif-display mt-2 text-heading">Stats</h2>
      <dl className="mt-card grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item.label} className="well rounded-md px-4 py-3.5">
            <dt className="text-meta text-muted-foreground">{item.label}</dt>
            <dd className="serif-display mt-1 text-numeral tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      {stats?.lastSessionDay && (
        <p className="mt-3 text-meta text-muted-foreground">
          Last dictation on {stats.lastSessionDay}.
        </p>
      )}
    </Surface>
  )
}

const PLATFORM_NAMES: Record<DeviceDto['platform'], string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
  web: 'Web'
}

/* A list card: xl with tight padding, md rows. */
function DevicesCard({ devices }: { devices: DeviceDto[] | null }) {
  const now = useNow()
  return (
    <Surface padding="card-tight">
      <div className="px-3 pt-3 pb-4">
        <div className="eyebrow">Devices</div>
        <h2 className="serif-display mt-2 text-heading">Every install on this account</h2>
        <p className="mt-2 text-body text-muted-foreground">
          Removing a device is done from the app’s Account page; sign out on the device itself to
          end its session.
        </p>
      </div>
      {devices === null ? (
        <div className="well h-14 rounded-md animate-pulse-soft" />
      ) : devices.length === 0 ? (
        <div className="well rounded-md px-4 py-6 text-center text-body text-muted-foreground">
          No device has signed in yet.{' '}
          <Link
            href="/download"
            className="text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
          >
            Download Murmur
          </Link>{' '}
          and sign in there.
        </div>
      ) : (
        <ul className="grid gap-card-tight">
          {devices.map((device) => (
            <li
              key={device.deviceId}
              className="well flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-md px-4 py-3"
            >
              <span className="text-body font-medium">{device.name}</span>
              <span className="text-note text-muted-foreground tabular-nums">
                {PLATFORM_NAMES[device.platform]} · Murmur {device.appVersion} · last seen{' '}
                {formatRelative(device.lastSeenAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  )
}
