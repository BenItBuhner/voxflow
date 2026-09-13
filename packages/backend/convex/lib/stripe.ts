import type { BillingInterval } from './plans'
import type { Env } from './inference'
import type { SubscriptionStatus } from './validators'

/**
 * The slice of Stripe Murmur uses, over plain `fetch`: Checkout Sessions, the Customer Portal and
 * webhook verification. The Convex runtime has Web Crypto and fetch, so the SDK (and a Node
 * action) are not needed. Nothing here touches the database; convex/billing.ts does.
 *
 * Deployment variables:
 *
 *   STRIPE_SECRET_KEY        sk_test_… / sk_live_…
 *   STRIPE_WEBHOOK_SECRET    whsec_… of the endpoint pointed at /stripe/webhook
 *   STRIPE_PRICE_MONTHLY     price_… for $7.50 a month
 *   STRIPE_PRICE_YEARLY      price_… for $72 a year
 *   MURMUR_SITE_URL          https://… where Checkout and the Portal return to (/account)
 */

const STRIPE_API = 'https://api.stripe.com'
const SIGNATURE_TOLERANCE_SEC = 300

export interface StripeConfig {
  secretKey: string
  webhookSecret: string | null
  prices: Record<BillingInterval, string>
  siteUrl: string | null
}

const trimmed = (value: string | undefined): string => (value ?? '').trim()

/** Null unless the secret key and both prices are set; the webhook secret and site URL are checked where used. */
export function readStripeConfig(env: Env): StripeConfig | null {
  const secretKey = trimmed(env.STRIPE_SECRET_KEY)
  const month = trimmed(env.STRIPE_PRICE_MONTHLY)
  const year = trimmed(env.STRIPE_PRICE_YEARLY)
  if (!secretKey || !month || !year) return null
  const site = trimmed(env.MURMUR_SITE_URL).replace(/\/+$/, '')
  return {
    secretKey,
    webhookSecret: trimmed(env.STRIPE_WEBHOOK_SECRET) || null,
    prices: { month, year },
    siteUrl: /^https?:\/\//i.test(site) ? site : null
  }
}

/** Checkout and the Portal need a place to come back to as well as keys. */
export function billingConfigured(env: Env): boolean {
  const config = readStripeConfig(env)
  return config !== null && config.siteUrl !== null
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'StripeApiError'
  }
}

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeSignatureError'
  }
}

type FormValue = string | number | boolean | undefined
type FormParams = { [key: string]: FormValue | FormParams }

/** Stripe's nested form encoding: `{ line_items: [{ price }] }` becomes `line_items[0][price]=…`. */
export function formEncode(params: FormParams, prefix = ''): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (value !== null && typeof value === 'object') {
      const nested = formEncode(value as FormParams, name)
      if (nested) parts.push(nested)
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.join('&')
}

/** One call to Stripe's REST API; errors carry Stripe's own message. */
export async function stripeRequest<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  params?: FormParams
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` }
  let url = `${STRIPE_API}${path}`
  let body: string | undefined
  if (params && method === 'GET') url += `?${formEncode(params)}`
  else if (params) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = formEncode(params)
  }
  const res = await fetch(url, { method, headers, body })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new StripeApiError(`Stripe returned a malformed answer (HTTP ${res.status})`, res.status)
  }
  if (!res.ok) {
    const error = (json as { error?: { message?: string } }).error
    throw new StripeApiError(
      error?.message ?? `Stripe request failed (HTTP ${res.status})`,
      res.status
    )
  }
  return json as T
}

// ---- webhook signatures ------------------------------------------------------------------------

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify the `Stripe-Signature` header (`t=…,v1=…`): HMAC-SHA256 over `${t}.${payload}` with the
 * endpoint secret, within the replay tolerance. Throws `StripeSignatureError` otherwise.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC
): Promise<void> {
  if (!header) throw new StripeSignatureError('Missing Stripe-Signature header')
  let timestamp = ''
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't') timestamp = value ?? ''
    else if (key === 'v1' && value) signatures.push(value)
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0)
    throw new StripeSignatureError('Malformed Stripe-Signature header')
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > toleranceSec)
    throw new StripeSignatureError('Signature timestamp outside the tolerance window')
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const expected = hex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`))
  )
  if (!signatures.some((sig) => timingSafeEqual(sig, expected)))
    throw new StripeSignatureError('Signature does not match')
}

// ---- events -----------------------------------------------------------------------------------

const STATUSES: ReadonlySet<string> = new Set<SubscriptionStatus>([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused'
])

/** Statuses that keep Pro switched on; `past_due` rides Stripe's retry window with a flag. */
export function entitlesPro(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due'
}

/** What Murmur keeps of a Stripe subscription object. */
export interface SubscriptionSnapshot {
  id: string
  status: SubscriptionStatus
  priceId: string
  interval: BillingInterval
  currentPeriodEnd: number
  cancelAtPeriodEnd: boolean
  customerId: string | null
  clerkId: string | null
}

interface StripeSubscriptionObject {
  id?: string
  object?: string
  status?: string
  customer?: string | { id?: string }
  cancel_at_period_end?: boolean
  /** Subscription-level in API versions before 2025-03-31; on the items afterwards. */
  current_period_end?: number
  metadata?: Record<string, string>
  items?: {
    data?: Array<{
      current_period_end?: number
      price?: { id?: string; recurring?: { interval?: string } }
    }>
  }
}

const idOf = (value: string | { id?: string } | undefined | null): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null)

/** Read a subscription object from either side of Stripe's 2025 period-end move; null when unusable. */
export function subscriptionSnapshot(
  raw: unknown,
  prices?: Record<BillingInterval, string>
): SubscriptionSnapshot | null {
  const sub = (raw ?? {}) as StripeSubscriptionObject
  if (!sub.id || !sub.status || !STATUSES.has(sub.status)) return null
  const item = sub.items?.data?.[0]
  const priceId = item?.price?.id ?? ''
  const periodEnd = sub.current_period_end ?? item?.current_period_end
  if (typeof periodEnd !== 'number') return null
  let interval: BillingInterval | null = null
  if (prices && priceId === prices.year) interval = 'year'
  else if (prices && priceId === prices.month) interval = 'month'
  else if (item?.price?.recurring?.interval === 'year') interval = 'year'
  else if (item?.price?.recurring?.interval === 'month') interval = 'month'
  if (!interval) return null
  return {
    id: sub.id,
    status: sub.status as SubscriptionStatus,
    priceId,
    interval,
    currentPeriodEnd: periodEnd * 1000,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    customerId: idOf(sub.customer),
    clerkId: sub.metadata?.clerkId || null
  }
}

export type StripeEvent =
  | {
      type: 'checkout.session.completed'
      id: string
      created: number
      clerkId: string | null
      customerId: string | null
      subscriptionId: string | null
    }
  | {
      type: 'customer.subscription.updated' | 'customer.subscription.deleted'
      id: string
      created: number
      subscription: SubscriptionSnapshot
    }
  | {
      type: 'invoice.payment_failed'
      id: string
      created: number
      customerId: string | null
      subscriptionId: string | null
    }
  | { type: 'ignored'; eventType: string; reason?: string }

interface StripeEventPayload {
  id?: string
  type?: string
  created?: number
  data?: { object?: Record<string, unknown> }
}

/** The events Murmur acts on, reduced to what the mutations need. `created` is in ms. */
export function parseStripeEvent(
  body: unknown,
  prices?: Record<BillingInterval, string>
): StripeEvent {
  const event = (body ?? {}) as StripeEventPayload
  const type = event.type ?? ''
  const id = event.id ?? ''
  const created = typeof event.created === 'number' ? event.created * 1000 : 0
  const object = event.data?.object ?? {}
  if (!id) return { type: 'ignored', eventType: type, reason: 'no event id' }
  switch (type) {
    case 'checkout.session.completed': {
      const session = object as {
        mode?: string
        customer?: string | { id?: string }
        subscription?: string | { id?: string }
        client_reference_id?: string | null
        metadata?: Record<string, string>
      }
      if (session.mode !== 'subscription')
        return { type: 'ignored', eventType: type, reason: 'not a subscription' }
      return {
        type,
        id,
        created,
        clerkId: session.metadata?.clerkId || session.client_reference_id || null,
        customerId: idOf(session.customer),
        subscriptionId: idOf(session.subscription)
      }
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = subscriptionSnapshot(object, prices)
      if (!subscription)
        return { type: 'ignored', eventType: type, reason: 'unreadable subscription' }
      return { type, id, created, subscription }
    }
    case 'invoice.payment_failed': {
      const invoice = object as {
        customer?: string | { id?: string }
        subscription?: string | { id?: string } | null
        parent?: { subscription_details?: { subscription?: string | { id?: string } } }
      }
      return {
        type,
        id,
        created,
        customerId: idOf(invoice.customer),
        subscriptionId:
          idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription)
      }
    }
    default:
      return { type: 'ignored', eventType: type }
  }
}

// ---- sessions ---------------------------------------------------------------------------------

export interface CheckoutInput {
  clerkId: string
  email: string | undefined
  customerId: string | undefined
  interval: BillingInterval
}

/** Parameters of a subscription Checkout Session; no Stripe trial, the trial happened in-product. */
export function checkoutSessionParams(config: StripeConfig, input: CheckoutInput): FormParams {
  const site = config.siteUrl ?? ''
  return {
    mode: 'subscription',
    line_items: { 0: { price: config.prices[input.interval], quantity: 1 } },
    client_reference_id: input.clerkId,
    customer: input.customerId,
    customer_email: input.customerId ? undefined : input.email,
    success_url: `${site}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/account?checkout=cancelled`,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    metadata: { clerkId: input.clerkId },
    subscription_data: { metadata: { clerkId: input.clerkId } }
  }
}

export function portalSessionParams(config: StripeConfig, customerId: string): FormParams {
  return { customer: customerId, return_url: `${config.siteUrl ?? ''}/account` }
}
