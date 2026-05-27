import type { Message, ToolCall } from '../../types.ts'
import type { AppState } from '../useAppStore.ts'
import {
  findPlanAcceptanceTimestamp as findSharedPlanAcceptanceTimestamp,
  findPlanExitTimestamp as findSharedPlanExitTimestamp
} from '@yachiyo/shared/planMode'

const hydratingPlanDocumentThreadIds = new Set<string>()

export function findPlanExitTimestamp(input: {
  messages: readonly Message[]
  toolCalls: readonly ToolCall[]
}): string | null {
  return findSharedPlanExitTimestamp(input)
}

export function derivePlanDocumentDecision(input: {
  messages: readonly Message[]
  planExitTimestamp: string
}): 'pending' | 'accepted' {
  return findSharedPlanAcceptanceTimestamp(input) ? 'accepted' : 'pending'
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
  const planExitTimestamp = findPlanExitTimestamp({ messages, toolCalls })
  if (!planExitTimestamp) return
  const decision = derivePlanDocumentDecision({ messages, planExitTimestamp })

  hydratingPlanDocumentThreadIds.add(input.threadId)
  void window.api.yachiyo
    .readThreadPlanDocument({ threadId: input.threadId })
    .then((plan) => {
      const resolvedDecision = plan.decision === 'accepted' ? 'accepted' : decision
      input.set((state) => {
        const existing = state.planDocumentsByThread[input.threadId]
        if (
          existing &&
          existing.updatedAt === planExitTimestamp &&
          (existing.decision === 'accepted' || existing.decision === resolvedDecision)
        ) {
          return {}
        }
        return {
          planDocumentsByThread: {
            ...state.planDocumentsByThread,
            [input.threadId]: {
              ...plan,
              updatedAt: planExitTimestamp,
              decision: resolvedDecision
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
