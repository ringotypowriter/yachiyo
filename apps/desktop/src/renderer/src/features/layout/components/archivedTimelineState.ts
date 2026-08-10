import type { Message, ToolCall } from '@renderer/app/types'

export function resolveArchivedTimelineState(input: {
  loadedMessages: Message[]
  loadedToolCalls: ToolCall[]
  refreshedMessages?: Message[]
  refreshedToolCalls?: ToolCall[]
}): { messages: Message[]; toolCalls: ToolCall[] } {
  return {
    messages: input.refreshedMessages ?? input.loadedMessages,
    toolCalls: input.refreshedToolCalls ?? input.loadedToolCalls
  }
}
