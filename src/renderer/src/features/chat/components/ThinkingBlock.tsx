import React, { useState, useRef, useEffect } from 'react'
import { theme } from '@renderer/theme/theme'

interface ThinkingBlockProps {
  reasoning: string
  isActive: boolean
}

export function ThinkingBlock({
  reasoning,
  isActive
}: ThinkingBlockProps): React.JSX.Element | null {
  const [manuallyExpanded, setManuallyExpanded] = useState(false)
  const isExpanded = isActive || manuallyExpanded
  const contentRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom while streaming
  useEffect(() => {
    if (isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [reasoning, isActive])

  if (!reasoning) return null

  return (
    <div className="px-6 py-1">
      <div
        style={{
          background: theme.background.accentSoft,
          borderLeft: `2px solid ${theme.border.accent}`,
          borderRadius: '0 6px 6px 0'
        }}
      >
        <button
          className="flex items-center gap-2 w-full px-3 py-2 text-left"
          onClick={() => !isActive && setManuallyExpanded((v) => !v)}
        >
          {isActive ? (
            <span
              className="shrink-0 w-1.5 h-1.5 rounded-full"
              style={{
                background: theme.text.accent,
                animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
              }}
            />
          ) : (
            <svg
              className="shrink-0"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              style={{
                color: theme.text.accent,
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 150ms ease'
              }}
            >
              <path
                d="M3 2L7 5L3 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span className="text-xs font-medium tracking-wide" style={{ color: theme.text.accent }}>
            {isActive ? 'Thinking...' : 'Thinking'}
          </span>
        </button>

        {isExpanded && (
          <div
            ref={contentRef}
            className="px-3 pb-3 overflow-y-auto message-selectable"
            style={{ maxHeight: '240px' }}
          >
            <p
              className="text-xs whitespace-pre-wrap leading-relaxed"
              style={{ color: theme.text.tertiary }}
            >
              {reasoning}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
