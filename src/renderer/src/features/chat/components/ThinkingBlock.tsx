import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Streamdown } from 'streamdown'
import { mathPlugin } from '@renderer/lib/markdown/mathPlugin'
import { code } from '@streamdown/code'
import { theme } from '@renderer/theme/theme'
import { useThinkingPager } from '../hooks/useThinkingPager'
import { useThinkingTimer } from '../hooks/useThinkingTimer'

interface ThinkingBlockProps {
  reasoning: string
  isActive: boolean
  startedAt: string
}

export function ThinkingBlock({
  reasoning,
  isActive,
  startedAt
}: ThinkingBlockProps): React.JSX.Element | null {
  const [override, setOverride] = useState<{ expanded: boolean; duringActive: boolean } | null>(
    null
  )
  const isExpanded = override && override.duringActive === isActive ? override.expanded : isActive
  const contentRef = useRef<HTMLDivElement>(null)

  const page = useThinkingPager(reasoning, isActive)
  const timer = useThinkingTimer(isActive, startedAt)

  useEffect(() => {
    if (!isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [isActive])

  const plugins = useMemo(() => ({ math: mathPlugin, code }), [])

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
          onClick={() =>
            setOverride((prev) => ({
              expanded: !(prev && prev.duringActive === isActive ? prev.expanded : isActive),
              duringActive: isActive
            }))
          }
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
            {isActive ? `Thinking · ${timer}` : 'Thought'}
          </span>
        </button>

        {isExpanded && (
          <div style={{ animation: 'yachiyo-thinking-fold-in 180ms ease-out' }}>
            {isActive ? (
              <div className="px-3 pb-3 streamdown-content" style={{ color: theme.text.tertiary }}>
                <pre
                  key={page.index}
                  className="whitespace-pre-wrap wrap-break-word m-0"
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    lineHeight: 'inherit',
                    height: 'calc(1.6em * 4)',
                    overflow: 'hidden',
                    animation: 'yachiyo-thinking-page-swap 280ms ease-out'
                  }}
                >
                  {page.text}
                </pre>
              </div>
            ) : (
              <div
                ref={contentRef}
                className="px-3 pb-3 overflow-y-auto message-selectable"
                style={{ maxHeight: '240px' }}
              >
                <div
                  className="streamdown-content message-selectable"
                  style={{ color: theme.text.tertiary }}
                >
                  <Streamdown mode="static" controls={true} plugins={plugins}>
                    {reasoning}
                  </Streamdown>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
