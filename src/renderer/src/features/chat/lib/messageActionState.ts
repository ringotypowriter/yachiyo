import type { Message } from '@renderer/app/types'

export function canRetryAssistantMessage(input: {
  messageStatus: Message['status']
  threadHasActiveRun: boolean
}): boolean {
  return input.messageStatus !== 'streaming' && !input.threadHasActiveRun
}
