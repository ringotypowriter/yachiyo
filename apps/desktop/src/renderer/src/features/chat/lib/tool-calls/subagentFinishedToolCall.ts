import type { SubagentFinishedResult } from '@renderer/app/store/useAppStore'
import type { ToolCall } from '@renderer/app/types'
import { formatTokenCount } from '@renderer/lib/formatTokenCount'
import type { useT } from '@yachiyo/i18n/react'

type Translate = ReturnType<typeof useT>

function formatSubagentResultDuration(durationMs?: number): string | null {
  if (durationMs === undefined) return null
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.floor((durationMs % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function buildSubagentFinishedToolCall(
  result: SubagentFinishedResult,
  t: Translate
): ToolCall {
  const duration = formatSubagentResultDuration(result.durationMs)
  const tokenCount = (result.promptTokens ?? 0) + (result.completionTokens ?? 0)
  const summaryParts = [
    result.status === 'success'
      ? t('chat.subagents.resultDone')
      : t('chat.subagents.resultStopped'),
    duration,
    tokenCount > 0 ? t('chat.subagents.tokens', { count: formatTokenCount(tokenCount) }) : null
  ].filter((part): part is string => Boolean(part))

  return {
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
}
