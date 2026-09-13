import { Surface } from '@/components/ui/surface'
import { FAQ } from '@/lib/pricing'

/* A list card: xl with tight padding, so its md rows are concentric with it. */
export function Faq() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="text-center">
        <div className="eyebrow">Questions</div>
        <h2 className="serif-display mt-4 text-title">The fine print, without the fine print.</h2>
      </div>
      <Surface padding="card-tight" className="mt-section">
        <div className="grid">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-md transition-colors duration-200 open:bg-muted"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-4 py-3.5 text-lead font-medium tracking-tight [&::-webkit-details-marker]:hidden">
                <span>{item.q}</span>
                <span
                  aria-hidden
                  className="well relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-transform duration-200 group-open:rotate-45 group-open:bg-card"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M6 1v10M1 6h10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </summary>
              <p className="px-4 pt-0 pb-4 text-body text-pretty text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </Surface>
    </div>
  )
}
