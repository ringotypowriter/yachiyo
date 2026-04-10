import type React from 'react'
import { Fragment, useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { EditToolCallDetails, ToolCall, WriteToolCallDetails } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { buildToolCallDetailsPresentation } from '../lib/toolCallPresentation.ts'
import { ToolCodeBlock } from './ToolCodeBlock.tsx'
import { AskUserInlineWidget } from './AskUserInlineWidget.tsx'

interface ToolCallRowProps {
  toolCall: ToolCall
}

function elapsedSeconds(startedAt: string, finishedAt: string): string | null {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  const s = ms / 1000
  return s >= 0.1 ? `${s.toFixed(1)}s` : null
}

export function ToolCallRow({ toolCall }: ToolCallRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()

  // askUser tool gets a dedicated inline widget
  if (toolCall.toolName === 'askUser') {
    return <AskUserInlineWidget toolCall={toolCall} />
  }

  const isRunning = toolCall.status === 'running'
  const isBackground = toolCall.status === 'background'
  const isFailed = toolCall.status === 'failed'
  const dotColor = isFailed
    ? theme.status.danger
    : isRunning || isBackground
      ? theme.text.accent
      : theme.status.success
  const presentation = buildToolCallDetailsPresentation(toolCall)
  // Only show secondary-tier blocks inline; inspection-tier blocks belong in the run inspector
  const secondaryCodeBlocks = presentation.codeBlocks.filter((b) => b.displayTier !== 'inspection')
  const hasExpandableDetails = presentation.fields.length > 0 || secondaryCodeBlocks.length > 0

  const summaryContent = (
    <>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: dotColor,
          animation:
            isRunning || isBackground
              ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite'
              : undefined
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
      {!isRunning &&
        toolCall.finishedAt &&
        (() => {
          const t = elapsedSeconds(toolCall.startedAt, toolCall.finishedAt)
          return t ? <span>· {t}</span> : null
        })()}
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
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr max-content 1fr',
                columnGap: '10px',
                rowGap: '2px'
              }}
            >
              {presentation.fields.map((field) => (
                <Fragment key={field.label}>
                  <span style={{ color: theme.text.placeholder, textAlign: 'right' }}>
                    {field.label}
                  </span>
                  <span
                    className="break-all"
                    style={{
                      color: field.tone === 'danger' ? theme.text.danger : theme.text.tertiary,
                      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
                    }}
                  >
                    {field.value}
                  </span>
                </Fragment>
              ))}
            </div>
          ) : null}

          {secondaryCodeBlocks.map((block) => (
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
              {block.label === 'diff' ? (
                <ToolCodeBlock
                  value={block.value}
                  filePath={(toolCall.details as EditToolCallDetails | undefined)?.path}
                  variant="diff"
                />
              ) : block.label === 'preview' ? (
                <ToolCodeBlock
                  value={block.value}
                  filePath={(toolCall.details as WriteToolCallDetails | undefined)?.path}
                />
              ) : (
                <pre
                  className="message-selectable overflow-auto rounded-md px-3 py-2"
                  style={{
                    background:
                      block.tone === 'danger'
                        ? theme.background.dangerSoft
                        : theme.background.codeBlock,
                    border: block.tone === 'danger' ? 'none' : `1px solid ${theme.border.default}`,
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
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
