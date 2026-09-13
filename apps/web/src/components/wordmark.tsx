import { cn } from '@/lib/cn'

/**
 * The name, set in the display serif exactly as the apps set it. Murmur has no mark yet; the
 * wordmark is the mark. The waveform glyph stays an OS-level icon (here, the favicon) and is not
 * used inside any page.
 */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('serif-display text-heading leading-none', className)}>Murmur</span>
}
