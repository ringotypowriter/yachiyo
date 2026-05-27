import type { Message } from '@renderer/app/types'

export type MessageFooter = { kind: 'streaming' } | { kind: 'failed' } | { kind: 'stopped' }

export interface MessagePresentation {
  /** Whether the markdown content block should render */
  showContent: boolean
  /** Whether the bubble wrapper itself should render at all */
  showBubble: boolean
  /** Footer descriptor — null means no footer */
  footer: MessageFooter | null
}

export function buildMessagePresentation(message: Message): MessagePresentation {
  const { status, content } = message

  const showContent = Boolean(content)
  const showBubble = showContent || status === 'stopped'

  let footer: MessageFooter | null = null

  if (status === 'streaming') {
    footer = { kind: 'streaming' }
  } else if (status === 'failed') {
    footer = { kind: 'failed' }
  } else if (status === 'stopped') {
    footer = { kind: 'stopped' }
  }

  return { showContent, showBubble, footer }
}
