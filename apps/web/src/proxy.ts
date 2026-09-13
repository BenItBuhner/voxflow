import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextMiddleware } from 'next/server'

/**
 * Clerk runs only for the account page, so every other route stays a static asset with no
 * function in front of it. Without an instance configured (no keys) the proxy is a pass-through
 * and /account renders its "accounts are not switched on" state instead.
 */
const configured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY
)

const passthrough: NextMiddleware = () => NextResponse.next()

export default configured ? clerkMiddleware() : passthrough

export const config = {
  matcher: ['/account(.*)']
}
