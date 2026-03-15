import type React from 'react'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { Message } from '@renderer/app/types'
import { buildMessagePresentation } from '../lib/messagePresentation'
import type { MessageFooter } from '../lib/messagePresentation'

function ModelChip({ provider, model }: { provider: string; model: string }): React.JSX.Element {
  return (
    <div
      className="inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded"
      style={{
        fontSize: '10px',
        background: 'rgba(0,0,0,0.05)',
        color: '#a8a5a0'
      }}
    >
      {provider && (
        <>
          <span>{provider}</span>
          <span style={{ color: '#c8c5c0' }}>·</span>
        </>
      )}
      <span>{model}</span>
    </div>
  )
}

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

  if (footer.kind === 'model-chip') {
    return (
      <div className="mt-1 message-footer">
        <ModelChip provider={footer.provider} model={footer.model} />
      </div>
    )
  }

  return null
}

interface AssistantMessageBubbleProps {
  message: Message
}

export function AssistantMessageBubble({
  message
}: AssistantMessageBubbleProps): React.JSX.Element {
  const { showContent, showBubble, footer } = buildMessagePresentation(message)
  const isStreaming = message.status === 'streaming'

  if (!showBubble) return <></>

  return (
    <div
      className={`flex flex-col gap-2 px-6 py-1 message-bubble-group${isStreaming ? ' sd-caret-host' : ''}`}
    >
      <div className="max-w-[72%]">
        {showContent && <MessageMarkdown content={message.content} isStreaming={isStreaming} />}
        {footer && <MessageMetaRow footer={footer} />}
      </div>
    </div>
  )
}
