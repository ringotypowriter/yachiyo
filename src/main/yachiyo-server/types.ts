import type { ModelMessage as AiSdkModelMessage } from 'ai'

import type { ProviderSettings } from '../../shared/yachiyo/protocol'

export type ModelMessage = AiSdkModelMessage

export interface ModelStreamRequest {
  messages: ModelMessage[]
  settings: ProviderSettings
  signal: AbortSignal
}

export interface ModelRuntime {
  streamReply(request: ModelStreamRequest): AsyncIterable<string>
}
