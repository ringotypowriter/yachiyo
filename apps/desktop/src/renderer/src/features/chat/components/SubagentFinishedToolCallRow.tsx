import type React from 'react'
import type { ToolCall } from '@renderer/app/types'
import type { SubagentFinishedResult } from '@renderer/app/store/useAppStore'
import { formatTokenCount } from '@renderer/lib/formatTokenCount'
import { ToolCallRow } from './ToolCallRow'

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
  const duration = formatSubagentResultDuration(result.durationMs)
  const tokenCount = (result.promptTokens ?? 0) + (result.completionTokens ?? 0)
  const summaryParts = [
    result.status === 'success' ? 'done' : 'stopped',
    duration,
    tokenCount > 0 ? `${formatTokenCount(tokenCount)} tokens` : null
  ].filter((part): part is string => Boolean(part))
  const toolCall: ToolCall = {
    id: result.delegationId,
    threadId: 'subagent-result',
    toolName: 'delegateTask',
    status: result.status === 'success' ? 'completed' : 'failed',
    inputSummary: result.codeName ?? result.agentName,
    ...(summaryParts.length > 0 ? { outputSummary: summaryParts.join(' · ') } : {}),
    ...(result.prompt ? { rawInput: result.prompt } : {}),
    ...(result.lastMessage ? { rawOutput: result.lastMessage } : {}),
    startedAt: new Date(0).toISOString()
  }

  return <ToolCallRow toolCall={toolCall} />
}
