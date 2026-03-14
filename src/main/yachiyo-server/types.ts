import type { ProviderSettings } from '../../shared/yachiyo/protocol'

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelStreamRequest {
  messages: ModelMessage[]
  settings: ProviderSettings
  signal: AbortSignal
}

export interface ModelRuntime {
  streamReply(request: ModelStreamRequest): AsyncIterable<string>
}
