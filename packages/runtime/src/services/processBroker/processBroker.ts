export type ProcessOutputStream = 'stdout' | 'stderr'

export interface ProcessOutputChunk {
  stream: ProcessOutputStream
  text: string
}

export interface ProcessOutputBatch {
  sequence: number
  chunks: ProcessOutputChunk[]
  truncated: boolean
  totalBytes: number
}

export interface ProcessJobResult {
  exitCode: number
  timedOut: boolean
  cancelled: boolean
  spilled: boolean
  totalBytes: number
  error?: string
}

export type ProcessJobOutcome = { kind: 'timed-out' } | { kind: 'exited'; result: ProcessJobResult }

export interface ProcessJob {
  readonly id: string
  readonly pid: number
  readonly logPath: string
  onOutput(listener: (batch: ProcessOutputBatch) => void): () => void
  waitForOutcome(): Promise<ProcessJobOutcome>
  wait(): Promise<ProcessJobResult>
  cancel(): void
}

export type StartProcessJobInput = {
  id: string
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  timeoutSeconds?: number
  keepRunningOnTimeout: boolean
  retainLog: boolean
  spillThresholdChars: number
} & (
  | { command: string; executable?: never; args?: never }
  | { executable: string; args: readonly string[]; command?: never }
)

export interface ProcessBroker {
  start(): Promise<void>
  startJob(input: StartProcessJobInput): Promise<ProcessJob>
  close(): Promise<void>
}
