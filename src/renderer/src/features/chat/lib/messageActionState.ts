import type { Message } from '@renderer/app/types'

export function canRetryAssistantMessage(input: {
  messageStatus: Message['status']
  threadHasActiveRun: boolean
}): boolean {
  return input.messageStatus !== 'streaming' && !input.threadHasActiveRun
}

export function canRetryUserMessage(input: { threadHasActiveRun: boolean }): boolean {
  return !input.threadHasActiveRun
}

export function resolveRetryTargetMessageId(input: {
  userMessageId: string
  activeAssistantMessage?: Pick<Message, 'id' | 'status'>
}): string {
  if (!input.activeAssistantMessage || input.activeAssistantMessage.status === 'stopped') {
    return input.userMessageId
  }

  return input.activeAssistantMessage.id
}
