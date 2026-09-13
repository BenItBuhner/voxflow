import { describe, expect, it } from 'vitest'
import {
  ASSETS as SCRIPT_ASSETS,
  CHECKSUMS_FILE as SCRIPT_CHECKSUMS_FILE,
  INSTALL_HELPERS as SCRIPT_INSTALL_HELPERS
} from '../../../../scripts/release.mjs'
import {
  ASSET_CATALOG,
  buildManifest,
  CHECKSUMS_FILE,
  DOWNLOAD_PLATFORMS,
  fallbackDownloadUrl,
  INSTALL_HELPERS,
  isGitHubRelease,
  PLATFORMS,
  recommendedAsset,
  type GitHubRelease
} from './releases'

const REPO = 'BenItBuhner/Murmur'
const VERSION = '0.4.0'

/** A release shaped like the one the workflow publishes: every versioned file, its alias, and the extras. */
function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  const base = `https://github.com/${REPO}/releases/download/v${VERSION}`
  const assets = ASSET_CATALOG.flatMap((entry, i) => [
    {
      name: entry.file(VERSION),
      size: 1_000_000 * (i + 1),
      browser_download_url: `${base}/${entry.file(VERSION)}`
    },
    { name: entry.alias, size: 1_000_000 * (i + 1), browser_download_url: `${base}/${entry.alias}` }
  ])
  assets.push(
    { name: CHECKSUMS_FILE, size: 2435, browser_download_url: `${base}/${CHECKSUMS_FILE}` },
    { name: INSTALL_HELPERS.sh, size: 6101, browser_download_url: `${base}/${INSTALL_HELPERS.sh}` },
    {
      name: INSTALL_HELPERS.ps1,
      size: 3638,
      browser_download_url: `${base}/${INSTALL_HELPERS.ps1}`
    }
  )
  return {
    tag_name: `v${VERSION}`,
    name: `Murmur v${VERSION}`,
    html_url: `https://github.com/${REPO}/releases/tag/v${VERSION}`,
    published_at: '2026-09-06T20:16:15Z',
    prerelease: false,
    draft: false,
    assets,
    ...overrides
  }
}

describe('asset catalog', () => {
  it('lists exactly the files scripts/release.mjs ships, with the same aliases, groups and labels', () => {
    const script = SCRIPT_ASSETS.map((a) => ({
      group: a.group,
      label: a.label,
      file: a.file(VERSION),
      alias: a.alias
    }))
    const web = ASSET_CATALOG.map((a) => ({
      group: a.group,
      label: a.label,
      file: a.file(VERSION),
      alias: a.alias
    }))
    expect(web).toEqual(script)
    expect(CHECKSUMS_FILE).toBe(SCRIPT_CHECKSUMS_FILE)
    expect(SCRIPT_INSTALL_HELPERS.map((h) => h.file).sort()).toEqual(
      Object.values(INSTALL_HELPERS).sort()
    )
  })

  it('recommends exactly one file per platform', () => {
    for (const platform of PLATFORMS) {
      const recommended = ASSET_CATALOG.filter((a) => a.platform === platform && a.recommended)
      expect(recommended, platform).toHaveLength(1)
    }
  })
})

describe('buildManifest', () => {
  it('groups the release files by platform with sizes, versioned and stable URLs', () => {
    const manifest = buildManifest(release(), REPO)
    expect(manifest.version).toBe(VERSION)
    expect(manifest.tag).toBe(`v${VERSION}`)
    expect(manifest.name).toBe(`Murmur v${VERSION}`)
    expect(manifest.prerelease).toBe(false)
    expect(manifest.checksumsUrl).toMatch(/SHA256SUMS\.txt$/)
    expect(manifest.install.sh).toMatch(/install\.sh$/)
    expect(manifest.install.ps1).toMatch(/install\.ps1$/)

    const windows = manifest.platforms.windows
    expect(windows.assets.map((a) => a.name)).toEqual([
      'Murmur-0.4.0-setup.exe',
      'Murmur-0.4.0-portable.exe',
      'Murmur-0.4.0-x64-setup.exe',
      'Murmur-0.4.0-arm64-setup.exe'
    ])
    expect(windows.recommended?.name).toBe('Murmur-0.4.0-setup.exe')
    expect(windows.recommended?.stableUrl).toBe(
      `https://github.com/${REPO}/releases/latest/download/Murmur-setup.exe`
    )
    expect(windows.recommended?.url).toBe(
      `https://github.com/${REPO}/releases/download/v0.4.0/Murmur-0.4.0-setup.exe`
    )
    expect(windows.recommended?.size).toBe(1_000_000)

    expect(manifest.platforms.linux.recommended?.name).toBe('Murmur-0.4.0-x86_64.AppImage')
    expect(manifest.platforms.linux.assets.map((a) => a.kind)).toEqual([
      'appimage',
      'deb',
      'appimage',
      'deb'
    ])
    expect(manifest.platforms.android.recommended?.name).toBe('Murmur-0.4.0-android.apk')
    expect(manifest.platforms.macos.recommended?.name).toBe('Murmur-0.4.0-arm64.dmg')
  })

  it('copes with a release that is missing files and aliases', () => {
    const partial = release()
    partial.assets = partial.assets.filter(
      (a) => a.name === 'Murmur-0.4.0-android.apk' || a.name === 'Murmur-0.4.0-x86_64.AppImage'
    )
    const manifest = buildManifest(partial, REPO)
    expect(manifest.platforms.windows.assets).toEqual([])
    expect(manifest.platforms.windows.recommended).toBeNull()
    expect(manifest.platforms.android.recommended?.stableUrl).toBeNull()
    expect(manifest.checksumsUrl).toBeNull()
    expect(manifest.install).toEqual({ sh: null, ps1: null })
    expect(recommendedAsset(manifest, 'linux')?.name).toBe('Murmur-0.4.0-x86_64.AppImage')
  })

  it('falls back to the tag when the release has no title', () => {
    expect(buildManifest(release({ name: null }), REPO).name).toBe('v0.4.0')
    expect(buildManifest(release({ name: '   ' }), REPO).name).toBe('v0.4.0')
  })

  it('reads the local-only marker the release script writes into the notes', () => {
    const notes =
      'Hold a key.\n\n## Local-only build\n\nThis release is **local-only**.\n\n## Downloads\n'
    expect(buildManifest(release({ body: notes }), REPO).localOnly).toBe(true)
    expect(buildManifest(release({ body: '## Downloads\n' }), REPO).localOnly).toBe(false)
    expect(buildManifest(release(), REPO).localOnly).toBe(false)
  })
})

describe('fallbackDownloadUrl', () => {
  it('points every download platform at its stable alias', () => {
    expect(fallbackDownloadUrl('windows', REPO)).toBe(
      `https://github.com/${REPO}/releases/latest/download/Murmur-setup.exe`
    )
    expect(fallbackDownloadUrl('linux', REPO)).toBe(
      `https://github.com/${REPO}/releases/latest/download/Murmur-x86_64.AppImage`
    )
    expect(fallbackDownloadUrl('android', REPO)).toBe(
      `https://github.com/${REPO}/releases/latest/download/Murmur-android.apk`
    )
    for (const platform of DOWNLOAD_PLATFORMS)
      expect(fallbackDownloadUrl(platform, REPO)).toMatch(/^https:/)
  })
})

describe('isGitHubRelease', () => {
  it('accepts the API shape and rejects anything else', () => {
    expect(isGitHubRelease(release())).toBe(true)
    expect(isGitHubRelease(release({ name: null, published_at: null }))).toBe(true)
    expect(isGitHubRelease(null)).toBe(false)
    expect(isGitHubRelease({ tag_name: 'v1' })).toBe(false)
    expect(isGitHubRelease({ ...release(), assets: [{ name: 'x' }] })).toBe(false)
  })
})
