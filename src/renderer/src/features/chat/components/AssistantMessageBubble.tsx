import React, { memo, useMemo } from 'react'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import { buildAssetUrl } from '@renderer/lib/markdown/imageUrl'
import type { MarkdownImageContextValue } from '@renderer/lib/markdown/MarkdownImage'
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
  /** Show the streaming caret. When omitted, defaults to isStreaming state. */
  showCaret?: boolean
}

export const AssistantMessageBubble = memo(function AssistantMessageBubble({
  message,
  contentOverride,
  showFooter = true,
  suppressGeneratingLabel = false,
  pauseStreaming = false,
  compactBottomSpacing = false,
  showCaret
}: AssistantMessageBubbleProps): React.JSX.Element {
  const { showContent, showBubble, footer } = buildMessagePresentation(message)
  const isStreaming = message.status === 'streaming' && !pauseStreaming
  const hasCaret = showCaret ?? isStreaming
  const shouldShowGeneratingLabel =
    message.status === 'streaming' && showFooter && !suppressGeneratingLabel
  const effectiveShowFooter =
    suppressGeneratingLabel && message.status === 'streaming' ? false : showFooter
  const hasFooterContent =
    effectiveShowFooter &&
    footer !== null &&
    (footer.kind !== 'streaming' || shouldShowGeneratingLabel)
  const content = contentOverride ?? message.content

  const imageContext = useMemo<MarkdownImageContextValue>(
    () => ({
      threadId: message.threadId,
      messageId: message.id,
      async downloadRemoteImage(remoteUrl: string) {
        const api = window.api?.yachiyo
        if (!api?.downloadRemoteImageForMessage) {
          throw new Error('Download API unavailable')
        }
        const result = await api.downloadRemoteImageForMessage({
          threadId: message.threadId,
          messageId: message.id,
          url: remoteUrl
        })
        const assetUrl = buildAssetUrl(result.absPath)
        if (!assetUrl) throw new Error('Failed to build asset URL')
        return assetUrl
      }
    }),
    [message.id, message.threadId]
  )

  if (!showBubble) return <></>

  return (
    <div
      className={`flex flex-col gap-2 px-6 py-1 message-bubble-group${hasCaret ? ' sd-caret-host' : ''}${compactBottomSpacing ? ' message-bubble-group--compact-after' : ''}`}
    >
      <div className="w-full message-card-shell">
        <div className="assistant-message-bubble">
          {showContent && (
            <MessageMarkdown
              content={content}
              isStreaming={isStreaming}
              imageContext={imageContext}
            />
          )}
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
})
