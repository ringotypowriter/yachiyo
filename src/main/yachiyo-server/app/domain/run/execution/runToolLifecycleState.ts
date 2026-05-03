import type { ToolCallRecord } from '../../../../../../shared/yachiyo/protocol.ts'

const TOOL_FAIL_LOOP_WINDOW = 10
const TOOL_FAIL_LOOP_THRESHOLD = 3
const MAX_TOOL_FAIL_STEERS = 2

interface ToolFailureLoopInput {
  errorMessage: string
  toolCallId: string
  toolInput: unknown
  toolName: string
}

interface PreparingToolCallMatch {
  existing?: ToolCallRecord
  orphanedPreparingKey?: string
}

export interface RunToolLifecycleState {
  toolCalls: Map<string, ToolCallRecord>
  advanceStep: () => number
  clearRunningToolCalls: () => void
  deleteToolCall: (toolCallId: string) => void
  findPreparingToolCall: (input: { toolCallId: string; toolName: string }) => PreparingToolCallMatch
  finishRunningToolCall: (toolCallId: string) => boolean
  getAllToolCalls: () => ToolCallRecord[]
  getStepCount: () => number
  getToolCall: (toolCallId: string) => ToolCallRecord | undefined
  getToolFailLoopSteersInjected: () => number
  hasRunningToolCalls: () => boolean
  hasToolCalls: () => boolean
  markRunningToolCall: (toolCallId: string) => void
  nextPreparingStepIndex: () => number
  recordToolFailureLoop: (input: ToolFailureLoopInput) => string | undefined
  resetToolFailureLoop: () => void
  setToolCall: (toolCall: ToolCallRecord) => void
}

export function createRunToolLifecycleState(input: {
  initialToolCalls: Map<string, ToolCallRecord>
  priorToolFailLoopSteers?: number
}): RunToolLifecycleState {
  const toolCalls = input.initialToolCalls
  const runningToolCallIds = new Set<string>()
  let stepCount = Math.max(0, ...[...toolCalls.values()].map((toolCall) => toolCall.stepIndex ?? 0))
  const recentToolErrorKeys: string[] = []
  const seenFailedToolCallIds = new Set<string>()
  let toolFailLoopSteersInjected = input.priorToolFailLoopSteers ?? 0
  let lastLoopActionKey: string | undefined

  const advanceStep = (): number => {
    stepCount++
    return stepCount
  }

  const recordToolFailureLoop = (failure: ToolFailureLoopInput): string | undefined => {
    if (seenFailedToolCallIds.has(failure.toolCallId)) {
      return undefined
    }

    seenFailedToolCallIds.add(failure.toolCallId)
    const inputJson = JSON.stringify(failure.toolInput)
    const key = `${failure.toolName}:${failure.errorMessage}:${inputJson}`
    recentToolErrorKeys.push(key)
    if (recentToolErrorKeys.length > TOOL_FAIL_LOOP_WINDOW) {
      recentToolErrorKeys.shift()
    }
    const count = recentToolErrorKeys.filter((k) => k === key).length
    if (count < TOOL_FAIL_LOOP_THRESHOLD || key === lastLoopActionKey) {
      return undefined
    }

    lastLoopActionKey = key
    if (toolFailLoopSteersInjected >= MAX_TOOL_FAIL_STEERS) {
      throw new Error(
        `Tool fail loop melt-out: the model repeatedly called '${failure.toolName}' ` +
          `with the same invalid input after ${MAX_TOOL_FAIL_STEERS} steering attempts. Stopping the run.`
      )
    }
    toolFailLoopSteersInjected++
    return (
      `You appear to be stuck in a loop sending the same invalid '${failure.toolName}' tool input ` +
      `(${count} consecutive failures). Please stop and reconsider your approach. ` +
      `Analyze the validation error, fix your input, or try a different tool.`
    )
  }

  const resetToolFailureLoop = (): void => {
    recentToolErrorKeys.length = 0
    seenFailedToolCallIds.clear()
    lastLoopActionKey = undefined
  }

  return {
    toolCalls,
    advanceStep,
    clearRunningToolCalls: () => {
      runningToolCallIds.clear()
    },
    deleteToolCall: (toolCallId) => {
      toolCalls.delete(toolCallId)
    },
    findPreparingToolCall: ({ toolCallId, toolName }) => {
      const existing = toolCalls.get(toolCallId)
      if (existing) {
        return { existing }
      }

      for (const [key, record] of toolCalls) {
        if (record.status === 'preparing' && record.toolName === toolName && key !== toolCallId) {
          return {
            existing: record,
            orphanedPreparingKey: key
          }
        }
      }
      return {}
    },
    finishRunningToolCall: (toolCallId) => {
      runningToolCallIds.delete(toolCallId)
      return runningToolCallIds.size === 0
    },
    getAllToolCalls: () => [...toolCalls.values()],
    getStepCount: () => stepCount,
    getToolCall: (toolCallId) => toolCalls.get(toolCallId),
    getToolFailLoopSteersInjected: () => toolFailLoopSteersInjected,
    hasRunningToolCalls: () => runningToolCallIds.size > 0,
    hasToolCalls: () => toolCalls.size > 0,
    markRunningToolCall: (toolCallId) => {
      runningToolCallIds.add(toolCallId)
    },
    nextPreparingStepIndex: () => stepCount + 1,
    recordToolFailureLoop,
    resetToolFailureLoop,
    setToolCall: (toolCall) => {
      toolCalls.set(toolCall.id, toolCall)
    }
  }
}
