import type { Message, Thread } from '@renderer/app/types'

export function canRetryAssistantMessage(input: {
  messageStatus: Message['status']
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadHasActiveRun: boolean
  threadIsSaving?: boolean
}): boolean {
  return (
    input.threadCapabilities.canRetry &&
    input.messageStatus !== 'streaming' &&
    !input.threadHasActiveRun &&
    !input.threadIsSaving
  )
}

export function canRetryUserMessage(input: {
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadHasActiveRun: boolean
  threadIsSaving?: boolean
}): boolean {
  return input.threadCapabilities.canRetry && !input.threadHasActiveRun && !input.threadIsSaving
}

export function canCreateBranch(input: {
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadHasActiveRun: boolean
  threadIsSaving?: boolean
}): boolean {
  return (
    input.threadCapabilities.canCreateBranch && !input.threadHasActiveRun && !input.threadIsSaving
  )
}

export function canSelectReplyBranch(input: {
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadHasActiveRun: boolean
  threadIsSaving?: boolean
}): boolean {
  return (
    input.threadCapabilities.canSelectReplyBranch &&
    !input.threadHasActiveRun &&
    !input.threadIsSaving
  )
}

export function canEditUserMessage(input: {
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadHasActiveRun: boolean
  threadIsSaving?: boolean
}): boolean {
  return input.threadCapabilities.canEdit && !input.threadHasActiveRun && !input.threadIsSaving
}

export function canDeleteMessage(input: {
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadHasActiveRun: boolean
  threadIsSaving?: boolean
}): boolean {
  return input.threadCapabilities.canDelete && !input.threadHasActiveRun && !input.threadIsSaving
}

export function canRemoveQueuedFollowUp(input: {
  threadCapabilities: NonNullable<Thread['capabilities']>
}): boolean {
  return input.threadCapabilities.canDelete
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
