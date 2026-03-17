import type React from 'react'
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
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
  const dotColor = isFailed ? '#b53a2f' : isRunning ? '#CC7D5E' : '#7a8b73'
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
        <span style={{ color: isFailed ? '#b53a2f' : '#a19a90' }}>· {toolCall.outputSummary}</span>
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
        style={{ fontSize: '11px', color: '#8f8a82' }}
      >
        {summaryContent}
      </div>
    )
  }

  return (
    <div className="px-6 py-0.5" style={{ fontSize: '11px', color: '#8f8a82' }}>
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
          style={{ color: '#b2aba1', transition: 'transform 0.15s ease' }}
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
          style={{ borderColor: 'rgba(0, 0, 0, 0.08)' }}
        >
          {presentation.fields.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1" style={{ color: '#968f85' }}>
              {presentation.fields.map((field) => (
                <span key={`${field.label}:${field.value}`}>
                  <span style={{ opacity: 0.72 }}>{field.label}</span>{' '}
                  <span
                    className="break-all"
                    style={{
                      color: field.tone === 'danger' ? '#b53a2f' : '#7f776d',
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
                  color: block.tone === 'danger' ? '#b53a2f' : '#a19a90',
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
                    block.tone === 'danger' ? 'rgba(181, 58, 47, 0.06)' : 'rgba(0, 0, 0, 0.035)',
                  border: `1px solid ${
                    block.tone === 'danger' ? 'rgba(181, 58, 47, 0.14)' : 'rgba(0, 0, 0, 0.06)'
                  }`,
                  color: block.tone === 'danger' ? '#8f2b22' : '#6f675f',
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
