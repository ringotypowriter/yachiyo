import type React from 'react'
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import {
  buildToolCallDetailsPresentation,
  buildToolCallRowSummary,
  getToolCallDetailBlocks
} from '../lib/tool-calls/toolCallPresentation.ts'
import { AskUserInlineWidget } from './AskUserInlineWidget.tsx'
import { ToolCallDetailsPanel } from './ToolCallDetailsPanel.tsx'

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
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()

  // askUser tool gets a dedicated inline widget
  if (toolCall.toolName === 'askUser') {
    return <AskUserInlineWidget toolCall={toolCall} nested={nested} />
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
  const hasExpandableDetails = getToolCallDetailBlocks(presentation).length > 0

  const rowSummary = buildToolCallRowSummary(toolCall, workspacePath)

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
      {rowSummary.inputSummary ? (
        <span style={{ color: theme.text.secondary }}>· {rowSummary.inputSummary}</span>
      ) : null}
      {toolCall.cwd && (!workspacePath || toolCall.cwd !== workspacePath) ? (
        <span>· cwd {toolCall.cwd}</span>
      ) : null}
      {rowSummary.outputSummary && (
        <span style={{ color: isFailed ? theme.text.danger : theme.text.placeholder }}>
          · {rowSummary.outputSummary}
        </span>
      )}
      {!isActive &&
        toolCall.finishedAt &&
        (() => {
          const elapsed = elapsedSeconds(toolCall.startedAt, toolCall.finishedAt)
          return elapsed ? <span>· {elapsed}</span> : null
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
        aria-label={
          isExpanded
            ? t('chat.tools.collapseDetailsAria', { name: toolCall.toolName })
            : t('chat.tools.expandDetailsAria', { name: toolCall.toolName })
        }
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

      {isExpanded ? (
        <ToolCallDetailsPanel
          id={detailsId}
          presentation={presentation}
          className="mt-1 ml-3"
          nested={nested}
        />
      ) : null}
    </div>
  )
}
