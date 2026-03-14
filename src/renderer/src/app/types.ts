export interface Thread {
  id: string
  title: string
  updatedAt: Date
  preview?: string
}

export interface ToolCall {
  id: string
  tool: string
  status: 'running' | 'completed' | 'failed'
  durationSec?: number
}

export interface Message {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  status: 'completed' | 'streaming' | 'failed'
  toolCalls?: ToolCall[]
}

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed'
