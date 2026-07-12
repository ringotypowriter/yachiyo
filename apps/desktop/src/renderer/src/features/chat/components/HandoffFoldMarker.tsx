import type React from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'

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
  useT()
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
          <span>{tPlural('chat.timeline.handoffFold', foldedMessageCount)}</span>
        </span>
      </button>
    </div>
  )
}
