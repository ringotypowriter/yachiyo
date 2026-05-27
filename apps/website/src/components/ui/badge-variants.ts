import { cva } from 'class-variance-authority'

export const badgeVariants = cva(
  'inline-flex items-center rounded-full px-3 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-mizu-100 text-mizu-700',
        secondary: 'bg-mizu-50 text-ink',
        outline: 'bg-transparent text-mizu-700',
        ghost: 'bg-transparent text-mizu-600'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)
