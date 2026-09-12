import type { AvatarPhase } from '../../../components/avatar/avatarTypes.ts'
import type { AppState } from '../../../app/store/useAppStore.ts'

interface RunAvatarInput {
  active: boolean
  receiving: boolean
  hasText: boolean
  hasReasoning: boolean
  working: boolean
  waiting: boolean
  textPending?: boolean
}

export function resolveRunAvatarPhase(input: RunAvatarInput): AvatarPhase {
  if (!input.active) return 'idle'
  if (input.waiting) return 'waiting'
  if (input.working) return 'working'
  if (!input.receiving) return 'loading'
  if (input.hasText && !input.textPending) return 'speaking'
  if (input.hasReasoning) return 'thinking'
  return 'loading'
}

export function selectRunAvatarPhase(state: AppState, threadId: string | null): AvatarPhase {
  if (!threadId) return 'idle'
  const runId = state.activeRunIdsByThread[threadId]
  const pending = runId ? state.pendingAssistantMessages[runId] : undefined
  const requestId = state.activeRequestMessageIdsByThread[threadId]
  const message = pending
    ? state.messages[threadId]?.find((item) => item.id === pending.messageId)
    : requestId
      ? state.messages[threadId]?.findLast(
          (item) => item.role === 'assistant' && item.parentMessageId === requestId
        )
      : undefined
  const tools = (state.toolCalls[threadId] ?? []).filter((tool) => tool.runId === runId)
  return resolveRunAvatarPhase({
    active: Boolean(runId) || (state.runPhasesByThread[threadId] ?? 'idle') !== 'idle',
    receiving:
      state.receivingModelOutputByThread[threadId] === true && !state.retryInfoByThread[threadId],
    hasText: Boolean(message?.content.trim()),
    hasReasoning: Boolean(message?.reasoning),
    textPending: pending?.shouldStartNewTextBlock,
    working: tools.some((tool) => tool.status === 'preparing' || tool.status === 'running'),
    waiting: tools.some((tool) => tool.status === 'waiting-for-user')
  })
}

export function shouldCelebrateRun(
  previous: { threadId: string | null; runId: string | null },
  current: {
    threadId: string | null
    runId: string | null
    completedRunId?: string
    status: string
  }
): boolean {
  return (
    previous.threadId === current.threadId &&
    previous.runId !== null &&
    current.runId === null &&
    current.completedRunId === previous.runId &&
    current.status === 'completed'
  )
}
