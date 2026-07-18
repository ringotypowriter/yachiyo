import type { AskUserToolCallDetails, ToolCallRecord } from '@yachiyo/shared/protocol'

export function getAskUserDetails(toolCall: ToolCallRecord): AskUserToolCallDetails | null {
  const details = toolCall.details
  if (details && 'kind' in details && details.kind === 'askUser') {
    return details
  }
  return null
}

/**
 * Branching truncates at the persisted assistant message, so the call must be
 * completed and already bound to one (waiting-for-user rows are not bound yet).
 */
export function canBranchFromAskUserToolCall(toolCall: ToolCallRecord): boolean {
  return (
    toolCall.toolName === 'askUser' &&
    toolCall.status === 'completed' &&
    Boolean(toolCall.assistantMessageId) &&
    Boolean(getAskUserDetails(toolCall)?.question)
  )
}
