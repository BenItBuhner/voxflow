'use client'

import { useAuth } from '@clerk/nextjs'
import { ConvexReactClient } from 'convex/react'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import { useMemo, type ReactNode } from 'react'

/**
 * Convex needs Clerk's context to fetch the `convex` JWT template, so this sits inside
 * ClerkProvider (see app/account/page.tsx). The client is created once per page load.
 */
export function AccountProviders({
  convexUrl,
  children
}: {
  convexUrl: string
  children: ReactNode
}) {
  const client = useMemo(() => new ConvexReactClient(convexUrl), [convexUrl])
  return (
    <ConvexProviderWithClerk client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  )
}
