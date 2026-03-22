import type React from 'react'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { Message } from '@renderer/app/types'
import { buildMessagePresentation } from '../lib/messagePresentation'
import type { MessageFooter } from '../lib/messagePresentation'
import { canRetryAssistantMessage } from '../lib/messageActionState'
import { MessageActionBar } from './MessageActionBar'
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
  threadHasActiveRun?: boolean
  onRetry?: () => Promise<void> | void
  onCreateBranch: () => Promise<void> | void
  onDelete: () => Promise<void> | void
}

export function AssistantMessageBubble({
  message,
  threadHasActiveRun = false,
  onRetry,
  onCreateBranch,
  onDelete
}: AssistantMessageBubbleProps): React.JSX.Element {
  const { showContent, showBubble, footer } = buildMessagePresentation(message)
  const isStreaming = message.status === 'streaming'
  const canRetry = canRetryAssistantMessage({
    messageStatus: message.status,
    threadHasActiveRun
  })

  if (!showBubble) return <></>

  return (
    <div
      className={`flex flex-col gap-2 px-6 py-1 message-bubble-group${isStreaming ? ' sd-caret-host' : ''}`}
    >
      <div className="max-w-[72%] message-card-shell">
        <div className="assistant-message-bubble">
          {showContent && <MessageMarkdown content={message.content} isStreaming={isStreaming} />}
        </div>
        <div className="assistant-message-bubble__footer-row">
          <div>{footer && <MessageMetaRow footer={footer} />}</div>
          <MessageActionBar
            align="start"
            content={message.content}
            canRetry={canRetry}
            onRetry={isStreaming ? undefined : onRetry}
            onCreateBranch={onCreateBranch}
            onDelete={onDelete}
          />
        </div>
      </div>
    </div>
  )
}
