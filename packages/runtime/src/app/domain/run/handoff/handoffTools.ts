import type { ToolSet } from 'ai'
import type { MessageRecord } from '@yachiyo/shared/protocol'

const HANDOFF_TOOL_EXECUTION_DISABLED_MESSAGE =
  'Tool execution is disabled during handoff creation. Continue writing the handoff from the existing conversation context without tools.'

export const HANDOFF_MAX_REFUSED_TOOL_STEPS = 2

export function disableHandoffToolExecution(tools: ToolSet | undefined): ToolSet | undefined {
  if (!tools) {
    return undefined
  }

  const disabledTools: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    disabledTools[name] = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      execute: async () => {
        throw new Error(HANDOFF_TOOL_EXECUTION_DISABLED_MESSAGE)
      }
    })
  }

  return disabledTools
}

export function findLatestUserTurnContext(messages: MessageRecord[]): MessageRecord['turnContext'] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && message.turnContext) {
      return message.turnContext
    }
  }
  return undefined
}
