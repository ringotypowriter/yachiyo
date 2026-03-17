import type React from 'react'
import type { ToolCall } from '@renderer/app/types'

interface ToolCallRowProps {
  toolCall: ToolCall
}

function elapsedSeconds(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  return `${(ms / 1000).toFixed(1)}s`
}

export function ToolCallRow({ toolCall }: ToolCallRowProps): React.JSX.Element {
  const isRunning = toolCall.status === 'running'
  const isFailed = toolCall.status === 'failed'
  const dotColor = isFailed ? '#b53a2f' : isRunning ? '#CC7D5E' : '#7a8b73'

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-6 py-0.5"
      style={{ fontSize: '11px', color: '#8f8a82' }}
    >
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
    </div>
  )
}
