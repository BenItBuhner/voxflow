import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { TRIAL_MS } from '../convex/lib/plans'
import {
  StripeSignatureError,
  billingConfigured,
  checkoutSessionParams,
  entitlesPro,
  formEncode,
  parseStripeEvent,
  portalSessionParams,
  readStripeConfig,
  subscriptionSnapshot,
  verifyStripeSignature
} from '../convex/lib/stripe'
import { ada, jsonResponse, setup, stubEnv, stubFetch } from './helpers'

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0)
const SITE = 'https://murmur.test'
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
  STRIPE_PRICE_MONTHLY: 'price_month',
  STRIPE_PRICE_YEARLY: 'price_year',
  MURMUR_SITE_URL: SITE
}
const PRICES = { month: 'price_month', year: 'price_year' }
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 13) / 1000)

/** A subscription object in Stripe's current shape (period end on the item). */
function stripeSubscription(overrides: Record<string, unknown> = {}, price = 'price_year'): Record<string, unknown> {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    customer: 'cus_ada',
    cancel_at_period_end: false,
    metadata: { clerkId: 'user_ada' },
    items: {
      data: [{ current_period_end: PERIOD_END, price: { id: price, recurring: { interval: price === 'price_year' ? 'year' : 'month' } } }]
    },
    ...overrides
  }
}

function stripeEvent(type: string, object: Record<string, unknown>, created = NOW / 1000, id = `evt_${Math.random().toString(36).slice(2)}`): string {
  return JSON.stringify({ id, type, created, data: { object } })
}

async function sign(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`))
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${hex}`
}

async function deliver(t: ReturnType<typeof setup>, payload: string, header?: string): Promise<Response> {
  return await t.fetch('/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header ?? (await sign(payload, STRIPE_ENV.STRIPE_WEBHOOK_SECRET)) },
    body: payload
  })
}

const decode = (body: BodyInit | null | undefined): URLSearchParams => new URLSearchParams(String(body))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('stripe helpers', () => {
  it('reads the configuration and knows when billing can run', () => {
    expect(readStripeConfig({})).toBeNull()
    expect(readStripeConfig({ STRIPE_SECRET_KEY: 'sk', STRIPE_PRICE_MONTHLY: 'a' })).toBeNull()
    expect(readStripeConfig(STRIPE_ENV)).toEqual({
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_test_secret',
      prices: PRICES,
      siteUrl: SITE
    })
    expect(readStripeConfig({ ...STRIPE_ENV, MURMUR_SITE_URL: '', STRIPE_WEBHOOK_SECRET: '' })).toMatchObject({ webhookSecret: null, siteUrl: null })
    expect(billingConfigured(STRIPE_ENV)).toBe(true)
    expect(billingConfigured({ ...STRIPE_ENV, MURMUR_SITE_URL: '' })).toBe(false)
  })

  it('encodes nested form parameters the way Stripe expects', () => {
    expect(formEncode({ mode: 'subscription', line_items: { 0: { price: 'price_x', quantity: 1 } }, skip: undefined, metadata: { clerkId: 'u 1' } })).toBe(
      'mode=subscription&line_items%5B0%5D%5Bprice%5D=price_x&line_items%5B0%5D%5Bquantity%5D=1&metadata%5BclerkId%5D=u%201'
    )
    const checkout = checkoutSessionParams(readStripeConfig(STRIPE_ENV)!, { clerkId: 'user_ada', email: 'ada@example.com', customerId: undefined, interval: 'year' })
    const params = decode(formEncode(checkout))
    expect(params.get('mode')).toBe('subscription')
    expect(params.get('line_items[0][price]')).toBe('price_year')
    expect(params.get('customer_email')).toBe('ada@example.com')
    expect(params.get('customer')).toBeNull()
    expect(params.get('client_reference_id')).toBe('user_ada')
    expect(params.get('subscription_data[metadata][clerkId]')).toBe('user_ada')
    expect(params.get('success_url')).toBe(`${SITE}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`)
    expect(params.get('cancel_url')).toBe(`${SITE}/account?checkout=cancelled`)
    expect(params.has('subscription_data[trial_period_days]')).toBe(false)
    const returning = decode(formEncode(checkoutSessionParams(readStripeConfig(STRIPE_ENV)!, { clerkId: 'user_ada', email: 'ada@example.com', customerId: 'cus_ada', interval: 'month' })))
    expect(returning.get('customer')).toBe('cus_ada')
    expect(returning.get('customer_email')).toBeNull()
    expect(returning.get('line_items[0][price]')).toBe('price_month')
    expect(decode(formEncode(portalSessionParams(readStripeConfig(STRIPE_ENV)!, 'cus_ada'))).get('return_url')).toBe(`${SITE}/account`)
  })

  it('verifies webhook signatures within the tolerance window', async () => {
    const payload = '{"id":"evt_1"}'
    const header = await sign(payload, 'whsec_a')
    await expect(verifyStripeSignature(payload, header, 'whsec_a', NOW)).resolves.toBeUndefined()
    await expect(verifyStripeSignature(payload, header, 'whsec_b', NOW)).rejects.toThrow(StripeSignatureError)
    await expect(verifyStripeSignature(payload + ' ', header, 'whsec_a', NOW)).rejects.toThrow(/does not match/)
    await expect(verifyStripeSignature(payload, header, 'whsec_a', NOW + 301_000)).rejects.toThrow(/tolerance/)
    await expect(verifyStripeSignature(payload, null, 'whsec_a', NOW)).rejects.toThrow(/Missing/)
    await expect(verifyStripeSignature(payload, 't=abc,v1=00', 'whsec_a', NOW)).rejects.toThrow(/Malformed/)
    // Stripe may send several v1 signatures during a secret rotation; one match is enough.
    await expect(verifyStripeSignature(payload, `${header},v1=deadbeef`, 'whsec_a', NOW)).resolves.toBeUndefined()
  })

  it('reads subscriptions in both API shapes and maps statuses to entitlement', () => {
    expect(subscriptionSnapshot(stripeSubscription(), PRICES)).toEqual({
      id: 'sub_1',
      status: 'active',
      priceId: 'price_year',
      interval: 'year',
      currentPeriodEnd: PERIOD_END * 1000,
      cancelAtPeriodEnd: false,
      customerId: 'cus_ada',
      clerkId: 'user_ada'
    })
    // Pre-2025 API versions: the period end sits on the subscription, the customer may be expanded.
    const legacy = subscriptionSnapshot(
      { id: 'sub_2', status: 'past_due', customer: { id: 'cus_x' }, current_period_end: PERIOD_END, cancel_at_period_end: true, items: { data: [{ price: { id: 'price_other', recurring: { interval: 'month' } } }] } },
      PRICES
    )
    expect(legacy).toMatchObject({ id: 'sub_2', status: 'past_due', interval: 'month', customerId: 'cus_x', clerkId: null, cancelAtPeriodEnd: true })
    expect(subscriptionSnapshot(stripeSubscription({ status: 'weird' }), PRICES)).toBeNull()
    expect(subscriptionSnapshot({ id: 'sub_3', status: 'active', items: { data: [{ price: { id: 'p', recurring: { interval: 'week' } } }] } })).toBeNull()
    expect(entitlesPro('active')).toBe(true)
    expect(entitlesPro('trialing')).toBe(true)
    expect(entitlesPro('past_due')).toBe(true)
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'] as const) expect(entitlesPro(status)).toBe(false)
  })

  it('reduces the webhook events Murmur acts on', () => {
    const checkout = parseStripeEvent(JSON.parse(stripeEvent('checkout.session.completed', { mode: 'subscription', customer: 'cus_ada', subscription: 'sub_1', client_reference_id: 'user_ada', metadata: {} }, 1_700_000_000, 'evt_c')))
    expect(checkout).toEqual({ type: 'checkout.session.completed', id: 'evt_c', created: 1_700_000_000_000, clerkId: 'user_ada', customerId: 'cus_ada', subscriptionId: 'sub_1' })
    expect(parseStripeEvent(JSON.parse(stripeEvent('checkout.session.completed', { mode: 'payment' })))).toMatchObject({ type: 'ignored', reason: 'not a subscription' })
    expect(parseStripeEvent(JSON.parse(stripeEvent('customer.subscription.updated', stripeSubscription())), PRICES)).toMatchObject({ type: 'customer.subscription.updated', subscription: { id: 'sub_1', interval: 'year' } })
    expect(parseStripeEvent(JSON.parse(stripeEvent('customer.subscription.deleted', { id: 'sub_1' })), PRICES)).toMatchObject({ type: 'ignored', reason: 'unreadable subscription' })
    expect(parseStripeEvent(JSON.parse(stripeEvent('invoice.payment_failed', { customer: 'cus_ada', subscription: 'sub_1' })))).toMatchObject({ type: 'invoice.payment_failed', customerId: 'cus_ada', subscriptionId: 'sub_1' })
    expect(parseStripeEvent(JSON.parse(stripeEvent('invoice.payment_failed', { customer: 'cus_ada', parent: { subscription_details: { subscription: 'sub_9' } } })))).toMatchObject({ subscriptionId: 'sub_9' })
    expect(parseStripeEvent(JSON.parse(stripeEvent('customer.created', {})))).toEqual({ type: 'ignored', eventType: 'customer.created' })
    expect(parseStripeEvent({})).toMatchObject({ type: 'ignored', reason: 'no event id' })
  })
})

describe('billing without Stripe configured', () => {
  it('degrades: status says so, the actions refuse readably, the webhook is off', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    expect(await asAda.query(api.billing.status, {})).toEqual({ configured: false, portalAvailable: false, upgradeUrl: null, subscription: null })
    await expect(asAda.action(api.billing.createCheckoutSession, { interval: 'year' })).rejects.toThrow(/not switched on/)
    await expect(asAda.action(api.billing.createPortalSession, {})).rejects.toThrow(/not switched on/)
    await expect(t.action(api.billing.createCheckoutSession, { interval: 'year' })).rejects.toThrow(/Not authenticated/)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription()))).status).toBe(500)
    error.mockRestore()
  })
})

describe('billing with Stripe configured', () => {
  beforeEach(() => stubEnv(STRIPE_ENV))

  it('starts Checkout for the chosen interval and refuses for paying accounts', async () => {
    const calls = stubFetch(() => jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }))
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    expect(await asAda.query(api.billing.status, {})).toEqual({ configured: true, portalAvailable: false, upgradeUrl: `${SITE}/account?upgrade=yearly`, subscription: null })

    const { url } = await asAda.action(api.billing.createCheckoutSession, { interval: 'year' })
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_123')
    const sent = decode(calls[0].init.body)
    expect(sent.get('line_items[0][price]')).toBe('price_year')
    expect(sent.get('customer_email')).toBe('ada@example.com')
    expect(sent.get('client_reference_id')).toBe('user_ada')

    await asAda.action(api.billing.createCheckoutSession, { interval: 'month' })
    expect(decode(calls[1].init.body).get('line_items[0][price]')).toBe('price_month')

    stubFetch(() => jsonResponse({ error: { message: 'No such price: price_year' } }, 400))
    await expect(asAda.action(api.billing.createCheckoutSession, { interval: 'year' })).rejects.toThrow(/No such price/)

    await t.mutation(internal.users.setPlan, { clerkId: 'user_ada', plan: 'pro' })
    await expect(asAda.action(api.billing.createCheckoutSession, { interval: 'year' })).rejects.toThrow(/already on Pro/)
  })

  it('turns a completed Checkout into Pro by reading the subscription back from Stripe', async () => {
    const calls = stubFetch((url) => (url.endsWith('/v1/subscriptions/sub_1') ? jsonResponse(stripeSubscription()) : jsonResponse({}, 404)))
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    const res = await deliver(t, stripeEvent('checkout.session.completed', { mode: 'subscription', customer: 'cus_ada', subscription: 'sub_1', client_reference_id: 'user_ada' }))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1')
    expect(await asAda.query(api.users.me, {})).toMatchObject({ plan: 'pro', planState: 'pro' })
    expect(await asAda.query(api.billing.status, {})).toEqual({
      configured: true,
      portalAvailable: true,
      upgradeUrl: null,
      subscription: { status: 'active', interval: 'year', currentPeriodEnd: PERIOD_END * 1000, cancelAtPeriodEnd: false, paymentFailedAt: null }
    })
    expect((await asAda.query(api.inference.status, {})).planState).toBe('pro')

    // The Portal now opens for this customer.
    stubFetch(() => jsonResponse({ url: 'https://billing.stripe.com/p/session/1' }))
    const portal = await asAda.action(api.billing.createPortalSession, {})
    expect(portal.url).toBe('https://billing.stripe.com/p/session/1')

    // Stripe unreachable when reading the subscription: ask for a retry instead of dropping the event.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    expect((await deliver(t, stripeEvent('checkout.session.completed', { mode: 'subscription', customer: 'cus_ada', subscription: 'sub_1', client_reference_id: 'user_ada' }))).status).toBe(502)
    error.mockRestore()
  })

  it('follows the subscription through payment failure, recovery, cancellation and deletion', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    const created = NOW / 1000

    expect((await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription(), created))).status).toBe(200)
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })

    // A failed invoice keeps Pro and flags the account.
    expect((await deliver(t, stripeEvent('invoice.payment_failed', { customer: 'cus_ada', subscription: 'sub_1' }, created + 10))).status).toBe(200)
    let billing = await asAda.query(api.billing.status, {})
    expect(billing.subscription).toMatchObject({ status: 'active', paymentFailedAt: (created + 10) * 1000 })
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })
    // past_due from Stripe keeps the flag and the access.
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ status: 'past_due' }), created + 20))
    billing = await asAda.query(api.billing.status, {})
    expect(billing.subscription).toMatchObject({ status: 'past_due', paymentFailedAt: (created + 10) * 1000 })
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })
    // Payment recovered: the flag clears.
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription(), created + 30))
    expect((await asAda.query(api.billing.status, {})).subscription).toMatchObject({ status: 'active', paymentFailedAt: null })

    // An older event arriving late changes nothing.
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ status: 'past_due' }), created + 25))
    expect((await asAda.query(api.billing.status, {})).subscription?.status).toBe('active')

    // Cancel at period end: still Pro until then, and the page can say so.
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ cancel_at_period_end: true }), created + 40))
    expect((await asAda.query(api.billing.status, {})).subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true })
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })

    // Deleted during the trial window: back to the trial; after it: free.
    await deliver(t, stripeEvent('customer.subscription.deleted', stripeSubscription({ status: 'canceled' }), created + 50))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'trial', plan: 'pro' })
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_2' }), created + 60))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })
    vi.setSystemTime(NOW + TRIAL_MS + 1000)
    await deliver(t, stripeEvent('customer.subscription.deleted', stripeSubscription({ id: 'sub_2', status: 'canceled' }), created + 70))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'free', plan: 'free' })
    expect((await asAda.query(api.billing.status, {})).subscription?.status).toBe('canceled')
    // The customer is remembered, so the Portal still opens for invoices.
    expect((await asAda.query(api.billing.status, {})).portalAvailable).toBe(true)
    // Unpaid ends Pro too.
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_3' }), created + 80))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_3', status: 'unpaid' }), created + 90))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'free' })
  })

  it('ignores events for a replaced subscription and finds accounts by customer', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.users.ensure, {})
    const created = NOW / 1000
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_old' }), created))
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_new' }), created + 1))
    // The old subscription is deleted after the new one took over: no downgrade.
    await deliver(t, stripeEvent('customer.subscription.deleted', stripeSubscription({ id: 'sub_old', status: 'canceled' }), created + 2))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'pro' })
    expect((await asAda.query(api.billing.status, {})).subscription).toMatchObject({ status: 'active' })
    // Without metadata (a subscription made in the Stripe dashboard) the customer id finds the account.
    await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_new', status: 'canceled', metadata: {} }), created + 3))
    expect(await asAda.query(api.users.me, {})).toMatchObject({ planState: 'trial' })
    // Nobody we know: acknowledged, not applied.
    expect((await deliver(t, stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_x', customer: 'cus_nobody', metadata: {} }), created + 4))).status).toBe(200)
  })

  it('rejects unsigned, mis-signed and malformed deliveries', async () => {
    const t = setup()
    const payload = stripeEvent('customer.subscription.updated', stripeSubscription())
    expect((await deliver(t, payload, 't=1,v1=bad')).status).toBe(400)
    expect((await deliver(t, payload, await sign(payload, 'whsec_other'))).status).toBe(400)
    expect((await t.fetch('/stripe/webhook', { method: 'POST', body: payload })).status).toBe(400)
    expect((await deliver(t, 'not json')).status).toBe(400)
    // Unknown event types are acknowledged so Stripe stops retrying them.
    expect((await deliver(t, stripeEvent('customer.created', { id: 'cus_1' }))).status).toBe(200)
  })
})
