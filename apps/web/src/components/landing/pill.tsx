import { cn } from '@/lib/cn'

const BAR_DELAYS = ['0ms', '140ms', '280ms', '140ms', '0ms']
const BAR_HEIGHTS = ['h-2.5', 'h-4', 'h-5', 'h-4', 'h-2.5']

/**
 * The dictation pill as it floats over other apps while you speak: always dark, its own shadow
 * with a light catch on top, the five bars in the recording coral. Decorative, so hidden from
 * assistive technology.
 */
export function DictationPill({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'dictation-pill inline-flex h-12 items-center gap-3.5 rounded-full pr-5 pl-4',
        className
      )}
    >
      <span className="flex h-5 items-center gap-[3px]">
        {BAR_HEIGHTS.map((height, i) => (
          <span
            key={i}
            className={cn('w-[3px] origin-center rounded-full bg-record animate-pill-bar', height)}
            style={{ animationDelay: BAR_DELAYS[i] }}
          />
        ))}
      </span>
      <span className="text-body font-medium tracking-tight">Listening</span>
      <span className="text-meta text-overlay-foreground/55">release to insert</span>
    </div>
  )
}
