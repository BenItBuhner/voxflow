import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { TRIAL_MS } from './lib/plans'
import { grantTrial, reconcileTrial } from './lib/users'

/**
 * The trial's clockwork. Accounts are created in `trial` with a `trialEndsAt`; `endTrial` runs at
 * that moment (scheduled by `lib/users.ts`), and `users.ensure` plus every gateway request also
 * settle a stale trial, so enforcement never depends on the scheduler alone.
 */

/** Scheduled at `trialEndsAt`: a trial that has run out becomes the free tier. No-op otherwise. */
export const endTrial = internalMutation({
  args: { userId: v.id('users') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await ctx.db.get('users', args.userId)
    if (!user) return false
    const settled = await reconcileTrial(ctx, user, Date.now())
    return settled.plan !== user.plan
  }
})

const BACKFILL_PAGE = 100

/**
 * One-off after deploying the trial: every account that predates it gets the 14 days from now.
 * Run `npx convex run entitlements:backfillTrials` once; it pages through `users` and schedules
 * itself until done. Idempotent: rows that already have a `trialEndsAt` are left alone.
 *
 *   trialEndsAt  fix the end for every page (defaults to now + 14 days on the first page, then
 *                carried along so late pages do not get a longer trial)
 */
export const backfillTrials = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), trialEndsAt: v.optional(v.number()) },
  returns: v.object({ granted: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now()
    const trialEndsAt = args.trialEndsAt ?? now + TRIAL_MS
    const page = await ctx.db
      .query('users')
      .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_PAGE })
    let granted = 0
    for (const user of page.page) {
      if (user.trialEndsAt !== undefined) continue
      await grantTrial(ctx, user, now, trialEndsAt)
      granted++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.entitlements.backfillTrials, {
        cursor: page.continueCursor,
        trialEndsAt
      })
    }
    return { granted, isDone: page.isDone }
  }
})
