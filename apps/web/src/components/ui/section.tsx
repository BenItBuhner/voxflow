import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-5 sm:px-8 lg:px-gutter', className)}>
      {children}
    </div>
  )
}

/** A page block: generous vertical room instead of a rule between it and the next. */
export function Section({
  id,
  className,
  children
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} className={cn('scroll-mt-24 py-16 sm:py-24', className)}>
      <Container>{children}</Container>
    </section>
  )
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = 'left',
  className
}: {
  eyebrow?: string
  title: ReactNode
  lede?: ReactNode
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h2 className="serif-display mt-4 text-title text-balance">{title}</h2>
      {lede && <p className="mt-5 text-lead text-pretty text-muted-foreground">{lede}</p>}
    </div>
  )
}

/** A pill label: the apps' badge, in its tonal (well) or tinted forms. */
export function Chip({
  tone = 'well',
  className,
  children
}: {
  tone?: 'well' | 'success' | 'record' | 'card'
  className?: string
  children: ReactNode
}) {
  const tones = {
    well: 'well text-muted-foreground',
    card: 'bg-card text-muted-foreground shadow-raised',
    success: 'bg-success/12 text-success',
    record: 'bg-record/12 text-record'
  }
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium tracking-[0.06em] whitespace-nowrap uppercase',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
