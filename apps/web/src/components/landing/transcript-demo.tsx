import { Surface } from '@/components/ui/surface'
import { DictationPill } from './pill'

/*
 * One dictation, end to end. The raw transcript is what a speech model really returns for speech
 * like this; the typed text is what the engine inserts; the checks are the verifier's invariants
 * for this very pair (see packages/text-engine/src/verify.ts).
 */
const RAW =
  'um so the the invoice is one thousand two hundred dollars and it’s due on the fifteenth uh new line thanks abby'

const TYPED = ['The invoice is $1,200 and it’s due on the 15th.', 'Thanks, Abby']

const CHECKS = [
  { label: 'Numbers', value: '1200 · 15, same order' },
  { label: 'Words kept', value: '11 of 12 content words' },
  { label: 'Command', value: '“new line” applied' }
]

export function TranscriptDemo() {
  return (
    <div className="relative">
      <DictationPill className="absolute -top-6 left-6 z-10 sm:left-8" />
      <Surface className="pt-12">
        <div className="well rounded-md px-4 py-3.5">
          <div className="eyebrow mb-2">What you said</div>
          <p className="text-lead text-muted-foreground">{RAW}</p>
        </div>
        <div className="flex items-center justify-center py-2" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 16 16" className="text-muted-foreground/70">
            <path
              d="M8 2v11M3.5 8.5 8 13l4.5-4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="px-4 pb-1">
          <div className="eyebrow mb-2">What landed where your cursor was</div>
          {TYPED.map((line) => (
            <p key={line} className="serif-display text-heading">
              {line}
            </p>
          ))}
        </div>
        <dl className="mt-card grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          {CHECKS.map((check) => (
            <div key={check.label} className="flex items-start gap-2.5">
              <span
                className="mt-1.5 inline-flex size-2 shrink-0 rounded-full bg-success"
                aria-hidden
              />
              <div>
                <dt className="text-caption font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  {check.label}
                </dt>
                <dd className="mt-0.5 text-note text-foreground/85">{check.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </Surface>
    </div>
  )
}
