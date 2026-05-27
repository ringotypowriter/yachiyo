import type {
  MessageRecord,
  ThreadStateReplacedEvent,
  ToolCallRecord
} from '@yachiyo/shared/protocol'
import type {
  createRemoteImageDomain,
  DownloadRemoteImageInput
} from '../domain/images/remoteImageDomain.ts'

export async function downloadRemoteImageAndBuildReplacementEvent(input: {
  download: ReturnType<typeof createRemoteImageDomain>
  emit: (event: Omit<ThreadStateReplacedEvent, 'eventId' | 'timestamp'>) => void
  getMessages: (threadId: string) => MessageRecord[]
  getThread: (threadId: string) => ThreadStateReplacedEvent['thread']
  getToolCalls: (threadId: string) => ToolCallRecord[]
  request: DownloadRemoteImageInput
}): Promise<{ absPath: string; message: MessageRecord }> {
  const result = await input.download.downloadRemoteImageForMessage(input.request)
  input.emit({
    type: 'thread.state.replaced',
    threadId: input.request.threadId,
    thread: input.getThread(input.request.threadId),
    messages: input.getMessages(input.request.threadId),
    toolCalls: input.getToolCalls(input.request.threadId)
  })
  return result
}
