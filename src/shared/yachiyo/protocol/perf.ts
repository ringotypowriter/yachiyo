export interface EventLoopDelayStats {
  /** Minimum delay in milliseconds */
  min: number
  /** Maximum delay in milliseconds */
  max: number
  /** Mean delay in milliseconds */
  mean: number
  /** 50th percentile delay in milliseconds */
  p50: number
  /** 95th percentile delay in milliseconds */
  p95: number
  /** 99th percentile delay in milliseconds */
  p99: number
  /** Number of samples collected */
  samples: number
}

export interface RunPerfRecord {
  runId: string
  threadId: string
  /** Total run wall-clock duration in milliseconds */
  durationMs: number
  /** Time spent preparing context before the model stream starts */
  contextPrepareMs: number
  /** Number of model messages sent to the runtime after context compaction */
  contextMessageCount: number
  /** Number of active skills included in context */
  activeSkillCount: number
  /** Number of available skills considered for the run */
  availableSkillCount: number
  /** Number of memory entries included in context */
  memoryEntryCount: number
  /** Number of file mentions resolved while preparing context */
  fileMentionCount: number
  /** Number of file/jotdown references inlined into context */
  inlinedFileCount: number
  /** Time spent consuming the model stream */
  modelStreamMs: number
  /** Time from stream start to the first emitted text delta */
  firstTextDeltaMs?: number
  /** Time from stream start to the first emitted reasoning delta */
  firstReasoningDeltaMs?: number
  /** Number of recovery checkpoint writes */
  checkpointWriteCount: number
  /** Total time spent on checkpoint writes in milliseconds */
  checkpointWriteTotalMs: number
  /** Maximum single checkpoint write duration in milliseconds */
  checkpointWriteMaxMs: number
  /** Number of tool call DB writes (create + update) */
  toolCallWriteCount: number
  /** Total time spent on tool call writes in milliseconds */
  toolCallWriteTotalMs: number
  /** Maximum single tool call write duration in milliseconds */
  toolCallWriteMaxMs: number
  /** Number of snapshot finalization attempts */
  snapshotFinalizeCount: number
  /** Total time spent finalizing snapshots in milliseconds */
  snapshotFinalizeTotalMs: number
  /** Maximum single snapshot finalization duration in milliseconds */
  snapshotFinalizeMaxMs: number
  /** Number of delta events emitted to the renderer */
  deltaEventCount: number
  /** Number of reasoning delta events emitted */
  reasoningDeltaEventCount: number
  /** Total text characters streamed */
  textCharsStreamed: number
  /** Timestamp when the run completed */
  completedAt: string
}

export interface PerfStatsResponse {
  /** Event loop delay stats since last reset */
  eventLoop: EventLoopDelayStats
  /** Recent run performance records (most recent first, capped at 50) */
  recentRuns: RunPerfRecord[]
  /** Total IPC events emitted since app start */
  ipcEventCount: number
  /** IPC events emitted in the last 60 seconds */
  ipcEventsLast60s: number
  /** Breakdown of IPC events by type in the last 60 seconds */
  ipcEventsByType: Record<string, number>
  /** Number of currently active runs */
  activeRunCount: number
  /** Uptime of the server process in seconds */
  uptimeSeconds: number
}
