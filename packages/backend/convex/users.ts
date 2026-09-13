import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { authedMutation, authedQuery } from './lib/functions'
import { planStateValidator } from './lib/plans'
import { findUserByClerkId, grantTrial, purgeUserData, toUserDto, upsertUser } from './lib/users'
import { userDtoValidator } from './lib/validators'

/** Current onboarding flow revision. Bump to send everyone through new account-level steps. */
export const ONBOARDING_VERSION = 1

/** The signed-in user's account record, or null until `ensure` has run once. */
export const me = authedQuery({
  args: {},
  returns: v.union(userDtoValidator, v.null()),
  handler: async (ctx) => (ctx.user ? toUserDto(ctx.user) : null)
})

/** Provision (or refresh) the account for the authenticated Clerk identity. Idempotent. */
export const ensure = authedMutation({
  args: {},
  returns: userDtoValidator,
  handler: async (ctx) => toUserDto(ctx.user)
})

/** Mark account-level onboarding done. Other devices then skip straight to device setup. */
export const completeOnboarding = authedMutation({
  args: { version: v.optional(v.number()) },
  returns: userDtoValidator,
  handler: async (ctx, args) => {
    const version = args.version ?? ONBOARDING_VERSION
    if (ctx.user.onboardingCompletedAt && (ctx.user.onboardingVersion ?? 0) >= version) {
      return toUserDto(ctx.user)
    }
    const now = Date.now()
    await ctx.db.patch('users', ctx.user._id, {
      onboardingCompletedAt: now,
      onboardingVersion: version,
      updatedAt: now
    })
    return toUserDto({
      ...ctx.user,
      onboardingCompletedAt: now,
      onboardingVersion: version,
      updatedAt: now
    })
  }
})

/**
 * Erase everything Murmur stores for this account. The Clerk user itself is managed through Clerk
 * (the `user.deleted` webhook purges the same data when the account is deleted there).
 */
export const deleteMyData = authedMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await purgeUserData(ctx, ctx.user._id)
    return null
  }
})

/** Clerk webhook: `user.created` / `user.updated`. */
export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string())
  },
  returns: v.id('users'),
  handler: async (ctx, args) => {
    const user = await upsertUser(
      ctx,
      args.clerkId,
      { email: args.email, name: args.name, imageUrl: args.imageUrl },
      Date.now()
    )
    return user._id
  }
})

/**
 * Move an account to another state by hand. Internal on purpose: run it from the Convex dashboard
 * (support, a comped account); Stripe drives the state through the billing webhook, and the
 * account itself can never change its own plan. `trial` starts a fresh 14 days.
 */
export const setPlan = internalMutation({
  args: { clerkId: v.string(), plan: planStateValidator },
  returns: userDtoValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await upsertUser(ctx, args.clerkId, {}, now)
    if (args.plan === 'trial') {
      return toUserDto(await grantTrial(ctx, { ...user, plan: 'trial' }, now))
    }
    if (user.plan !== args.plan) {
      await ctx.db.patch('users', user._id, { plan: args.plan, updatedAt: now })
    }
    return toUserDto({ ...user, plan: args.plan, updatedAt: now })
  }
})

/** Clerk webhook: `user.deleted`. Cascades to every table. */
export const purgeByClerkId = internalMutation({
  args: { clerkId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await findUserByClerkId(ctx, args.clerkId)
    if (!user) return false
    await purgeUserData(ctx, user._id)
    return true
  }
})
