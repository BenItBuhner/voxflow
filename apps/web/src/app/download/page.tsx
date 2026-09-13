import type { Metadata } from 'next'
import { AssetList } from '@/components/download/asset-list'
import { InstallCommands } from '@/components/download/install-commands'
import { PlatformDownloadButton } from '@/components/platform-download'
import { Section } from '@/components/ui/section'
import { formatDate } from '@/lib/format'
import { DOWNLOAD_PLATFORMS, fetchLatestRelease, PLATFORMS } from '@/lib/releases'
import { latestDownloadBase, releasesUrl } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Download',
  description:
    'Download Murmur for Windows, Linux and Android: installers, AppImage, .deb and APK from the latest release, with checksums and one-line installers.'
}

/* Prerendered; the release list refreshes from GitHub every ten minutes (REVALIDATE_SECONDS). */
export const revalidate = 600

const LINK =
  'text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground'

export default async function DownloadPage() {
  const manifest = await fetchLatestRelease()
  return (
    <>
      <Section className="pb-10">
        <div className="max-w-2xl">
          <div className="eyebrow">Download</div>
          <h1 className="serif-display mt-5 text-title text-balance sm:text-display">
            {manifest ? (
              <>
                Murmur <span className="tabular-nums">{manifest.version}</span>
              </>
            ) : (
              'The latest Murmur'
            )}
          </h1>
          <p className="mt-5 text-lead text-muted-foreground">
            {manifest ? (
              <>
                {manifest.publishedAt && <>Released {formatDate(manifest.publishedAt)}. </>}
                Both apps update themselves from here on: you download Murmur by hand once.{' '}
                <a href={manifest.url} className={LINK}>
                  Release notes
                </a>
                {' · '}
                <a href={manifest.releasesUrl} className={LINK}>
                  All releases
                </a>
                {manifest.checksumsUrl && (
                  <>
                    {' · '}
                    <a href={manifest.checksumsUrl} className={LINK}>
                      SHA256SUMS.txt
                    </a>
                  </>
                )}
              </>
            ) : (
              <>
                GitHub could not be reached just now, so versions and sizes are missing. Every link
                below still resolves to the current release.{' '}
                <a href={releasesUrl()} className={LINK}>
                  All releases
                </a>
                {' · '}
                <a href={`${latestDownloadBase()}/SHA256SUMS.txt`} className={LINK}>
                  SHA256SUMS.txt
                </a>
              </>
            )}
          </p>
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          {DOWNLOAD_PLATFORMS.map((platform) => (
            <PlatformDownloadButton
              key={platform}
              manifest={manifest}
              platform={platform}
              size="lg"
            />
          ))}
        </div>
      </Section>

      <Section className="pt-0 sm:pt-0">
        <div className="grid gap-card">
          {PLATFORMS.map((platform) => (
            <AssetList key={platform} manifest={manifest} platform={platform} />
          ))}
          <InstallCommands manifest={manifest} />
        </div>
        <p className="mt-8 max-w-3xl text-note text-muted-foreground">
          Every release ships a SHA256SUMS.txt; the apps verify each update against it before
          installing and refuse to install unattended without one.
          {manifest?.localOnly && (
            <>
              {' '}
              This release is a local-only build: accounts and Murmur’s models are not in it yet, so
              connect a speech model of your own and everything stays on the device.
            </>
          )}
        </p>
      </Section>
    </>
  )
}
