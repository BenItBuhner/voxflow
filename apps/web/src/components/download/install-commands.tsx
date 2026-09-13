import { Surface } from '@/components/ui/surface'
import type { ReleaseManifest } from '@/lib/releases'
import { latestDownloadBase } from '@/lib/site'

/** The one-line installers the release workflow uploads next to every release. */
export function InstallCommands({ manifest }: { manifest: ReleaseManifest | null }) {
  const base = latestDownloadBase()
  const sh = manifest?.install.sh ?? `${base}/install.sh`
  const ps1 = manifest?.install.ps1 ?? `${base}/install.ps1`
  const commands = [
    { label: 'Linux and macOS', code: `curl -fsSL ${sh} | bash` },
    { label: 'Windows (PowerShell)', code: `irm ${ps1} | iex` }
  ]
  return (
    <Surface>
      <h2 className="serif-display text-heading">Install in one command</h2>
      <p className="mt-2 text-body text-muted-foreground">
        The scripts pick the right file for your machine from the latest release and verify it
        against the release’s checksums before installing.
      </p>
      <div className="mt-card grid gap-2">
        {commands.map((c) => (
          <div key={c.label} className="well rounded-md px-4 py-3.5">
            <div className="eyebrow">{c.label}</div>
            <pre className="mt-2 overflow-x-auto font-mono text-note">
              <code>{c.code}</code>
            </pre>
          </div>
        ))}
      </div>
    </Surface>
  )
}
