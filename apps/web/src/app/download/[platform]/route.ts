import { NextResponse } from 'next/server'
import {
  DOWNLOAD_PLATFORMS,
  fallbackDownloadUrl,
  fetchLatestRelease,
  isDownloadPlatform,
  recommendedAsset,
  REVALIDATE_SECONDS
} from '@/lib/releases'

/**
 * GET /download/{windows|linux|android}: redirect to the file most people want on that platform
 * from the latest release (the combined Windows installer, the x64 AppImage, the APK). When
 * GitHub cannot be read the redirect goes to the stable alias instead, which GitHub resolves to
 * the latest release itself, so the link never dead-ends.
 */
export const revalidate = 600 // REVALIDATE_SECONDS; Next needs the literal here
export const dynamicParams = false

export function generateStaticParams(): Array<{ platform: string }> {
  return DOWNLOAD_PLATFORMS.map((platform) => ({ platform }))
}

export async function GET(_request: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params
  if (!isDownloadPlatform(platform)) return new Response(null, { status: 404 })
  const manifest = await fetchLatestRelease()
  const asset = manifest ? recommendedAsset(manifest, platform) : null
  const target = asset?.url ?? fallbackDownloadUrl(platform)
  return NextResponse.redirect(target, {
    status: 302,
    headers: {
      'cache-control': `public, max-age=300, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=3600`
    }
  })
}
