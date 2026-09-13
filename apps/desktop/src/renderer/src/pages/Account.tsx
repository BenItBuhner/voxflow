import React, { useState } from 'react'
import { useClerk } from '@clerk/electron/react'
import {
  BookA,
  Clock3,
  Laptop,
  LogOut,
  Monitor,
  RefreshCw,
  Settings2,
  Smartphone,
  Sparkles,
  Trash2,
  UserRound,
  Zap
} from 'lucide-react'
import { toast } from 'sonner'
import type { CloudDevice, UsageMeter } from '@shared/cloud'
import { formatResetTime, meterLabel, meterValue, planStateLabel } from '@shared/limits'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Badge, Banner } from '@renderer/components/ui/misc'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { PageHeader, Section, SettingRow } from '@renderer/components/SettingRow'
import { SyncBadge, syncLabel } from '@renderer/components/SyncBadge'
import { useCloud } from '@renderer/hooks/useCloud'
import {
  minutesLabel,
  planTitle,
  useInference,
  type InferenceView
} from '@renderer/hooks/useInference'
import { useSettings } from '@renderer/hooks/useSettings'
import { cn, formatNumber, formatRelative } from '@renderer/lib/utils'

export function AccountPage(): React.JSX.Element {
  const { clerk } = useCloud()
  const { settings, patch } = useSettings()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  if (!clerk.signedIn) {
    return (
      <div className="space-y-section">
        <PageHeader
          title="Account"
          description="Your Murmur account keeps your dictionary, snippets and style in step on every device."
        />
        <div className="surface-raised rounded-xl p-card">
          <div className="flex items-start gap-4">
            <div className="well flex size-12 shrink-0 items-center justify-center rounded-full text-muted-foreground">
              <UserRound className="size-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-lead font-semibold tracking-tight">
                You are using Murmur without an account
              </div>
              <p className="text-note text-muted-foreground">
                Everything lives on this computer. Sign in to sync your {settings.dictionary.length}{' '}
                dictionary {settings.dictionary.length === 1 ? 'word' : 'words'},{' '}
                {settings.snippets.length} {settings.snippets.length === 1 ? 'snippet' : 'snippets'}{' '}
                and style settings to your other devices, including Android. Your local data is
                merged into the account the first time you sign in.
              </p>
              {clerk.failed && (
                <p className="text-note text-destructive">
                  Murmur sign-in is unreachable right now; you can still sign in once you are back
                  online.
                </p>
              )}
            </div>
            <Button onClick={() => void patch({ cloud: { accountSkipped: false } })}>
              <UserRound /> Sign in or create account
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <SignedInAccount
      deleteOpen={deleteOpen}
      setDeleteOpen={setDeleteOpen}
      busy={busy}
      setBusy={setBusy}
    />
  )
}

function SignedInAccount({
  deleteOpen,
  setDeleteOpen,
  busy,
  setBusy
}: {
  deleteOpen: boolean
  setDeleteOpen: (v: boolean) => void
  busy: string | null
  setBusy: (v: string | null) => void
}): React.JSX.Element {
  const { status, clerk, config } = useCloud()
  const { settings } = useSettings()
  const inference = useInference()
  const clerkClient = useClerk()

  const user = status?.user
  const name = user?.name ?? clerk.name ?? 'Your account'
  const email = user?.email ?? clerk.email
  const imageUrl = user?.imageUrl ?? clerk.imageUrl
  const sync = status ? syncLabel(status) : null

  const signOut = async (): Promise<void> => {
    setBusy('signout')
    try {
      await clerkClient.signOut()
    } finally {
      setBusy(null)
    }
  }

  const removeDevice = async (device: CloudDevice): Promise<void> => {
    setBusy(device.deviceId)
    const r = await window.murmur.cloud.removeDevice(device.deviceId)
    setBusy(null)
    if (r.ok) toast.success(`Removed ${device.name}`)
    else toast.error(r.error ?? 'Could not remove device')
  }

  const deleteData = async (): Promise<void> => {
    setBusy('delete')
    const r = await window.murmur.cloud.deleteData()
    setBusy(null)
    setDeleteOpen(false)
    if (r.ok) toast.success('Your synced data was deleted')
    else toast.error(r.error ?? 'Could not delete data')
  }

  return (
    <div className="space-y-section">
      <PageHeader
        title="Account"
        description="Your Murmur account keeps your dictionary, snippets and style in step on every device."
        actions={<SyncBadge />}
      />

      <div className="surface-raised flex items-center gap-4 rounded-xl p-card">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="size-12 rounded-full object-cover" />
        ) : (
          <div className="well flex size-12 items-center justify-center rounded-full text-muted-foreground">
            <UserRound className="size-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-lead font-semibold tracking-tight">{name}</div>
          {email && <div className="truncate text-note text-muted-foreground">{email}</div>}
        </div>
        <Button variant="outline" size="sm" onClick={() => void clerkClient.openUserProfile()}>
          <Settings2 /> Manage account
        </Button>
        <Button variant="ghost" size="sm" onClick={signOut} disabled={busy === 'signout'}>
          <LogOut /> Sign out
        </Button>
      </div>

      <PlanSection inference={inference} />

      <Section
        title="Sync"
        description="Changes made here are saved to your account within seconds and reach your other devices as soon as they connect."
      >
        <SettingRow
          title={sync ? sync.label : 'Sync'}
          description={
            sync
              ? status?.lastSyncedAt
                ? `${sync.hint}. Last synced ${formatRelative(status.lastSyncedAt)}.`
                : sync.hint
              : ''
          }
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.murmur.cloud.syncNow()}
            disabled={!status?.signedIn}
          >
            <RefreshCw /> Sync now
          </Button>
        </SettingRow>
        <SettingRow title="What syncs" vertical>
          <div className="grid w-full gap-2 sm:grid-cols-2">
            {[
              { icon: <BookA />, label: 'Dictionary', count: settings.dictionary.length },
              { icon: <Zap />, label: 'Snippets', count: settings.snippets.length },
              {
                icon: <Sparkles />,
                label: 'Style, tone and app rules',
                count: settings.formatting.appRules.length
              },
              { icon: <Clock3 />, label: 'Dictation stats', count: settings.stats.totalSessions }
            ].map((item) => (
              <div
                key={item.label}
                className="well flex items-center gap-2.5 rounded-md px-3.5 py-2.5 text-note [&>svg]:size-4 [&>svg]:text-muted-foreground"
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                <span className="tabular-nums text-muted-foreground">{item.count}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-meta text-muted-foreground">
            Your choice of speech model and any API keys of your own are device settings and are
            never uploaded.
          </p>
        </SettingRow>
        <SettingRow
          title="Sync dictation history"
          description="Also keep the text of your dictations in your account so History shows what you dictated on other devices. Off by default because history contains what you said."
        >
          <Switch
            checked={settings.cloud.historySync}
            onCheckedChange={(v) => void window.murmur.cloud.setHistorySync(v)}
            disabled={!status?.signedIn}
          />
        </SettingRow>
      </Section>

      <Section
        title="Devices"
        description="Every install that has connected to your account. Removing one only forgets it here; sign out on the device itself to end its session."
      >
        {(status?.devices ?? []).length === 0 ? (
          <div className="py-4 text-center text-note text-muted-foreground">
            {status?.signedIn ? 'Waiting for the device list…' : 'Sign in to see your devices.'}
          </div>
        ) : (
          (status?.devices ?? []).map((d) => (
            <SettingRow
              key={d.deviceId}
              title={
                <span className="inline-flex items-center gap-2">
                  <DeviceIcon platform={d.platform} />
                  {d.name}
                  {d.current && <Badge variant="secondary">This device</Badge>}
                </span>
              }
              description={`${platformLabel(d.platform)} · Murmur ${d.appVersion} · last seen ${formatRelative(d.lastSeenAt)}`}
            >
              {!d.current && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Remove device"
                  disabled={busy === d.deviceId}
                  onClick={() => void removeDevice(d)}
                >
                  <Trash2 />
                </Button>
              )}
            </SettingRow>
          ))
        )}
      </Section>

      <Section title="Data">
        <SettingRow
          title="Delete synced data"
          description="Erases your dictionary, snippets, rules, preferences, stats and synced history from your account. Your sign-in stays; delete the account itself from Manage account."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            disabled={!status?.authenticated}
          >
            <Trash2 /> Delete
          </Button>
        </SettingRow>
        {config && (
          <SettingRow title="Instance" description={config.convexUrl}>
            <Badge variant="outline">
              {config.accountMode === 'required' ? 'account required' : 'account optional'}
            </Badge>
          </SettingRow>
        )}
      </Section>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete everything Murmur stores for you?</DialogTitle>
            <DialogDescription>
              Your dictionary, snippets, style rules, preferences, stats and synced history are
              removed from your account and from every signed-in device. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteData} disabled={busy === 'delete'}>
              Delete my data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** What the plan means for the account right now, in one sentence. */
function planDescription(inference: InferenceView): string {
  if (!inference.managedAvailable)
    return 'This Murmur instance does not provide models of its own; connect your provider under Models.'
  if (!inference.status) return 'Waiting for your account status…'
  switch (inference.planState) {
    case 'trial':
      return `${inference.trialDaysLeft === 1 ? '1 day' : `${inference.trialDaysLeft} days`} left with everything Pro offers, no card needed. Afterwards the free plan carries on with a weekly allowance; upgrade whenever you want to keep dictating without one.`
    case 'pro':
      return inference.formattingPaused
        ? 'Unlimited dictation within fair use. The formatting model is paused for the rest of this month; your text is still transcribed and tidied by rules.'
        : 'Unlimited dictation within fair use: the meters below show how far this month has come. Manage the subscription from your account page.'
    default:
      return 'A weekly allowance of free words and speech, a handful of dictations a day, clips up to a minute. Upgrade for unlimited dictation, or connect your own provider under Models.'
  }
}

/**
 * The account's plan: where it stands (trial, free, Pro), how much of each allowance is used and
 * when it comes back, and the one action that changes it. Upgrade opens the web account page; the
 * button is only shown when the instance has one.
 */
function PlanSection({ inference }: { inference: InferenceView }): React.JSX.Element {
  const open = (url: string | null): void => {
    if (url) void window.murmur.app.openExternal(url)
  }
  const upgrade = inference.planState !== 'pro' ? inference.upgradeUrl : null
  const paused = inference.meters.find((m) => m.limit === 'fairUseSttSecondsPerMonth')
  return (
    <Section
      title="Plan"
      description={
        inference.managedAvailable
          ? 'The speech and formatting models that come with your account. Choose your own provider instead under Models and Style; keys for those stay on this device.'
          : undefined
      }
    >
      <SettingRow title={planTitle(inference.planState)} description={planDescription(inference)}>
        <Badge
          variant={
            inference.planState === 'pro'
              ? 'success'
              : inference.planState === 'trial'
                ? 'default'
                : 'secondary'
          }
        >
          {inference.planState === 'trial' && inference.trialDaysLeft > 0
            ? `${inference.trialDaysLeft}d left`
            : planStateLabel(inference.planState)}
        </Badge>
        {upgrade && (
          <Button size="sm" onClick={() => open(upgrade)}>
            <Sparkles /> Upgrade
          </Button>
        )}
        {inference.planState === 'pro' && inference.accountUrl && (
          <Button variant="outline" size="sm" onClick={() => open(inference.accountUrl)}>
            <Settings2 /> Manage plan
          </Button>
        )}
      </SettingRow>
      {inference.formattingPaused && paused && (
        <Banner tone="warning" className="my-2">
          <div className="text-sm font-medium">
            Formatting paused until {formatResetTime(paused.resetsAt).replace(/^on /, '')}
          </div>
          <div className="text-note text-muted-foreground">
            Past {meterValue(paused).split(' of ')[1]} of transcription this month, Murmur inserts
            your words with rule-based cleanup only (fair use). Nothing else changes.
          </div>
        </Banner>
      )}
      {inference.meters.length > 0
        ? inference.meters.map((m) => <MeterRow key={m.limit} meter={m} />)
        : inference.status &&
          inference.minutes && (
            <SettingRow
              title="Used this month"
              description={
                inference.routing.stt === 'murmur'
                  ? 'Murmur’s speech model is in use on this device.'
                  : 'This device uses your own speech provider; the allowance is untouched by it.'
              }
            >
              <span className="text-note tabular-nums text-muted-foreground">
                {minutesLabel(inference.minutes)} · {formatNumber(inference.tokensUsed)} tokens
              </span>
            </SettingRow>
          )}
      {inference.meters.length > 0 && inference.routing.stt !== 'murmur' && (
        <p className="pt-2 text-meta text-muted-foreground">
          This device uses your own speech provider; only devices on Murmur’s models count here.
        </p>
      )}
    </Section>
  )
}

/** One allowance: a track that fills as it is used, the figure, and when it resets. */
function MeterRow({ meter }: { meter: UsageMeter }): React.JSX.Element {
  const share = meter.allowed > 0 ? Math.min(1, meter.used / meter.allowed) : 0
  const reset = formatResetTime(meter.resetsAt)
  return (
    <SettingRow
      title={meterLabel(meter.limit)}
      description={
        meter.exceeded
          ? `Used up · more ${reset}`
          : `Resets ${reset.startsWith('on ') ? reset.slice(3) : reset}`
      }
    >
      <div className="flex w-56 items-center gap-3">
        <div className="well h-1.5 flex-1 overflow-hidden rounded-full">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              meter.exceeded ? 'bg-warning' : share >= 0.9 ? 'bg-record' : 'bg-primary'
            )}
            style={{ width: `${Math.max(2, share * 100)}%` }}
          />
        </div>
        <span className="w-32 text-right text-meta tabular-nums text-muted-foreground">
          {meterValue(meter)}
        </span>
      </div>
    </SettingRow>
  )
}

function DeviceIcon({ platform }: { platform: string }): React.JSX.Element {
  const cls = 'size-4 text-muted-foreground'
  if (platform === 'android' || platform === 'ios') return <Smartphone className={cls} />
  if (platform === 'darwin') return <Laptop className={cls} />
  return <Monitor className={cls} />
}

function platformLabel(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    case 'android':
      return 'Android'
    case 'ios':
      return 'iOS'
    default:
      return platform
  }
}
