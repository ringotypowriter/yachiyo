import type { SendChatRunTrigger } from '../../../../../shared/yachiyo/protocol.ts'

export interface RunEventMetadataInput {
  threadId: string
  runId: string
  runTrigger: SendChatRunTrigger
  requestMessageId?: string
}

export interface RunEventMetadata {
  threadId: string
  runId: string
  runTrigger: SendChatRunTrigger
  requestMessageId?: string
}

export function createRunEventMetadata(input: RunEventMetadataInput): RunEventMetadata {
  return {
    threadId: input.threadId,
    runId: input.runId,
    runTrigger: input.runTrigger,
    ...(input.requestMessageId !== undefined ? { requestMessageId: input.requestMessageId } : {})
  }
}
