import { NextResponse } from 'next/server'
import { fetchLatestRelease, REVALIDATE_SECONDS } from '@/lib/releases'
import { releasesUrl } from '@/lib/site'

/**
 * GET /api/releases/latest: the current stable release as a JSON manifest (version, per-platform
 * files with sizes, stable aliases, checksums). Prerendered and revalidated every ten minutes, so
 * GitHub's rate limit is never in the request path.
 */
export const revalidate = 600 // REVALIDATE_SECONDS; Next needs the literal here

const CACHE_HEADERS = {
  'cache-control': `public, max-age=300, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=3600`,
  'access-control-allow-origin': '*'
}

export async function GET() {
  const manifest = await fetchLatestRelease()
  if (!manifest) {
    return NextResponse.json(
      {
        error: 'release_unavailable',
        message: 'The latest release could not be read from GitHub right now.',
        releasesUrl: releasesUrl()
      },
      { status: 503, headers: { 'cache-control': 'public, max-age=60', 'retry-after': '60' } }
    )
  }
  return NextResponse.json(manifest, { headers: CACHE_HEADERS })
}
