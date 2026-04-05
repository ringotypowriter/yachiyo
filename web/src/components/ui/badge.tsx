import type { HTMLAttributes, ReactElement } from 'react'
import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { badgeVariants } from './badge-variants'

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): ReactElement {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
