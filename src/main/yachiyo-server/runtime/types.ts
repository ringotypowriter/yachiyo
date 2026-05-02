import type {
  GenerateTextOnToolCallFinishCallback,
  GenerateTextOnToolCallStartCallback,
  ModelMessage as AiSdkModelMessage,
  StopCondition,
  ToolChoice,
  ToolSet
} from 'ai'

import type { ComposerReasoningSelection, ProviderSettings } from '../../../shared/yachiyo/protocol'

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
  reasoningEffort?: ComposerReasoningSelection
  maxToolSteps?: number
  tools?: ToolSet
  toolChoice?: ToolChoice<ToolSet>
  onToolCallPreparing?: (event: { toolCallId: string; toolName: string }) => void
  onToolCallStart?: GenerateTextOnToolCallStartCallback<ToolSet>
  onToolCallFinish?: GenerateTextOnToolCallFinishCallback<ToolSet>
  onToolCallUpdate?: (event: ModelToolCallUpdateEvent) => void
  onToolCallError?: (event: ModelToolCallErrorEvent) => 'abort' | 'continue'
  /** Custom stop condition(s) for the multi-step tool loop. Overrides the default `stepCountIs(maxToolSteps)`. */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>
  /** Opaque key for provider-side prompt prefix caching (e.g. OpenAI Responses API). */
  promptCacheKey?: string
  onReasoningDelta?: (delta: string) => void
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: unknown) => void
  onStepUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
  onFinish?: (usage: ModelUsage) => void
}

export interface ModelRuntime {
  streamReply(request: ModelStreamRequest): AsyncIterable<string>
}
