import type {
  GenerateTextOnToolCallFinishCallback,
  GenerateTextOnToolCallStartCallback,
  ModelMessage as AiSdkModelMessage,
  ToolSet
} from 'ai'

import type { ProviderSettings } from '../../shared/yachiyo/protocol'

export type ModelMessage = AiSdkModelMessage

export interface ModelStreamRequest {
  messages: ModelMessage[]
  settings: ProviderSettings
  signal: AbortSignal
  tools?: ToolSet
  onToolCallStart?: GenerateTextOnToolCallStartCallback<ToolSet>
  onToolCallFinish?: GenerateTextOnToolCallFinishCallback<ToolSet>
}

export interface ModelRuntime {
  streamReply(request: ModelStreamRequest): AsyncIterable<string>
}
