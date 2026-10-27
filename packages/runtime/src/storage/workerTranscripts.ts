export interface WorkerTranscriptEntry {
  message: unknown
  timestamp: string
  isMeta: boolean
}

export interface WorkerTranscriptCompaction {
  summary: string
  promptTokens: number
  completionTokens: number
}

/** Durable per-turn evidence, independent of the worker's compacted prompt history. */
export interface WorkerTranscriptTurn {
  id: string
  version: number
  agentId: string
  threadId: string
  launchRunId: string
  turnId: string
  agentType: string
  workspacePath: string
  modelId: string
  messages: WorkerTranscriptEntry[]
  compaction: WorkerTranscriptCompaction | null
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  error: string | null
  promptTokens: number | null
  completionTokens: number | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
