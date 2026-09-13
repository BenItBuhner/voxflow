/**
 * The public configuration of the accounts feature. Next inlines NEXT_PUBLIC_* variables into the
 * client bundle only when they are read by their literal names, hence no dynamic lookups here.
 * Everything else on the site works without any of them.
 */
export const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? ''
export const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ?? ''

export type AccountsSetup =
  | { configured: true }
  | {
      configured: false
      missing: Array<'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' | 'NEXT_PUBLIC_CONVEX_URL'>
    }

export function accountsSetup(): AccountsSetup {
  const missing: Array<'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY' | 'NEXT_PUBLIC_CONVEX_URL'> = []
  if (!clerkPublishableKey) missing.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
  if (!convexUrl) missing.push('NEXT_PUBLIC_CONVEX_URL')
  return missing.length ? { configured: false, missing } : { configured: true }
}
