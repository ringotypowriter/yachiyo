import type React from 'react'
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { JsonTreeView } from './JsonTreeView.tsx'
import { isValidJson } from '../lib/jsonTree/isValidJson.ts'
import {
  buildToolCallDetailsPresentation,
  formatToolFilePath
} from '../lib/tool-calls/toolCallPresentation.ts'
import { ToolCodeBlock } from './ToolCodeBlock.tsx'
import { AskUserInlineWidget } from './AskUserInlineWidget.tsx'

interface ToolCallRowProps {
  toolCall: ToolCall
  workspacePath?: string | null
  nested?: boolean
}

function elapsedSeconds(startedAt: string, finishedAt: string): string | null {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  const s = ms / 1000
  return s >= 0.1 ? `${s.toFixed(1)}s` : null
}

export function ToolCallRow({
  toolCall,
  workspacePath,
  nested = false
}: ToolCallRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()

  // askUser tool gets a dedicated inline widget
  if (toolCall.toolName === 'askUser') {
    return <AskUserInlineWidget toolCall={toolCall} />
  }

  const isPreparing = toolCall.status === 'preparing'
  const isRunning = toolCall.status === 'running'
  const isActive = isPreparing || isRunning
  const isFailed = toolCall.status === 'failed'
  const dotColor = isFailed
    ? theme.status.danger
    : isActive
      ? theme.text.accent
      : theme.status.success
  const presentation = buildToolCallDetailsPresentation(toolCall)
  const rowPaddingClass = nested ? 'px-0' : 'px-6'
  const detailBlocks = [presentation.input, presentation.output].filter(
    (block): block is NonNullable<typeof block> => Boolean(block?.value)
  )
  const hasExpandableDetails = detailBlocks.length > 0

  const isPathTool =
    toolCall.toolName === 'read' || toolCall.toolName === 'write' || toolCall.toolName === 'edit'
  const displaySummary =
    isPathTool && toolCall.inputSummary
      ? formatToolFilePath(toolCall.inputSummary, workspacePath)
      : toolCall.inputSummary

  const summaryContent = (
    <>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: dotColor,
          animation: isActive ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
        }}
      />
      <span style={{ color: theme.text.placeholder }}>{toolCall.toolName}</span>
      {displaySummary ? (
        <span style={{ color: theme.text.secondary }}>· {displaySummary}</span>
      ) : null}
      {toolCall.cwd && (!workspacePath || toolCall.cwd !== workspacePath) ? (
        <span>· cwd {toolCall.cwd}</span>
      ) : null}
      {toolCall.outputSummary && (
        <span style={{ color: isFailed ? theme.text.danger : theme.text.placeholder }}>
          · {toolCall.outputSummary}
        </span>
      )}
      {!isActive &&
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
        className={`flex flex-wrap items-center gap-1.5 ${rowPaddingClass} py-0.5`}
        style={{ fontSize: '11px', color: theme.text.muted }}
      >
        {summaryContent}
      </div>
    )
  }

  return (
    <div
      className={`${rowPaddingClass} py-0.5`}
      style={{ fontSize: '11px', color: theme.text.muted }}
    >
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
          className={`mt-1 ml-3 flex flex-col gap-1.5 border-l pl-3 ${nested ? 'pr-0' : 'pr-6'} yachiyo-detail-reveal`}
          style={{ borderColor: theme.border.panel }}
        >
          {detailBlocks.map((block) => (
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
              {block.label.startsWith('diff') ? (
                <ToolCodeBlock value={block.value} filePath={block.filePath} variant="diff" />
              ) : isValidJson(block.value) && block.tone !== 'danger' ? (
                <JsonTreeView value={block.value} />
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
      )}
    </div>
  )
}
