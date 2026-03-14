import type { Message } from '@renderer/app/types'

interface UserMessageBubbleProps {
  message: Message
}

export function UserMessageBubble({ message }: UserMessageBubbleProps) {
  return (
    <div className="flex justify-end px-6 py-1">
      <div
        className="max-w-[68%] rounded-[18px] px-4 py-2.5 message-selectable"
        style={{ background: '#4a7876', color: '#fff' }}
      >
        <p className="text-sm leading-relaxed whitespace-pre-wrap m-0">{message.content}</p>
      </div>
    </div>
  )
}
