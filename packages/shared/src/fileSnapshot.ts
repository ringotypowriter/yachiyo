/**
 * Shared types for the file snapshot & diff previewer system.
 *
 * The snapshot system captures file states before agent modifications
 * (via write/edit tools, bash commands, or subprocess side effects)
 * in a content-addressed storage (CAS) pool, indexed per run.
 */

// ---------------------------------------------------------------------------
// Snapshot data model
// ---------------------------------------------------------------------------

export interface FileSnapshotEntry {
  /** Path relative to the workspace root. */
  relativePath: string
  /** SHA-256 hash of the original file content, or null if the file was newly created. */
  backupHash: string | null
  /** Original file size in bytes (0 for newly created files). */
  originalSize: number
  /** SHA-256 hash of the file content after the run, or null if the file was deleted. */
  afterHash?: string | null
}

export interface RunSnapshot {
  runId: string
  threadId: string
  workspacePath: string
  createdAt: string
  entries: FileSnapshotEntry[]
}

export interface SnapshotSummary {
  runId: string
  fileCount: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// Diff preview
// ---------------------------------------------------------------------------

export type FileChangeStatus = 'modified' | 'created' | 'deleted'

export interface FileChangeForReview {
  relativePath: string
  status: FileChangeStatus
  /** Unified diff string suitable for rendering in ToolCodeBlock variant="diff". */
  diff: string
  /** True when the file has been restored to its pre-run state since the run completed. */
  reverted?: boolean
}

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

export interface GetSnapshotDiffInput {
  runId: string
  workspacePath: string
}

export interface RevertSnapshotFileInput {
  runId: string
  workspacePath: string
  relativePath: string
}

export interface RevertSnapshotRunInput {
  runId: string
  workspacePath: string
}
