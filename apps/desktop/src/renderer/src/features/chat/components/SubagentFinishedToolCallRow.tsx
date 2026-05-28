import { useId, useState } from 'react'
import type React from 'react'
import { ChevronRight } from 'lucide-react'
import type { SubagentFinishedResult } from '@renderer/app/store/useAppStore'
import { formatTokenCount } from '@renderer/lib/formatTokenCount'
import { theme } from '@renderer/theme/theme'

function formatSubagentResultDuration(durationMs?: number): string | null {
  if (durationMs === undefined) return null
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.floor((durationMs % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function SubagentFinishedToolCallRow({
  result
}: {
  result: SubagentFinishedResult
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const duration = formatSubagentResultDuration(result.durationMs)
  const tokenCount = (result.promptTokens ?? 0) + (result.completionTokens ?? 0)
  const hasDetails = Boolean(result.prompt || result.lastMessage)

  const summaryContent = (
    <>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: result.status === 'success' ? theme.status.success : theme.text.danger
        }}
      />
      <span style={{ color: theme.text.placeholder }}>delegateTask</span>
      <span style={{ color: theme.text.accent, fontWeight: 600 }}>
        · {result.codeName ?? result.agentName}
      </span>
      <span style={{ color: theme.text.placeholder }}>
        · {result.status === 'success' ? 'done' : 'stopped'}
      </span>
      {duration ? <span>· {duration}</span> : null}
      {tokenCount > 0 ? <span>· {formatTokenCount(tokenCount)} tokens</span> : null}
    </>
  )

  if (!hasDetails) {
    return (
      <div
        className="flex flex-wrap items-center gap-1.5 px-6 py-0.5"
        style={{ fontSize: '11px', color: theme.text.muted }}
      >
        {summaryContent}
      </div>
    )
  }

  return (
    <div className="px-6 py-0.5" style={{ fontSize: '11px', color: theme.text.muted }}>
      <button
        type="button"
        className="flex w-full items-start gap-2 rounded-sm text-left"
        aria-controls={detailsId}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} subagent result`}
        onClick={() => setIsExpanded((current) => !current)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 0,
          color: 'inherit',
          cursor: 'default',
          margin: 0,
          padding: 0
        }}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{summaryContent}</div>
        <span
          className="mt-0.5 inline-flex shrink-0"
          style={{ color: theme.text.placeholder, transition: 'transform 0.15s ease' }}
        >
          <ChevronRight
            size={11}
            strokeWidth={1.8}
            style={{ transform: isExpanded ? 'rotate(90deg)' : undefined }}
          />
        </span>
      </button>

      {isExpanded && (
        <div
          id={detailsId}
          className="mt-1 ml-3 flex flex-col gap-1.5 pl-3 pr-6 yachiyo-detail-reveal"
        >
          {result.prompt ? (
            <div>
              <div
                style={{
                  color: theme.text.placeholder,
                  fontSize: '10px',
                  letterSpacing: '0.04em',
                  marginBottom: '4px',
                  textTransform: 'uppercase'
                }}
              >
                prompt
              </div>
              <div
                className="message-selectable overflow-auto rounded-md px-2.5 py-1.5"
                style={{
                  background: theme.background.hover,
                  color: theme.text.secondary,
                  lineHeight: 1.5,
                  maxHeight: '92px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}
              >
                {result.prompt}
              </div>
            </div>
          ) : null}

          {result.lastMessage ? (
            <div>
              <div
                style={{
                  color: theme.text.placeholder,
                  fontSize: '10px',
                  letterSpacing: '0.04em',
                  marginBottom: '4px',
                  textTransform: 'uppercase'
                }}
              >
                result
              </div>
              <div
                className="message-selectable overflow-auto rounded-md px-2.5 py-1.5"
                style={{
                  background: theme.background.hover,
                  color: theme.text.secondary,
                  lineHeight: 1.5,
                  maxHeight: '220px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}
              >
                {result.lastMessage}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
