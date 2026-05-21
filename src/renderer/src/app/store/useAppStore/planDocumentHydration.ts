import type { Message, ToolCall } from '../../types.ts'
import type { AppState } from '../useAppStore.ts'
import {
  isPlanModeExitRecord,
  PLAN_MODE_EXIT_TOOL_NAME
} from '../../../../../shared/yachiyo/planMode.ts'

const hydratingPlanDocumentThreadIds = new Set<string>()

function findPlanExitTimestamp(input: {
  messages: readonly Message[]
  toolCalls: readonly ToolCall[]
}): string | null {
  for (let i = input.toolCalls.length - 1; i >= 0; i -= 1) {
    const toolCall = input.toolCalls[i]
    if (toolCall?.toolName === PLAN_MODE_EXIT_TOOL_NAME && toolCall.status === 'completed') {
      return toolCall.finishedAt ?? toolCall.startedAt
    }
  }

  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i]
    if (message?.role === 'assistant' && isPlanModeExitRecord(message)) {
      return message.createdAt
    }
  }

  return null
}

export function hydratePlanDocumentForThread(input: {
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
  get: () => AppState
  threadId: string
  messages?: readonly Message[]
  toolCalls?: readonly ToolCall[]
}): void {
  if (input.get().planDocumentsByThread[input.threadId]) return
  if (hydratingPlanDocumentThreadIds.has(input.threadId)) return
  if (typeof window === 'undefined' || !window.api?.yachiyo?.readThreadPlanDocument) return

  const messages = input.messages ?? input.get().messages[input.threadId] ?? []
  const toolCalls = input.toolCalls ?? input.get().toolCalls[input.threadId] ?? []
  const updatedAt = findPlanExitTimestamp({ messages, toolCalls })
  if (!updatedAt) return

  hydratingPlanDocumentThreadIds.add(input.threadId)
  void window.api.yachiyo
    .readThreadPlanDocument({ threadId: input.threadId })
    .then((plan) => {
      input.set((state) => {
        if (state.planDocumentsByThread[input.threadId]) return {}
        return {
          planDocumentsByThread: {
            ...state.planDocumentsByThread,
            [input.threadId]: {
              ...plan,
              updatedAt,
              decision: 'pending' as const
            }
          }
        }
      })
    })
    .catch(() => {
      // Ignore missing plan files or read errors.
    })
    .finally(() => {
      hydratingPlanDocumentThreadIds.delete(input.threadId)
    })
}
