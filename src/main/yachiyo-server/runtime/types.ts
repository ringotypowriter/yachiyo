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

export interface ModelToolCallErrorEvent {
  toolCall: {
    input: unknown
    toolCallId: string
    toolName: string
  }
  error: unknown
}

export type ModelProviderOptionsMode = 'default' | 'auxiliary'

export interface ModelUsage {
  promptTokens: number
  completionTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** AI SDK finish reason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown'. */
  finishReason?: string
  /** Structured response messages from the AI SDK (assistant + tool messages), for lossless history replay. */
  responseMessages?: unknown[]
}

export interface ModelStreamRequest {
  messages: ModelMessage[]
  settings: ProviderSettings
  signal: AbortSignal
  /** Short label used in lifecycle logs to identify why this LLM call was made (e.g. "chat", "title", "summary"). */
  purpose?: string
  max_token?: number
  providerOptionsMode?: ModelProviderOptionsMode
  maxToolSteps?: number
  tools?: ToolSet
  onToolCallStart?: GenerateTextOnToolCallStartCallback<ToolSet>
  onToolCallFinish?: GenerateTextOnToolCallFinishCallback<ToolSet>
  onToolCallUpdate?: (event: ModelToolCallUpdateEvent) => void
  onToolCallError?: (event: ModelToolCallErrorEvent) => 'abort' | 'continue'
  onReasoningDelta?: (delta: string) => void
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: unknown) => void
  onFinish?: (usage: ModelUsage) => void
}

export interface ModelRuntime {
  streamReply(request: ModelStreamRequest): AsyncIterable<string>
}
