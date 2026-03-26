import type React from 'react'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { Message } from '@renderer/app/types'
import { buildMessagePresentation } from '../lib/messagePresentation'
import type { MessageFooter } from '../lib/messagePresentation'
import { theme } from '@renderer/theme/theme'

function MessageMetaRow({ footer }: { footer: MessageFooter }): React.JSX.Element | null {
  if (footer.kind === 'streaming') {
    return (
      <div className="flex items-center gap-1.5 mt-1 message-footer">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: theme.text.accent,
            display: 'inline-block',
            animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
          }}
        />
        <span>Generating...</span>
      </div>
    )
  }

  if (footer.kind === 'failed') {
    return (
      <div
        className="mt-1 message-footer message-footer--always-visible"
        style={{ color: theme.text.danger }}
      >
        Failed to generate
      </div>
    )
  }

  if (footer.kind === 'stopped') {
    return <div className="mt-1 message-footer message-footer--always-visible">Stopped</div>
  }

  return null
}

interface AssistantMessageBubbleProps {
  message: Message
  contentOverride?: string
  showFooter?: boolean
  suppressGeneratingLabel?: boolean
  pauseStreaming?: boolean
  compactBottomSpacing?: boolean
}

export function AssistantMessageBubble({
  message,
  contentOverride,
  showFooter = true,
  suppressGeneratingLabel = false,
  pauseStreaming = false,
  compactBottomSpacing = false
}: AssistantMessageBubbleProps): React.JSX.Element {
  const { showContent, showBubble, footer } = buildMessagePresentation(message)
  const isStreaming = message.status === 'streaming' && showFooter && !pauseStreaming
  const shouldShowGeneratingLabel =
    message.status === 'streaming' && showFooter && !suppressGeneratingLabel
  const effectiveShowFooter =
    suppressGeneratingLabel && message.status === 'streaming' ? false : showFooter
  const hasFooterContent =
    effectiveShowFooter &&
    footer !== null &&
    (footer.kind !== 'streaming' || shouldShowGeneratingLabel)
  const content = contentOverride ?? message.content

  if (!showBubble) return <></>

  return (
    <div
      className={`flex flex-col gap-2 px-6 py-1 message-bubble-group${isStreaming ? ' sd-caret-host' : ''}${compactBottomSpacing ? ' message-bubble-group--compact-after' : ''}`}
    >
      <div className="w-full message-card-shell">
        <div className="assistant-message-bubble">
          {showContent && <MessageMarkdown content={content} isStreaming={isStreaming} />}
        </div>
        {hasFooterContent ? (
          <div className="assistant-message-bubble__footer-row">
            <div>
              <MessageMetaRow footer={footer!} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
