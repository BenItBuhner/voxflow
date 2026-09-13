import { ButtonLink } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import type { AccountsSetup } from '@/lib/env'

/** What /account shows on a deployment without a Murmur instance behind it. */
export function AccountUnavailable({
  setup
}: {
  setup: Extract<AccountsSetup, { configured: false }>
}) {
  return (
    <div className="grid items-start gap-card lg:grid-cols-[1.2fr_0.8fr]">
      <Surface>
        <h2 className="serif-display text-heading">Accounts are not switched on here yet</h2>
        <p className="mt-3 text-lead text-muted-foreground">
          This copy of the site is not connected to a Murmur instance, so there is nothing to sign
          in to. The apps work without an account: connect a speech model of your own under Models
          and everything stays on the device.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/download">Download Murmur</ButtonLink>
          <ButtonLink href="/pricing" variant="tonal">
            What an account adds
          </ButtonLink>
        </div>
      </Surface>
      <Surface role="well">
        <div className="eyebrow">For the operator</div>
        <p className="mt-2 text-note text-muted-foreground">
          Set these on the deployment and this page becomes the sign-in and account view for the
          Clerk application and Convex deployment the apps use:
        </p>
        <ul className="mt-3 grid gap-1.5">
          {setup.missing.map((name) => (
            <li
              key={name}
              className="rounded-xs bg-card px-3 py-2 font-mono text-meta shadow-raised"
            >
              {name}
            </li>
          ))}
        </ul>
      </Surface>
    </div>
  )
}
