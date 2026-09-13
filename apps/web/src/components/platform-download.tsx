import { ButtonAnchor } from '@/components/ui/button'
import { formatBytes } from '@/lib/format'
import {
  fallbackDownloadUrl,
  PLATFORM_LABELS,
  type Platform,
  type ReleaseManifest
} from '@/lib/releases'

/**
 * The one button a platform gets: the recommended file with version and size when the release is
 * known, the stable alias otherwise. Shared by the landing page and the download page.
 */
export function PlatformDownloadButton({
  manifest,
  platform,
  size = 'md',
  className
}: {
  manifest: ReleaseManifest | null
  platform: Platform
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const asset = manifest?.platforms[platform].recommended ?? null
  const href = asset?.url ?? fallbackDownloadUrl(platform)
  return (
    <ButtonAnchor href={href} size={size} className={className} rel="noreferrer">
      <span>
        Download for {PLATFORM_LABELS[platform]}
        {manifest && (
          <span className="ml-1.5 font-normal opacity-70 tabular-nums">
            {manifest.tag}
            {asset ? ` · ${formatBytes(asset.size)}` : ''}
          </span>
        )}
      </span>
    </ButtonAnchor>
  )
}
