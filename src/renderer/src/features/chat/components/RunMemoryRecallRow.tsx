import type React from 'react'
import { useId, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

interface RunMemoryRecallRowProps {
  entries: string[]
}

export function RunMemoryRecallRow({ entries }: RunMemoryRecallRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()

  return (
    <div className="px-6 pb-1">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-left"
        aria-controls={detailsId}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} recalled memory`}
        onClick={() => setIsExpanded((current) => !current)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 'none',
          color: theme.text.placeholder,
          cursor: 'pointer',
          padding: 0,
          textDecoration: 'underline',
          textUnderlineOffset: '3px',
          textDecorationColor: theme.border.strong
        }}
      >
        <Brain size={12} strokeWidth={1.9} style={{ color: theme.text.accent }} />
        <span style={{ fontSize: '11px' }}>
          {entries.length} recalled {entries.length === 1 ? 'memory' : 'memories'}
        </span>
        <ChevronRight
          size={11}
          strokeWidth={1.8}
          style={{
            color: theme.text.placeholder,
            transform: isExpanded ? 'rotate(90deg)' : undefined,
            transition: 'transform 0.15s ease'
          }}
        />
      </button>

      {isExpanded ? (
        <div
          id={detailsId}
          className="mt-2 max-w-lg rounded-2xl px-4 py-3"
          style={{
            background: theme.background.surfaceSoft,
            border: `1px solid ${theme.border.panel}`,
            color: theme.text.secondary
          }}
        >
          <div
            className="mb-2"
            style={{
              color: theme.text.placeholder,
              fontSize: '10px',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }}
          >
            Memory used for this run
          </div>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div key={entry} className="flex gap-2" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                <span style={{ color: theme.text.accent }}>•</span>
                <span className="message-selectable whitespace-pre-wrap wrap-break-words">
                  {entry}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
