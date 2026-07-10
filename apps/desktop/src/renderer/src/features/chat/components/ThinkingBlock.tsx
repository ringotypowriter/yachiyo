import React, { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
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
      <button
        className="flex items-center gap-2 py-0.5 text-left"
        onClick={() =>
          setOverride((prev) => ({
            expanded: !(prev && prev.duringActive === isActive ? prev.expanded : isActive),
            duringActive: isActive
          }))
        }
      >
        {isActive ? (
          <span
            className="shrink-0 w-1.5 h-1.5 rounded-full relative -top-px"
            style={{
              background: theme.text.accent,
              animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
            }}
          />
        ) : (
          <ChevronRight
            size={11}
            strokeWidth={1.8}
            className="shrink-0"
            style={{
              color: theme.text.accent,
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 150ms ease'
            }}
          />
        )}
        <span className="text-xs font-medium tracking-wide" style={{ color: theme.text.accent }}>
          {isActive ? `Thinking · ${timer}` : 'Thought'}
        </span>
      </button>

      {isExpanded && (
        <div
          className="mt-1 ml-3 border-l pl-3"
          style={{
            borderColor: theme.border.panel,
            animation: 'yachiyo-thinking-fold-in 180ms ease-out'
          }}
        >
          {isActive ? (
            <div
              className="streamdown-content text-[11px] leading-relaxed"
              style={{ color: theme.text.tertiary }}
            >
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
              className="overflow-y-auto message-selectable"
              style={{ maxHeight: '240px' }}
            >
              <div
                className="streamdown-content message-selectable text-[11px] leading-relaxed"
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
  )
}
