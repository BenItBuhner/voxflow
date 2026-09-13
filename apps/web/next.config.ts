import type { NextConfig } from 'next'

/**
 * The site is static-first: every page is prerendered and the two release endpoints revalidate on
 * a timer, so it runs the same on Vercel, on `next start` behind any reverse proxy, or in a
 * container. Nothing here depends on the host.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this directory.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
        ]
      }
    ]
  }
}

export default nextConfig
