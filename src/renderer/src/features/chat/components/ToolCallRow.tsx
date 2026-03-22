import type React from 'react'
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { buildToolCallDetailsPresentation } from '../lib/toolCallPresentation.ts'

interface ToolCallRowProps {
  toolCall: ToolCall
}

function elapsedSeconds(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  return `${(ms / 1000).toFixed(1)}s`
}

export function ToolCallRow({ toolCall }: ToolCallRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const isRunning = toolCall.status === 'running'
  const isFailed = toolCall.status === 'failed'
  const dotColor = isFailed
    ? theme.status.danger
    : isRunning
      ? theme.text.accent
      : theme.status.success
  const presentation = buildToolCallDetailsPresentation(toolCall)
  const hasExpandableDetails = presentation.fields.length > 0 || presentation.codeBlocks.length > 0

  const summaryContent = (
    <>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: dotColor,
          animation: isRunning ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
        }}
      />
      <span>{toolCall.toolName}</span>
      <span>· {toolCall.inputSummary}</span>
      {toolCall.cwd && <span>· cwd {toolCall.cwd}</span>}
      {toolCall.outputSummary && (
        <span style={{ color: isFailed ? theme.text.danger : theme.text.placeholder }}>
          · {toolCall.outputSummary}
        </span>
      )}
      {!isRunning && toolCall.finishedAt && (
        <span>· {elapsedSeconds(toolCall.startedAt, toolCall.finishedAt)}</span>
      )}
    </>
  )

  if (!hasExpandableDetails) {
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
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${toolCall.toolName} details`}
        onClick={() => setIsExpanded((current) => !current)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 0,
          color: 'inherit',
          cursor: 'pointer',
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

      {isExpanded ? (
        <div
          id={detailsId}
          className="mt-1 ml-3 flex flex-col gap-1.5 border-l pl-3 pr-6"
          style={{ borderColor: theme.border.panel }}
        >
          {presentation.fields.length > 0 ? (
            <div
              className="flex flex-wrap gap-x-3 gap-y-1"
              style={{ color: theme.text.placeholder }}
            >
              {presentation.fields.map((field) => (
                <span key={`${field.label}:${field.value}`}>
                  <span style={{ opacity: 0.72 }}>{field.label}</span>{' '}
                  <span
                    className="break-all"
                    style={{
                      color: field.tone === 'danger' ? theme.text.danger : theme.text.tertiary,
                      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
                    }}
                  >
                    {field.value}
                  </span>
                </span>
              ))}
            </div>
          ) : null}

          {presentation.codeBlocks.map((block) => (
            <div key={`${block.label}:${block.value.slice(0, 32)}`}>
              <div
                style={{
                  color: block.tone === 'danger' ? theme.text.danger : theme.text.placeholder,
                  fontSize: '10px',
                  letterSpacing: '0.04em',
                  marginBottom: '4px',
                  textTransform: 'uppercase'
                }}
              >
                {block.label}
              </div>
              <pre
                className="message-selectable overflow-auto rounded-md px-3 py-2"
                style={{
                  background:
                    block.tone === 'danger'
                      ? theme.background.dangerSoft
                      : theme.background.codeBlock,
                  border: `1px solid ${
                    block.tone === 'danger' ? theme.border.danger : theme.border.default
                  }`,
                  color: block.tone === 'danger' ? theme.text.dangerStrong : theme.text.secondary,
                  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                  fontSize: '10.5px',
                  lineHeight: 1.5,
                  margin: 0,
                  maxHeight: '160px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}
              >
                {block.value}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
