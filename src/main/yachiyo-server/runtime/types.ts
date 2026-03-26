import type {
  GenerateTextOnToolCallFinishCallback,
  GenerateTextOnToolCallStartCallback,
  ModelMessage as AiSdkModelMessage,
  ToolSet
} from 'ai'

import type { ProviderSettings } from '../../../shared/yachiyo/protocol'

export type ModelMessage = AiSdkModelMessage

export interface ModelToolCallUpdateEvent {
  toolCall: {
    input: unknown
    toolCallId: string
    toolName: string
  }
  output: unknown
}

export type ModelProviderOptionsMode = 'default' | 'auxiliary'

export interface ModelUsage {
  promptTokens: number
  completionTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  /** Structured response messages from the AI SDK (assistant + tool messages), for lossless history replay. */
  responseMessages?: unknown[]
}

export interface ModelStreamRequest {
  messages: ModelMessage[]
  settings: ProviderSettings
  signal: AbortSignal
  providerOptionsMode?: ModelProviderOptionsMode
  tools?: ToolSet
  onToolCallStart?: GenerateTextOnToolCallStartCallback<ToolSet>
  onToolCallFinish?: GenerateTextOnToolCallFinishCallback<ToolSet>
  onToolCallUpdate?: (event: ModelToolCallUpdateEvent) => void
  onReasoningDelta?: (delta: string) => void
  onFinish?: (usage: ModelUsage) => void
}

export interface ModelRuntime {
  streamReply(request: ModelStreamRequest): AsyncIterable<string>
}
