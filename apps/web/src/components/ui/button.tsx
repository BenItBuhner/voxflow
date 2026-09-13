import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/*
 * Buttons are pills, as in the apps: filled (primary), tonal (a well that darkens on hover) and
 * ghost (bare text); raised is a tonal button that sits on a well, lifted like the apps' switch
 * thumb. None of them draws an edge.
 */
export type ButtonVariant = 'primary' | 'tonal' | 'raised' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[background-color,color,transform,box-shadow] duration-200 active:scale-[0.985] outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/88',
  tonal: 'well text-foreground hover:bg-accent',
  raised: 'bg-card text-foreground shadow-raised hover:bg-accent',
  ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3.5 text-note',
  md: 'h-9 px-4.5 text-body',
  lg: 'h-12 px-7 text-lead'
}

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className)
}

type ButtonProps = ComponentProps<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />
}

type ButtonLinkProps = Omit<ComponentProps<typeof Link>, 'className'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  children: ReactNode
}

export function ButtonLink({ variant, size, className, children, ...props }: ButtonLinkProps) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </Link>
  )
}

/** External links (GitHub assets, the release page) that should look like buttons. */
export function ButtonAnchor({
  variant,
  size,
  className,
  children,
  ...props
}: ComponentProps<'a'> & { variant?: ButtonVariant; size?: ButtonSize; children: ReactNode }) {
  return (
    <a className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </a>
  )
}
