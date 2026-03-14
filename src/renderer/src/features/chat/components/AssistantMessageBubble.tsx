import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import { ToolCallCard } from '@renderer/features/runs/components/ToolCallCard'
import type { Message } from '@renderer/app/types'

interface AssistantMessageBubbleProps {
  message: Message
}

export function AssistantMessageBubble({ message }: AssistantMessageBubbleProps) {
  const isStreaming = message.status === 'streaming'

  return (
    <div className="flex flex-col gap-2 px-6 py-1">
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1.5 max-w-[72%]">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {(message.content || isStreaming) && (
        <div className="max-w-[72%]">
          <MessageMarkdown content={message.content} isStreaming={isStreaming} />
        </div>
      )}
    </div>
  )
}
