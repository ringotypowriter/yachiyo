import type { ComposerReasoningSelection } from '@renderer/app/types'

export const REASONING_SELECTION_COPY: Record<
  ComposerReasoningSelection,
  { label: string; description: string }
> = {
  off: {
    label: 'Off',
    description: 'No reasoning controls for the next run'
  },
  low: {
    label: 'Low',
    description: 'Small reasoning budget'
  },
  medium: {
    label: 'Medium',
    description: 'Balanced reasoning budget'
  },
  high: {
    label: 'High',
    description: 'Larger reasoning budget'
  },
  xhigh: {
    label: 'XHigh',
    description: 'Very large reasoning budget'
  },
  max: {
    label: 'Max',
    description: 'Maximum available reasoning'
  }
}

export function formatReasoningSelection(selection: ComposerReasoningSelection): string {
  return REASONING_SELECTION_COPY[selection].label
}
