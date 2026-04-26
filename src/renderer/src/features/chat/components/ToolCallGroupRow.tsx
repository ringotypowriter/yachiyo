import type React from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import {
  getToolCallGroupCount,
  getToolCallGroupDisplayGroup,
  getToolCallGroupFilePaths,
  getToolCallGroupLabel,
  type ToolCallSemanticGroup
} from '../lib/messageTimelineLayout.ts'
import { formatToolFilePathList } from '../lib/toolCallPresentation.ts'
import { ToolCallRow } from './ToolCallRow.tsx'

interface ToolCallGroupRowProps {
  group: ToolCallSemanticGroup
  toolCalls: ToolCall[]
  workspacePath?: string | null
}

export function ToolCallGroupRow({
  group,
  toolCalls,
  workspacePath
}: ToolCallGroupRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  // A `background` bash call has returned its handle but the subprocess is still running,
  // so the group should keep its in-progress affordance until that subprocess finishes.
  const allDone = toolCalls.every(
    (tc) => tc.status !== 'preparing' && tc.status !== 'running' && tc.status !== 'background'
  )
  const lastToolCall = toolCalls[toolCalls.length - 1]
  const lastFailed = lastToolCall?.status === 'failed'

  const dotColor = !allDone
    ? theme.text.accent
    : lastFailed
      ? theme.status.danger
      : theme.status.success

  const filePaths = getToolCallGroupFilePaths(group, toolCalls)
  const displayGroup = getToolCallGroupDisplayGroup(group, toolCalls)
  const baseLabel = getToolCallGroupLabel(
    displayGroup,
    getToolCallGroupCount(group, toolCalls),
    allDone
  )
  const label = filePaths.length
    ? `${baseLabel} · ${formatToolFilePathList(filePaths, workspacePath).join(', ')}`
    : baseLabel

  return (
    <div className="py-0.5" style={{ fontSize: '11px' }}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-sm text-left"
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${label}`}
        onClick={() => setIsExpanded((current) => !current)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 0,
          color: theme.text.secondary,
          cursor: 'pointer',
          fontWeight: 500,
          margin: 0,
          padding: '2px 24px'
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: dotColor,
            animation: !allDone ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
          }}
        />
        <span>{label}</span>
        <span
          className="inline-flex shrink-0"
          style={{
            color: theme.text.placeholder,
            transition: 'transform 0.15s ease'
          }}
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
          className="ml-7 mt-0.5 border-l pl-1 yachiyo-detail-reveal"
          style={{ borderColor: theme.border.panel }}
        >
          {toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} toolCall={tc} workspacePath={workspacePath} />
          ))}
        </div>
      )}
    </div>
  )
}
