import { cva } from 'class-variance-authority'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mizu-500/20 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4 shrink-0 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-mizu-500 text-white hover:bg-mizu-600 active:bg-mizu-700',
        outline: 'bg-mizu-50/60 text-mizu-700 hover:bg-mizu-100/80',
        ghost: 'hover:bg-mizu-50/60 text-ink',
        secondary: 'bg-mizu-50 text-mizu-700 hover:bg-mizu-100',
        link: 'text-mizu-600 underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-10 px-6 py-2',
        sm: 'h-8 rounded-full px-4 text-xs',
        lg: 'h-12 rounded-full px-8 text-base',
        icon: 'size-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)
