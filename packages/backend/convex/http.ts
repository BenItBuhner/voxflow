import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { stripeWebhook } from './billing'
import { chatCompletions, format, models, transcriptions } from './gateway'
import { verifyClerkWebhook, WebhookVerificationError } from './lib/clerkWebhook'

const http = httpRouter()

/**
 * Managed inference for signed-in accounts (see gateway.ts). OpenAI-compatible so both apps use
 * the same client code they use for a user's own provider, with the Clerk JWT as the bearer token.
 */
http.route({ path: '/v1/models', method: 'GET', handler: models })
http.route({ path: '/v1/audio/transcriptions', method: 'POST', handler: transcriptions })
http.route({ path: '/v1/chat/completions', method: 'POST', handler: chatCompletions })
/** Murmur-native: the transcript in, the text to insert out (see gateway.ts `format`). */
http.route({ path: '/v1/format', method: 'POST', handler: format })

/** Stripe -> Convex subscription sync (see billing.ts `stripeWebhook` for the events and secret). */
http.route({ path: '/stripe/webhook', method: 'POST', handler: stripeWebhook })

/**
 * Clerk -> Convex user sync. Point a Clerk webhook endpoint at
 * https://<deployment>.convex.site/clerk/webhook subscribed to user.created, user.updated and
 * user.deleted, and set CLERK_WEBHOOK_SIGNING_SECRET in the Convex deployment's environment.
 */
http.route({
  path: '/clerk/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET
    if (!secret) {
      console.error('CLERK_WEBHOOK_SIGNING_SECRET is not set; refusing webhook')
      return new Response('Webhook not configured', { status: 500 })
    }
    const payload = await request.text()
    let event
    try {
      event = verifyClerkWebhook(
        payload,
        {
          id: request.headers.get('svix-id'),
          timestamp: request.headers.get('svix-timestamp'),
          signature: request.headers.get('svix-signature')
        },
        secret
      )
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return new Response(`Invalid webhook: ${err.message}`, { status: 400 })
      }
      throw err
    }

    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await ctx.runMutation(internal.users.upsertFromClerk, {
          clerkId: event.clerkId,
          email: event.email,
          name: event.name,
          imageUrl: event.imageUrl
        })
        break
      case 'user.deleted':
        await ctx.runMutation(internal.users.purgeByClerkId, { clerkId: event.clerkId })
        break
      case 'ignored':
        break
    }
    return new Response(null, { status: 200 })
  })
})

export default http
