import type {
  ChatAccepted,
  ComposerReasoningSelection,
  MessageRecord,
  SendChatInput,
  RunModeId,
  SendChatMode,
  SendChatRunTrigger,
  ToolCallName
} from '../../../../../../shared/yachiyo/protocol.ts'

export const SEND_CHAT_DEBOUNCE_WINDOW_MS = 1_500

export interface DebouncedSendChatEntry {
  expiresAt: number
  promise: Promise<ChatAccepted>
  stateSignature?: string
}

export function createDebouncedSendChatKey(input: {
  attachments?: SendChatInput['attachments']
  channelHint?: string
  content: string
  enabledSkillNames?: string[]
  enabledTools: ToolCallName[]
  runMode: RunModeId
  extraTools?: SendChatInput['extraTools']
  hidden?: boolean
  images: MessageRecord['images']
  mode: SendChatMode
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  threadId: string
}): string | null {
  if (input.extraTools) {
    return null
  }

  return JSON.stringify({
    attachments:
      input.attachments?.map((attachment) => ({
        dataUrl: attachment.dataUrl,
        filename: attachment.filename,
        mediaType: attachment.mediaType
      })) ?? [],
    channelHint: input.channelHint ?? null,
    content: input.content,
    enabledSkillNames: input.enabledSkillNames ?? [],
    enabledTools: input.enabledTools,
    runMode: input.runMode,
    hidden: input.hidden === true,
    images: (input.images ?? []).map((image) => ({
      dataUrl: image.dataUrl,
      filename: image.filename ?? null,
      mediaType: image.mediaType
    })),
    mode: input.mode,
    reasoningEffort: input.reasoningEffort ?? null,
    runTrigger: input.runTrigger,
    threadId: input.threadId
  })
}
