import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { Message } from '@renderer/app/types'

interface AssistantMessageBubbleProps {
  message: Message
}

export function AssistantMessageBubble({ message }: AssistantMessageBubbleProps) {
  const isStreaming = message.status === 'streaming'

  return (
    <div className="flex flex-col gap-2 px-6 py-1">
      {(message.content || isStreaming) && (
        <div className="max-w-[72%]">
          <MessageMarkdown content={message.content} isStreaming={isStreaming} />
        </div>
      )}
    </div>
  )
}
