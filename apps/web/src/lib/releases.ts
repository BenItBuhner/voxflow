import { latestDownloadBase, releasesRepo, releasesUrl } from './site'

/**
 * The download side of the release process. scripts/release.mjs decides which files a release
 * ships and what their stable aliases are; this module knows the same list (the test keeps the two
 * in step), reads the latest release from the GitHub API and turns it into the manifest behind the
 * download page, /api/releases/latest and the /download/<platform> redirects.
 */

export type Platform = 'windows' | 'linux' | 'macos' | 'android'
export type Arch = 'x64' | 'arm64' | 'universal'
export type AssetKind = 'installer' | 'portable' | 'appimage' | 'deb' | 'dmg' | 'zip' | 'apk'

export const PLATFORMS: readonly Platform[] = ['windows', 'linux', 'android', 'macos']
export const PLATFORM_LABELS: Record<Platform, string> = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
  android: 'Android'
}

/** Platforms /download/<platform> answers for; macOS is experimental and only listed on the page. */
export const DOWNLOAD_PLATFORMS = ['windows', 'linux', 'android'] as const
export type DownloadPlatform = (typeof DOWNLOAD_PLATFORMS)[number]

export function isDownloadPlatform(value: string): value is DownloadPlatform {
  return (DOWNLOAD_PLATFORMS as readonly string[]).includes(value)
}

export interface CatalogEntry {
  /** Display group, identical to the `group` in scripts/release.mjs. */
  group: string
  /** Label within the group, identical to release.mjs. */
  label: string
  /** Versioned file name as the release workflow uploads it. */
  file: (version: string) => string
  /** Stable alias uploaded next to it; /releases/latest/download/<alias> follows the latest release. */
  alias: string
  platform: Platform
  arch: Arch
  kind: AssetKind
  /** The file /download/<platform> sends people to. */
  recommended?: boolean
}

export const ASSET_CATALOG: readonly CatalogEntry[] = [
  {
    group: 'Windows',
    label: 'Installer (x64 + arm64)',
    file: (v) => `Murmur-${v}-setup.exe`,
    alias: 'Murmur-setup.exe',
    platform: 'windows',
    arch: 'universal',
    kind: 'installer',
    recommended: true
  },
  {
    group: 'Windows',
    label: 'Portable (x64)',
    file: (v) => `Murmur-${v}-portable.exe`,
    alias: 'Murmur-portable.exe',
    platform: 'windows',
    arch: 'x64',
    kind: 'portable'
  },
  {
    group: 'Windows x64 only',
    label: 'Installer',
    file: (v) => `Murmur-${v}-x64-setup.exe`,
    alias: 'Murmur-x64-setup.exe',
    platform: 'windows',
    arch: 'x64',
    kind: 'installer'
  },
  {
    group: 'Windows arm64 only',
    label: 'Installer',
    file: (v) => `Murmur-${v}-arm64-setup.exe`,
    alias: 'Murmur-arm64-setup.exe',
    platform: 'windows',
    arch: 'arm64',
    kind: 'installer'
  },
  {
    group: 'Linux x64',
    label: 'AppImage',
    file: (v) => `Murmur-${v}-x86_64.AppImage`,
    alias: 'Murmur-x86_64.AppImage',
    platform: 'linux',
    arch: 'x64',
    kind: 'appimage',
    recommended: true
  },
  {
    group: 'Linux x64',
    label: '.deb',
    file: (v) => `murmur_${v}_amd64.deb`,
    alias: 'murmur_amd64.deb',
    platform: 'linux',
    arch: 'x64',
    kind: 'deb'
  },
  {
    group: 'Linux arm64',
    label: 'AppImage',
    file: (v) => `Murmur-${v}-arm64.AppImage`,
    alias: 'Murmur-arm64.AppImage',
    platform: 'linux',
    arch: 'arm64',
    kind: 'appimage'
  },
  {
    group: 'Linux arm64',
    label: '.deb',
    file: (v) => `murmur_${v}_arm64.deb`,
    alias: 'murmur_arm64.deb',
    platform: 'linux',
    arch: 'arm64',
    kind: 'deb'
  },
  {
    group: 'macOS (Apple silicon)',
    label: '.dmg',
    file: (v) => `Murmur-${v}-arm64.dmg`,
    alias: 'Murmur-arm64.dmg',
    platform: 'macos',
    arch: 'arm64',
    kind: 'dmg',
    recommended: true
  },
  {
    group: 'macOS (Apple silicon)',
    label: '.zip',
    file: (v) => `Murmur-${v}-arm64.zip`,
    alias: 'Murmur-arm64.zip',
    platform: 'macos',
    arch: 'arm64',
    kind: 'zip'
  },
  {
    group: 'macOS (Intel)',
    label: '.dmg',
    file: (v) => `Murmur-${v}-x64.dmg`,
    alias: 'Murmur-x64.dmg',
    platform: 'macos',
    arch: 'x64',
    kind: 'dmg'
  },
  {
    group: 'macOS (Intel)',
    label: '.zip',
    file: (v) => `Murmur-${v}-x64.zip`,
    alias: 'Murmur-x64.zip',
    platform: 'macos',
    arch: 'x64',
    kind: 'zip'
  },
  {
    group: 'Android',
    label: 'APK',
    file: (v) => `Murmur-${v}-android.apk`,
    alias: 'Murmur-android.apk',
    platform: 'android',
    arch: 'universal',
    kind: 'apk',
    recommended: true
  }
]

export const CHECKSUMS_FILE = 'SHA256SUMS.txt'
export const INSTALL_HELPERS = { sh: 'install.sh', ps1: 'install.ps1' } as const

/** How long a page or endpoint may serve a manifest before asking GitHub again. */
export const REVALIDATE_SECONDS = 600

// ---- GitHub API -------------------------------------------------------------------------------

export interface GitHubAsset {
  name: string
  size: number
  browser_download_url: string
}

export interface GitHubRelease {
  tag_name: string
  name: string | null
  body?: string | null
  html_url: string
  published_at: string | null
  prerelease: boolean
  draft: boolean
  assets: GitHubAsset[]
}

/** scripts/release.mjs puts this heading in the notes of a build made without a cloud instance. */
const LOCAL_ONLY_HEADING = /^##\s+Local-only build\s*$/m

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGitHubAsset(value: unknown): value is GitHubAsset {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.size === 'number' &&
    typeof value.browser_download_url === 'string'
  )
}

export function isGitHubRelease(value: unknown): value is GitHubRelease {
  return (
    isRecord(value) &&
    typeof value.tag_name === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    (value.body === undefined || typeof value.body === 'string' || value.body === null) &&
    typeof value.html_url === 'string' &&
    (typeof value.published_at === 'string' || value.published_at === null) &&
    typeof value.prerelease === 'boolean' &&
    typeof value.draft === 'boolean' &&
    Array.isArray(value.assets) &&
    value.assets.every(isGitHubAsset)
  )
}

// ---- manifest ---------------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string
  group: string
  label: string
  platform: Platform
  arch: Arch
  kind: AssetKind
  /** Bytes. */
  size: number
  /** The versioned file on this release. */
  url: string
  /** `/releases/latest/download/<alias>`, when the release carries the alias; follows future releases. */
  stableUrl: string | null
  recommended: boolean
}

export interface PlatformDownloads {
  platform: Platform
  label: string
  assets: ReleaseAsset[]
  recommended: ReleaseAsset | null
}

export interface ReleaseManifest {
  repo: string
  version: string
  tag: string
  name: string
  publishedAt: string | null
  prerelease: boolean
  /** Built without a production Murmur instance: no accounts or managed models in these files. */
  localOnly: boolean
  /** The release page. */
  url: string
  releasesUrl: string
  checksumsUrl: string | null
  install: { sh: string | null; ps1: string | null }
  platforms: Record<Platform, PlatformDownloads>
}

export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, '')
}

/** Shape the GitHub release into what the pages and endpoints need; pure, so it is unit tested. */
export function buildManifest(release: GitHubRelease, repo = releasesRepo()): ReleaseManifest {
  const version = versionFromTag(release.tag_name)
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]))
  const latestBase = latestDownloadBase(repo)

  const emptyBucket = (platform: Platform): PlatformDownloads => ({
    platform,
    label: PLATFORM_LABELS[platform],
    assets: [],
    recommended: null
  })
  const platforms: Record<Platform, PlatformDownloads> = {
    windows: emptyBucket('windows'),
    linux: emptyBucket('linux'),
    macos: emptyBucket('macos'),
    android: emptyBucket('android')
  }

  for (const entry of ASSET_CATALOG) {
    const asset = byName.get(entry.file(version))
    if (!asset) continue
    const shaped: ReleaseAsset = {
      name: asset.name,
      group: entry.group,
      label: entry.label,
      platform: entry.platform,
      arch: entry.arch,
      kind: entry.kind,
      size: asset.size,
      url: asset.browser_download_url,
      stableUrl: byName.has(entry.alias) ? `${latestBase}/${entry.alias}` : null,
      recommended: entry.recommended === true
    }
    const bucket = platforms[entry.platform]
    bucket.assets.push(shaped)
    if (shaped.recommended && !bucket.recommended) bucket.recommended = shaped
  }

  const urlOf = (name: string): string | null => byName.get(name)?.browser_download_url ?? null
  return {
    repo,
    version,
    tag: release.tag_name,
    name: release.name?.trim() || release.tag_name,
    publishedAt: release.published_at,
    prerelease: release.prerelease,
    localOnly: LOCAL_ONLY_HEADING.test(release.body ?? ''),
    url: release.html_url,
    releasesUrl: releasesUrl(repo),
    checksumsUrl: urlOf(CHECKSUMS_FILE),
    install: { sh: urlOf(INSTALL_HELPERS.sh), ps1: urlOf(INSTALL_HELPERS.ps1) },
    platforms
  }
}

/** The file a platform's download button points at, or null when the release has none for it. */
export function recommendedAsset(
  manifest: ReleaseManifest,
  platform: Platform
): ReleaseAsset | null {
  return manifest.platforms[platform].recommended
}

/**
 * Where /download/<platform> goes when GitHub cannot be reached: the stable alias, which GitHub
 * itself resolves to the latest release.
 */
export function fallbackDownloadUrl(platform: Platform, repo = releasesRepo()): string {
  const entry = ASSET_CATALOG.find((e) => e.platform === platform && e.recommended)
  if (!entry) throw new Error(`No recommended asset for ${platform}`)
  return `${latestDownloadBase(repo)}/${entry.alias}`
}

// ---- fetching ---------------------------------------------------------------------------------

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'murmur-web'
  }
  const token = process.env.GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * The latest stable release as a manifest, or null when GitHub is unreachable, rate-limited or the
 * repository has no release yet. Cached by Next's data cache for REVALIDATE_SECONDS, so a page and
 * both endpoints together ask GitHub about six times an hour.
 */
export async function fetchLatestRelease(repo = releasesRepo()): Promise<ReleaseManifest | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
      next: { revalidate: REVALIDATE_SECONDS }
    })
    if (!response.ok) return null
    const json: unknown = await response.json()
    if (!isGitHubRelease(json) || json.draft) return null
    return buildManifest(json, repo)
  } catch {
    return null
  }
}
