import { useMemo } from 'react'
import {
  currentUsagePeriod,
  type InferenceStatus,
  type Plan,
  type PlanState,
  type UsageMeter,
  type UsageResets
} from '@shared/cloud'
import {
  llmConfigured,
  resolveInferenceSources,
  sttConfigured,
  type InferenceRouting
} from '@shared/inference'
import {
  accountUrlFrom,
  planStateLabel,
  planStateOf,
  trialDaysLeft,
  usageMeters
} from '@shared/limits'
import { useCloud } from './useCloud'
import { useSettings } from './useSettings'

export interface InferenceView {
  /** This build talks to a cloud instance, so Murmur models are a possible choice at all. */
  cloudEnabled: boolean
  /** The instance offers managed models (true until the account status says otherwise). */
  managedAvailable: boolean
  /** Murmur models can be offered in the UI: cloud build with a configured instance. */
  offersMurmur: boolean
  routing: InferenceRouting
  signedIn: boolean
  status: InferenceStatus | null
  plan: Plan
  /** Trial, free or Pro: the plan the account is on, as distinct from the tier whose limits apply. */
  planState: PlanState
  /** Whole days left on the Pro trial; 0 outside of one. */
  trialDaysLeft: number
  /** The rolling and monthly allowances of the tier, with what is used and when each resets. */
  meters: UsageMeter[]
  resets: UsageResets | null
  /** The web page that starts an upgrade, or null when the instance offers none (hide the button). */
  upgradeUrl: string | null
  /** The web account page (plan, invoices, cancellation), derived from the upgrade link. */
  accountUrl: string | null
  /** Pro past the soft fair-use cap: the formatting model is paused until the month resets. */
  formattingPaused: boolean
  /** Speech / formatting are ready to use for the resolved sources. */
  sttReady: boolean
  llmReady: boolean
  /** Managed speech minutes used and allowed this month. */
  minutes: { used: number; limit: number } | null
  /** Managed formatting tokens used this month. */
  tokensUsed: number
}

/** The resolved view of where speech and formatting run, shared by every settings page. */
export function useInference(): InferenceView {
  const { settings } = useSettings()
  const cloud = useCloud()
  const status = cloud.status?.inference ?? null
  const user = cloud.status?.user ?? null
  const signedIn = cloud.enabled && cloud.clerk.signedIn
  return useMemo(() => {
    const cloudEnabled = cloud.enabled && !!cloud.config?.convexSiteUrl
    const managedAvailable = status?.available ?? true
    const routing = resolveInferenceSources(settings, { cloudEnabled, managedAvailable })
    const period = currentUsagePeriod()
    const thisMonth = status && status.usage.period === period ? status.usage : null
    const usedSeconds = thisMonth?.sttSeconds ?? 0
    const upgradeUrl = status?.upgradeUrl ?? null
    const trialEndsAt = status?.trialEndsAt ?? user?.trialEndsAt ?? null
    return {
      cloudEnabled,
      managedAvailable,
      offersMurmur: cloudEnabled && managedAvailable,
      routing,
      signedIn,
      status,
      plan: status?.plan ?? user?.plan ?? 'free',
      planState: planStateOf(status, user),
      trialDaysLeft: trialDaysLeft(trialEndsAt),
      meters: usageMeters(status?.meters),
      resets: status?.resets ?? null,
      upgradeUrl,
      accountUrl: accountUrlFrom(upgradeUrl),
      formattingPaused: status?.formattingPaused ?? false,
      sttReady: sttConfigured(settings, routing, signedIn),
      llmReady: llmConfigured(settings, routing, signedIn),
      minutes: status
        ? { used: usedSeconds / 60, limit: status.limits.sttSecondsPerMonth / 60 }
        : null,
      tokensUsed: thisMonth?.llmTokens ?? 0
    }
  }, [settings, cloud.enabled, cloud.config?.convexSiteUrl, user, status, signedIn])
}

export function planLabel(plan: Plan): string {
  return plan === 'pro' ? 'Pro' : 'Free'
}

/** "Pro trial", "Free plan", "Pro plan": the plan as a title. */
export function planTitle(state: PlanState): string {
  return state === 'trial' ? 'Pro trial' : `${planStateLabel(state)} plan`
}

/** "12 of 120 min" style summary of the month's managed transcription. */
export function minutesLabel(minutes: { used: number; limit: number }): string {
  const used = minutes.used < 1 && minutes.used > 0 ? '<1' : Math.round(minutes.used).toString()
  return `${used} of ${Math.round(minutes.limit)} min this month`
}
