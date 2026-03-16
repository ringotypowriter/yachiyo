import type React from 'react'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { Message } from '@renderer/app/types'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { buildMessagePresentation } from '../lib/messagePresentation'
import type { MessageFooter } from '../lib/messagePresentation'
import { canRetryAssistantMessage } from '../lib/messageActionState'
import { MessageActionBar } from './MessageActionBar'

function MessageMetaRow({ footer }: { footer: MessageFooter }): React.JSX.Element | null {
  if (footer.kind === 'streaming') {
    return (
      <div className="flex items-center gap-1.5 mt-1 message-footer">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: '#CC7D5E',
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
        style={{ color: '#b53a2f' }}
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
  replyCount?: number
  canSelectPreviousReply?: boolean
  canSelectNextReply?: boolean
  threadHasActiveRun?: boolean
  onRetry?: () => Promise<void> | void
  onSelectPreviousReply?: () => Promise<void> | void
  onSelectNextReply?: () => Promise<void> | void
  onCreateBranch: () => Promise<void> | void
  onDelete: () => Promise<void> | void
}

export function AssistantMessageBubble({
  message,
  replyCount,
  canSelectPreviousReply = false,
  canSelectNextReply = false,
  threadHasActiveRun = false,
  onRetry,
  onSelectPreviousReply,
  onSelectNextReply,
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
        {replyCount && replyCount > 1 ? (
          <div className="assistant-message-bubble__branch-nav">
            <span>{replyCount} replies</span>
            <div className="assistant-message-bubble__branch-nav-actions">
              <button
                type="button"
                className="assistant-message-bubble__branch-nav-button"
                onClick={() => void onSelectPreviousReply?.()}
                aria-label="Show previous reply branch"
                disabled={!canSelectPreviousReply}
              >
                <ChevronLeft size={13} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="assistant-message-bubble__branch-nav-button"
                onClick={() => void onSelectNextReply?.()}
                aria-label="Show next reply branch"
                disabled={!canSelectNextReply}
              >
                <ChevronRight size={13} strokeWidth={1.7} />
              </button>
            </div>
          </div>
        ) : null}
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
