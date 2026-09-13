import type { UserIdentity } from 'convex/server'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { TRIAL_MS, tierOf, type PlanState } from './plans'
import type { UserDto } from './validators'

export interface ClerkProfile {
  email?: string
  name?: string
  imageUrl?: string
}

export async function findUserByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string
): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
    .unique()
}

export function profileFromIdentity(identity: UserIdentity): ClerkProfile {
  const fallbackName = [identity.givenName, identity.familyName].filter(Boolean).join(' ').trim()
  const name = identity.name?.trim() || fallbackName || undefined
  return {
    email: identity.email ?? undefined,
    name,
    imageUrl: identity.pictureUrl ?? undefined
  }
}

/** The account's lifecycle state; rows from before the trial existed read as `free`. */
export function planStateOf(user: Pick<Doc<'users'>, 'plan'>): PlanState {
  return user.plan ?? 'free'
}

/**
 * Start (or restart) the 14-day Pro trial: the state becomes `trial` unless the account is paying,
 * and a scheduled function ends it on time so subscribed clients see the change without a request.
 */
export async function grantTrial(
  ctx: MutationCtx,
  user: Doc<'users'>,
  now: number,
  endsAt = now + TRIAL_MS
): Promise<Doc<'users'>> {
  const patch: Partial<Doc<'users'>> = {
    plan: user.plan === 'pro' ? 'pro' : 'trial',
    trialEndsAt: endsAt,
    updatedAt: now
  }
  await ctx.db.patch('users', user._id, patch)
  await ctx.scheduler.runAt(endsAt, internal.entitlements.endTrial, { userId: user._id })
  return { ...user, ...patch }
}

/** A trial whose end has passed becomes the free tier, whatever happened to the scheduled job. */
export async function reconcileTrial(
  ctx: MutationCtx,
  user: Doc<'users'>,
  now: number
): Promise<Doc<'users'>> {
  if (user.plan !== 'trial' || user.trialEndsAt === undefined || user.trialEndsAt > now) return user
  await ctx.db.patch('users', user._id, { plan: 'free', updatedAt: now })
  return { ...user, plan: 'free', updatedAt: now }
}

/** Bring a row's entitlement up to date: legacy rows get their trial, stale trials end. */
export async function settleEntitlement(
  ctx: MutationCtx,
  user: Doc<'users'>,
  now: number
): Promise<Doc<'users'>> {
  if (user.trialEndsAt === undefined) return await grantTrial(ctx, user, now)
  return await reconcileTrial(ctx, user, now)
}

/**
 * Insert or refresh the user row for a Clerk id. Profile fields only overwrite stored values when
 * the caller actually knows them, so a JWT without an email claim never blanks a webhook-provided one.
 * New accounts start their trial here.
 */
export async function upsertUser(
  ctx: MutationCtx,
  clerkId: string,
  profile: ClerkProfile,
  now: number
): Promise<Doc<'users'>> {
  const existing = await findUserByClerkId(ctx, clerkId)
  if (existing) {
    const patch: Partial<Doc<'users'>> = {}
    if (profile.email !== undefined && profile.email !== existing.email) patch.email = profile.email
    if (profile.name !== undefined && profile.name !== existing.name) patch.name = profile.name
    if (profile.imageUrl !== undefined && profile.imageUrl !== existing.imageUrl)
      patch.imageUrl = profile.imageUrl
    let user = existing
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch('users', existing._id, { ...patch, updatedAt: now })
      user = { ...existing, ...patch, updatedAt: now }
    }
    return await settleEntitlement(ctx, user, now)
  }
  const trialEndsAt = now + TRIAL_MS
  const id = await ctx.db.insert('users', {
    clerkId,
    email: profile.email,
    name: profile.name,
    imageUrl: profile.imageUrl,
    plan: 'trial',
    trialEndsAt,
    createdAt: now,
    updatedAt: now
  })
  await ctx.scheduler.runAt(trialEndsAt, internal.entitlements.endTrial, { userId: id })
  const inserted = await ctx.db.get('users', id)
  if (!inserted) throw new Error('Failed to create user')
  return inserted
}

/** Remove every record owned by a user, then the user itself. Used for account deletion. */
export async function purgeUserData(ctx: MutationCtx, userId: Id<'users'>): Promise<void> {
  const [
    devices,
    dictionaryEntries,
    snippets,
    appRules,
    preferences,
    stats,
    historyEntries,
    inferenceUsage,
    inferenceDays
  ] = await Promise.all([
    ctx.db
      .query('devices')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('dictionaryEntries')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('snippets')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('appRules')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('preferences')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('stats')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('historyEntries')
      .withIndex('by_user_and_createdAt', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('inferenceUsage')
      .withIndex('by_user_and_period', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('inferenceDays')
      .withIndex('by_user_and_day', (q) => q.eq('userId', userId))
      .collect()
  ])
  for (const doc of devices) await ctx.db.delete('devices', doc._id)
  for (const doc of dictionaryEntries) await ctx.db.delete('dictionaryEntries', doc._id)
  for (const doc of snippets) await ctx.db.delete('snippets', doc._id)
  for (const doc of appRules) await ctx.db.delete('appRules', doc._id)
  for (const doc of preferences) await ctx.db.delete('preferences', doc._id)
  for (const doc of stats) await ctx.db.delete('stats', doc._id)
  for (const doc of historyEntries) await ctx.db.delete('historyEntries', doc._id)
  for (const doc of inferenceUsage) await ctx.db.delete('inferenceUsage', doc._id)
  for (const doc of inferenceDays) await ctx.db.delete('inferenceDays', doc._id)
  await ctx.db.delete('users', userId)
}

export function toUserDto(user: Doc<'users'>): UserDto {
  const planState = planStateOf(user)
  return {
    id: user._id,
    clerkId: user.clerkId,
    email: user.email,
    name: user.name,
    imageUrl: user.imageUrl,
    plan: tierOf(planState),
    planState,
    trialEndsAt: user.trialEndsAt,
    onboardingCompletedAt: user.onboardingCompletedAt,
    onboardingVersion: user.onboardingVersion,
    createdAt: user.createdAt
  }
}
