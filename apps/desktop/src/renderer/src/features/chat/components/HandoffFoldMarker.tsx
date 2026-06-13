import type React from 'react'
import { ChevronsUpDown } from 'lucide-react'

interface HandoffFoldMarkerProps {
  foldKey: string
  expanded: boolean
  foldedMessageCount: number
  onToggle: () => void
}

export function HandoffFoldMarker({
  foldKey,
  expanded,
  foldedMessageCount,
  onToggle
}: HandoffFoldMarkerProps): React.JSX.Element {
  return (
    <div className="handoff-fold-marker" role="note" data-handoff-fold-key={foldKey}>
      <button
        type="button"
        className="handoff-fold-marker__divider"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="handoff-fold-marker__pill">
          <ChevronsUpDown
            size={11}
            strokeWidth={1.9}
            className="handoff-fold-marker__icon"
            style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          />
          <span>
            Context handoff · {foldedMessageCount} message
            {foldedMessageCount === 1 ? '' : 's'}
          </span>
        </span>
      </button>
    </div>
  )
}
