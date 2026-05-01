import type { ActiveRunEnterBehavior } from '../../../../../shared/yachiyo/protocol.ts'

const IME_PROCESSING_KEY_CODE = 229

export type ComposerEnterEvent = {
  key: string
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
}

export type ComposerEnterAction = 'send' | 'steer' | 'follow-up'

export function resolveComposerEnterAction(input: {
  activeRunEnterBehavior: ActiveRunEnterBehavior
  event: ComposerEnterEvent
  hasActiveRun: boolean
}): ComposerEnterAction | null {
  const { event } = input

  if (event.key !== 'Enter' || event.shiftKey) {
    return null
  }

  if (event.isComposing) {
    return null
  }

  if (event.keyCode === IME_PROCESSING_KEY_CODE) {
    return null
  }

  if (!input.hasActiveRun) {
    return event.altKey ? null : 'send'
  }

  if (input.activeRunEnterBehavior === 'enter-steers') {
    return event.altKey ? 'follow-up' : 'steer'
  }

  return event.altKey ? 'steer' : 'follow-up'
}

export function shouldSelectCompletionCandidate(event: ComposerEnterEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) {
    return false
  }

  if (event.isComposing) {
    return false
  }

  return event.keyCode !== IME_PROCESSING_KEY_CODE
}
