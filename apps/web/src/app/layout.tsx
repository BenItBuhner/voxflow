import type { Metadata, Viewport } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, siteUrl } from '@/lib/site'
import './globals.css'

/* Instrument Serif is the display face the desktop and Android apps ship; Inter is their body face. */
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap'
})

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: {
    default: `${SITE_NAME}: ${SITE_TAGLINE}`,
    template: `%s · ${SITE_NAME}`
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME}: voice dictation for Windows, Linux and Android`,
    description: SITE_DESCRIPTION
  },
  twitter: { card: 'summary' }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f4f2' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1b1a' }
  ],
  width: 'device-width',
  initialScale: 1
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${instrumentSerif.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
