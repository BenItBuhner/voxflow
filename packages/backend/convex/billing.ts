import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { action, httpAction, internalMutation, type MutationCtx } from './_generated/server'
import { authedQuery } from './lib/functions'
import { subjectOf, upgradeUrlFor } from './lib/inference'
import { billingIntervalValidator, planStateValidator } from './lib/plans'
import {
  StripeApiError,
  StripeSignatureError,
  billingConfigured,
  checkoutSessionParams,
  entitlesPro,
  parseStripeEvent,
  portalSessionParams,
  readStripeConfig,
  stripeRequest,
  subscriptionSnapshot,
  verifyStripeSignature,
  type SubscriptionSnapshot
} from './lib/stripe'
import { findUserByClerkId, planStateOf, upsertUser } from './lib/users'
import {
  billingStatusValidator,
  subscriptionStatusValidator,
  type BillingStatus
} from './lib/validators'

/**
 * Pro subscriptions through Stripe. The account page asks for a Checkout or Portal URL through the
 * two actions; Stripe reports back to `/stripe/webhook`, and the internal mutations here are the
 * only code that turns a subscription into a plan state. Without keys everything degrades: the
 * status says `configured: false`, the actions throw a readable error, the webhook answers 500.
 */

/** What the account page shows about billing. */
export const status = authedQuery({
  args: {},
  returns: billingStatusValidator,
  handler: async (ctx): Promise<BillingStatus> => {
    const sub = ctx.user?.subscription
    return {
      configured: billingConfigured(process.env),
      portalAvailable: Boolean(ctx.user?.stripeCustomerId),
      upgradeUrl: upgradeUrlFor(process.env, ctx.user ? planStateOf(ctx.user) : 'free'),
      subscription: sub
        ? {
            status: sub.status,
            interval: sub.interval,
            currentPeriodEnd: sub.currentPeriodEnd,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            paymentFailedAt: sub.paymentFailedAt ?? null
          }
        : null
    }
  }
})

async function requireSubject(ctx: {
  auth: { getUserIdentity(): Promise<{ subject: string } | null> }
}): Promise<string> {
  const subject = await subjectOf(ctx.auth)
  if (!subject) throw new ConvexError('Not authenticated')
  return subject
}

/** A Stripe Checkout Session for Pro; the browser is sent to `url`. */
export const createCheckoutSession = action({
  args: { interval: billingIntervalValidator },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const clerkId = await requireSubject(ctx)
    const config = readStripeConfig(process.env)
    if (!config || !config.siteUrl)
      throw new ConvexError('Billing is not switched on for this Murmur instance yet')
    const account = await ctx.runMutation(internal.billing.accountForCheckout, { clerkId })
    if (account.planState === 'pro') throw new ConvexError('This account is already on Pro')
    let session: { url?: string | null }
    try {
      session = await stripeRequest<{ url?: string | null }>(
        config.secretKey,
        'POST',
        '/v1/checkout/sessions',
        checkoutSessionParams(config, {
          clerkId,
          email: account.email,
          customerId: account.stripeCustomerId,
          interval: args.interval
        })
      )
    } catch (err) {
      console.error('[billing] checkout session failed', err instanceof Error ? err.message : err)
      throw new ConvexError(
        err instanceof StripeApiError
          ? `Stripe could not start Checkout: ${err.message}`
          : 'Could not reach Stripe'
      )
    }
    if (!session.url) throw new ConvexError('Stripe did not return a Checkout URL')
    return { url: session.url }
  }
})

/** The Stripe Customer Portal: cancel, switch interval, change the card, download invoices. */
export const createPortalSession = action({
  args: {},
  returns: v.object({ url: v.string() }),
  handler: async (ctx) => {
    const clerkId = await requireSubject(ctx)
    const config = readStripeConfig(process.env)
    if (!config || !config.siteUrl)
      throw new ConvexError('Billing is not switched on for this Murmur instance yet')
    const account = await ctx.runMutation(internal.billing.accountForCheckout, { clerkId })
    if (!account.stripeCustomerId)
      throw new ConvexError('This account has no billing history to manage yet')
    let session: { url?: string | null }
    try {
      session = await stripeRequest<{ url?: string | null }>(
        config.secretKey,
        'POST',
        '/v1/billing_portal/sessions',
        portalSessionParams(config, account.stripeCustomerId)
      )
    } catch (err) {
      console.error('[billing] portal session failed', err instanceof Error ? err.message : err)
      throw new ConvexError(
        err instanceof StripeApiError
          ? `Stripe could not open billing: ${err.message}`
          : 'Could not reach Stripe'
      )
    }
    if (!session.url) throw new ConvexError('Stripe did not return a billing URL')
    return { url: session.url }
  }
})

/** What the actions need to know about the account, provisioning it if necessary. */
export const accountForCheckout = internalMutation({
  args: { clerkId: v.string() },
  returns: v.object({
    email: v.optional(v.string()),
    planState: planStateValidator,
    stripeCustomerId: v.optional(v.string())
  }),
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx, args.clerkId, {}, Date.now())
    return {
      email: user.email,
      planState: planStateOf(user),
      stripeCustomerId: user.stripeCustomerId
    }
  }
})

async function findByCustomer(ctx: MutationCtx, customerId: string): Promise<Doc<'users'> | null> {
  return await ctx.db
    .query('users')
    .withIndex('by_stripeCustomerId', (q) => q.eq('stripeCustomerId', customerId))
    .unique()
}

async function resolveUser(
  ctx: MutationCtx,
  clerkId: string | null,
  customerId: string | null
): Promise<Doc<'users'> | null> {
  if (clerkId) {
    const byClerk = await findUserByClerkId(ctx, clerkId)
    if (byClerk) return byClerk
  }
  return customerId ? await findByCustomer(ctx, customerId) : null
}

/** The state an account falls back to when its subscription stops paying for Pro. */
function stateWithoutSubscription(user: Doc<'users'>, now: number): 'trial' | 'free' {
  return user.trialEndsAt !== undefined && user.trialEndsAt > now ? 'trial' : 'free'
}

const snapshotValidator = v.object({
  id: v.string(),
  status: subscriptionStatusValidator,
  priceId: v.string(),
  interval: billingIntervalValidator,
  currentPeriodEnd: v.number(),
  cancelAtPeriodEnd: v.boolean(),
  customerId: v.union(v.string(), v.null()),
  clerkId: v.union(v.string(), v.null())
})

/**
 * A subscription as Stripe last reported it becomes the account's plan. Older events (by
 * `eventAt`) for the same subscription are ignored, so retries and reordering are harmless.
 */
export const applySubscription = internalMutation({
  args: { subscription: snapshotValidator, eventAt: v.number() },
  returns: v.union(v.literal('applied'), v.literal('stale'), v.literal('unknown_account')),
  handler: async (ctx, args) => {
    const sub = args.subscription
    const user = await resolveUser(ctx, sub.clerkId, sub.customerId)
    if (!user) return 'unknown_account'
    const current = user.subscription
    if (current && current.id === sub.id && current.eventAt > args.eventAt) return 'stale'
    // A newer subscription replaces an older one; an update to an old, replaced one is ignored.
    if (current && current.id !== sub.id && entitlesPro(current.status) && !entitlesPro(sub.status))
      return 'stale'
    const now = Date.now()
    const pro = entitlesPro(sub.status)
    const paymentFailedAt =
      sub.status === 'past_due' ? (current?.paymentFailedAt ?? args.eventAt) : undefined
    await ctx.db.patch('users', user._id, {
      plan: pro ? 'pro' : stateWithoutSubscription(user, now),
      stripeCustomerId: sub.customerId ?? user.stripeCustomerId,
      subscription: {
        id: sub.id,
        status: sub.status,
        priceId: sub.priceId,
        interval: sub.interval,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        paymentFailedAt,
        eventAt: args.eventAt
      },
      updatedAt: now
    })
    return 'applied'
  }
})

/** A failed invoice: keep Pro (Stripe retries), flag it so the account page can say so. */
export const markPaymentFailed = internalMutation({
  args: {
    customerId: v.union(v.string(), v.null()),
    subscriptionId: v.union(v.string(), v.null()),
    failedAt: v.number()
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = args.customerId ? await findByCustomer(ctx, args.customerId) : null
    if (!user?.subscription) return false
    if (args.subscriptionId && user.subscription.id !== args.subscriptionId) return false
    await ctx.db.patch('users', user._id, {
      subscription: { ...user.subscription, paymentFailedAt: args.failedAt },
      updatedAt: Date.now()
    })
    return true
  }
})

/** Remember the Stripe customer a Checkout created for an account. */
export const attachCustomer = internalMutation({
  args: { clerkId: v.string(), customerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await findUserByClerkId(ctx, args.clerkId)
    if (!user) return false
    if (user.stripeCustomerId !== args.customerId)
      await ctx.db.patch('users', user._id, {
        stripeCustomerId: args.customerId,
        updatedAt: Date.now()
      })
    return true
  }
})

/**
 * Stripe -> Murmur. Point a webhook endpoint at https://<deployment>.convex.site/stripe/webhook
 * with checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
 * and invoice.payment_failed, and set STRIPE_WEBHOOK_SECRET on the deployment.
 */
export const stripeWebhook = httpAction(async (ctx, request) => {
  const config = readStripeConfig(process.env)
  if (!config?.webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET (or the Stripe keys) is not set; refusing webhook')
    return new Response('Webhook not configured', { status: 500 })
  }
  const payload = await request.text()
  try {
    await verifyStripeSignature(
      payload,
      request.headers.get('stripe-signature'),
      config.webhookSecret,
      Date.now()
    )
  } catch (err) {
    if (err instanceof StripeSignatureError)
      return new Response(`Invalid webhook: ${err.message}`, { status: 400 })
    throw err
  }
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    return new Response('Invalid webhook: payload is not JSON', { status: 400 })
  }
  const event = parseStripeEvent(body, config.prices)
  switch (event.type) {
    case 'checkout.session.completed': {
      if (event.clerkId && event.customerId)
        await ctx.runMutation(internal.billing.attachCustomer, {
          clerkId: event.clerkId,
          customerId: event.customerId
        })
      // The session only names the subscription; its current state comes from the API, so the
      // plan is right even if customer.subscription.* events arrive later or not at all.
      if (event.subscriptionId) {
        let snapshot: SubscriptionSnapshot | null = null
        try {
          const raw = await stripeRequest<unknown>(
            config.secretKey,
            'GET',
            `/v1/subscriptions/${event.subscriptionId}`
          )
          snapshot = subscriptionSnapshot(raw, config.prices)
        } catch (err) {
          console.error(
            '[billing] could not fetch subscription after checkout',
            err instanceof Error ? err.message : err
          )
          return new Response('Could not fetch subscription', { status: 502 })
        }
        if (snapshot) {
          const outcome = await ctx.runMutation(internal.billing.applySubscription, {
            subscription: {
              ...snapshot,
              clerkId: snapshot.clerkId ?? event.clerkId,
              customerId: snapshot.customerId ?? event.customerId
            },
            eventAt: event.created
          })
          console.log(`[billing] checkout ${event.id} subscription=${snapshot.id} ${outcome}`)
        }
      }
      break
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const outcome = await ctx.runMutation(internal.billing.applySubscription, {
        subscription: event.subscription,
        eventAt: event.created
      })
      console.log(
        `[billing] ${event.type} ${event.id} subscription=${event.subscription.id} status=${event.subscription.status} ${outcome}`
      )
      break
    }
    case 'invoice.payment_failed': {
      const flagged = await ctx.runMutation(internal.billing.markPaymentFailed, {
        customerId: event.customerId,
        subscriptionId: event.subscriptionId,
        failedAt: event.created
      })
      console.log(
        `[billing] payment failed ${event.id} customer=${event.customerId} flagged=${flagged}`
      )
      break
    }
    case 'ignored':
      break
  }
  return new Response(null, { status: 200 })
})
