import type {
  AskUserToolCallDetails,
  ChatAccepted,
  ThreadRecord,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import type { HeadlessConnection } from './headless.ts'

export interface ChatTurnOptions {
  content: string
  threadId?: string
  workspacePath?: string
  signal?: AbortSignal
  onAccepted?(accepted: ChatAccepted): void
  onEvent(event: YachiyoServerEvent): void
  answerQuestion?: (question: AskUserToolCallDetails) => Promise<string>
}

/** Subscribe before sending: a fast model can finish before the send RPC returns. */
export async function runChatTurn(
  connection: HeadlessConnection,
  options: ChatTurnOptions
): Promise<string> {
  const { client } = connection
  options.signal?.throwIfAborted()
  const threadId =
    options.threadId ??
    (
      (await client.call('createThread', [
        { workspacePath: options.workspacePath }
      ])) as ThreadRecord
    ).id
  await client.call('watchThread', [threadId])
  const done = Promise.withResolvers<void>()
  // Attach immediately, including while sendChat itself is still pending.
  void done.promise.catch(() => {})
  let runId: string | undefined
  let buffered: YachiyoServerEvent[] = []
  const asked = new Set<string>()
  const fail = (error: unknown): void => {
    done.reject(error)
  }
  const handle = (event: YachiyoServerEvent): void => {
    if (!('runId' in event) || event.runId !== runId) return
    options.onEvent(event)
    if (event.type === 'run.completed') done.resolve()
    else if (event.type === 'run.failed') fail(new Error(event.error))
    else if (event.type === 'run.cancelled') fail(new Error('Run cancelled'))
    else if (
      event.type === 'tool.updated' &&
      event.toolCall.status === 'waiting-for-user' &&
      event.toolCall.details &&
      'kind' in event.toolCall.details &&
      event.toolCall.details.kind === 'askUser' &&
      !asked.has(event.toolCall.id)
    ) {
      asked.add(event.toolCall.id)
      const answer = options.answerQuestion
      if (!answer) {
        fail(
          new Error(
            'This run needs an answer. Use interactive yachiyo chat to answer tool questions.'
          )
        )
        return
      }
      void answer(event.toolCall.details)
        .then((text) =>
          client.call('answerToolQuestion', [
            {
              threadId,
              runId,
              toolCallId: event.toolCall.id,
              answer: text
            }
          ])
        )
        .catch(fail)
    }
  }
  const unsubscribe = client.subscribe((input) => {
    const event = input as YachiyoServerEvent
    if (!('threadId' in event) || event.threadId !== threadId) return
    if (!runId) buffered.push(event)
    else handle(event)
  })
  const abort = (): void => fail(new Error('Run cancelled'))
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const accepted = (await client.call('sendChat', [
      { threadId, content: options.content }
    ])) as ChatAccepted
    runId = accepted.runId
    options.onAccepted?.(accepted)
    for (const event of buffered) handle(event)
    buffered = []
    if (options.signal?.aborted) abort()
    await Promise.race([
      done.promise,
      connection.closed.then(() => {
        throw new Error('Yachiyo headless disconnected before the run finished')
      })
    ])
    return threadId
  } catch (error) {
    if (runId) {
      try {
        await client.call('cancelRun', [{ runId }])
      } catch (cancelError) {
        // Both failures matter when the daemon disappeared during cancellation.
        throw new AggregateError(
          [error, cancelError],
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    throw error
  } finally {
    unsubscribe()
    options.signal?.removeEventListener('abort', abort)
  }
}
