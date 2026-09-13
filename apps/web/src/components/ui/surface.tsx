import type { ElementType, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/*
 * The apps' surface roles, radius scale and spacing roles as one component, so a page says what a
 * thing is rather than how it is drawn. Nesting is concentric on the 4px grid: a card (xl, 20px)
 * padded tight (8px) holds md rows (12px); a card padded normally holds md wells and xs key caps.
 * Every class is spelled out so Tailwind's scanner finds it.
 */
export type SurfaceRole = 'raised' | 'floating' | 'overlay' | 'well'
export type SurfaceRadius = 'md' | 'lg' | 'xl' | '2xl'
export type SurfacePadding = 'card' | 'card-tight' | 'none'

const ROLE: Record<SurfaceRole, string> = {
  raised: 'surface-raised',
  floating: 'surface-floating',
  overlay: 'surface-overlay',
  well: 'well'
}
const RADIUS: Record<SurfaceRadius, string> = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl'
}
const PADDING: Record<SurfacePadding, string> = {
  card: 'p-card',
  'card-tight': 'p-card-tight',
  none: ''
}

interface SurfaceProps {
  role?: SurfaceRole
  radius?: SurfaceRadius
  padding?: SurfacePadding
  as?: ElementType
  id?: string
  className?: string
  children?: ReactNode
}

export function Surface({
  role = 'raised',
  radius = 'xl',
  padding = 'card',
  as: Tag = 'div',
  id,
  className,
  children
}: SurfaceProps) {
  return (
    <Tag id={id} className={cn(ROLE[role], RADIUS[radius], PADDING[padding], className)}>
      {children}
    </Tag>
  )
}
