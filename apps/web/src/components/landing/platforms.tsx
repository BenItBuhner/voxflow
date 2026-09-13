import Link from 'next/link'
import { PlatformDownloadButton } from '@/components/platform-download'
import { Section, SectionHeading } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import type { Platform, ReleaseManifest } from '@/lib/releases'

const CARDS: Array<{ platform: Platform; title: string; body: string; formats: string }> = [
  {
    platform: 'windows',
    title: 'Windows',
    body: 'Windows 10 and 11, x64 and arm64. Hold the shortcut in any app; the tray shows what Murmur is doing.',
    formats: 'Installer for both architectures, per-arch installers, a portable .exe'
  },
  {
    platform: 'linux',
    title: 'Linux',
    body: 'GNOME, KDE and friends on X11 or Wayland, x64 and arm64. Follows your desktop’s accent colour.',
    formats: 'AppImage and .deb, both architectures'
  },
  {
    platform: 'android',
    title: 'Android',
    body: 'Android 8.0 and up. A floating pill above the keyboard dictates into any app, Material You throughout.',
    formats: 'APK, installs its own updates'
  }
]

export function Platforms({ manifest }: { manifest: ReleaseManifest | null }) {
  return (
    <Section id="platforms">
      <SectionHeading
        eyebrow="Platforms"
        title="A desktop app for Windows and Linux. A native app for Android."
        lede="Both check GitHub Releases for updates, verify every download against the release’s checksums and install it when you are not dictating. You download Murmur by hand exactly once."
      />
      <div className="mt-section grid gap-card md:grid-cols-3">
        {CARDS.map((card) => (
          <Surface key={card.platform} className="flex flex-col">
            <h3 className="serif-display text-heading">{card.title}</h3>
            <p className="mt-3 flex-1 text-body text-muted-foreground">{card.body}</p>
            <p className="mt-4 text-note text-muted-foreground/90">{card.formats}</p>
            <PlatformDownloadButton
              manifest={manifest}
              platform={card.platform}
              className="mt-card w-full"
            />
          </Surface>
        ))}
      </div>
      <p className="mt-6 text-note text-muted-foreground">
        macOS builds (Apple silicon and Intel) ship with every release as well, marked experimental.{' '}
        <Link
          href="/download"
          className="text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
        >
          Every file, with checksums
        </Link>
        .
      </p>
    </Section>
  )
}
