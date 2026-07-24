import type { MessageTimelineSurface } from '@renderer/features/chat/components/TimelineSurfaceHeader'

export type WelcomeVariant = 'generic' | 'essential' | null

export interface WelcomeStateInput {
  activeSurface: MessageTimelineSurface
  activeThreadId: string | null
  activeThreadMessagesLoaded: boolean
  messageCount: number
  isEditingMessage: boolean
  activeEssentialId: string | null
  activeThreadCreatedFromEssentialId?: string | null
  hasActiveEssential: boolean
}

export interface WelcomeState {
  variant: WelcomeVariant
  essentialSourceId: string | null
}

export function resolveWelcomeState(input: WelcomeStateInput): WelcomeState {
  const essentialSourceId =
    input.activeEssentialId ?? input.activeThreadCreatedFromEssentialId ?? null
  if (input.activeSurface !== 'timeline' || input.messageCount !== 0 || input.isEditingMessage) {
    return { variant: null, essentialSourceId }
  }

  if (input.activeThreadId !== null && !input.activeThreadMessagesLoaded) {
    return { variant: null, essentialSourceId }
  }

  if (input.hasActiveEssential) {
    return { variant: 'essential', essentialSourceId }
  }

  if (essentialSourceId === null) {
    return { variant: 'generic', essentialSourceId: null }
  }

  return { variant: null, essentialSourceId }
}
