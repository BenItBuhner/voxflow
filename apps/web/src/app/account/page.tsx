import { ClerkProvider } from '@clerk/nextjs'
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AccountView } from '@/components/account/account-view'
import { AccountProviders } from '@/components/account/providers'
import { AccountUnavailable } from '@/components/account/unavailable'
import { Section } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import { accountsSetup, clerkPublishableKey, convexUrl } from '@/lib/env'

export const metadata: Metadata = {
  title: 'Account',
  description:
    'Sign in to Murmur to see your plan, the days left in your trial, your usage against each limit, and to upgrade to Pro or manage billing.',
  robots: { index: false }
}

/*
 * Clerk and Convex load on this page only, so the rest of the site ships no auth code and no
 * third-party requests. The Clerk appearance follows the site's ink and the field radius (md).
 * The view reads ?upgrade= and ?checkout= (the pricing page and Stripe land here), so it sits in
 * a Suspense boundary as Next requires for search parameters on a prerendered page.
 */
export default function AccountPage() {
  const setup = accountsSetup()
  return (
    <Section>
      <div className="max-w-2xl">
        <div className="eyebrow">Account</div>
        <h1 className="serif-display mt-5 text-title text-balance sm:text-display">
          One account, every device.
        </h1>
        <p className="mt-5 text-lead text-muted-foreground">
          Your plan and trial, your usage of Murmur’s models against each limit, billing, your stats
          and the devices that have signed in. Dictionary, snippets and style are edited in the apps
          and kept in step here.
        </p>
      </div>
      <div className="mt-section">
        {setup.configured ? (
          <ClerkProvider
            publishableKey={clerkPublishableKey}
            appearance={{
              variables: {
                colorPrimary: '#2b2926',
                borderRadius: '0.75rem',
                fontFamily: 'var(--font-sans)'
              }
            }}
          >
            <AccountProviders convexUrl={convexUrl}>
              <Suspense fallback={<Surface className="min-h-64 animate-pulse-soft" />}>
                <AccountView />
              </Suspense>
            </AccountProviders>
          </ClerkProvider>
        ) : (
          <AccountUnavailable setup={setup} />
        )}
      </div>
    </Section>
  )
}
