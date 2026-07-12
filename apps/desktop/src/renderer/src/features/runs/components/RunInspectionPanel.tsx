import type React from 'react'
import { useCallback, useState } from 'react'
import { GitCompareArrows, History, RotateCcw } from 'lucide-react'
import { formatDate, tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { RunRecord } from '@renderer/app/types'
import { alpha, theme } from '@renderer/theme/theme'
import { DiffPreviewerModal } from '@renderer/features/chat/components/DiffPreviewerModal'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'

const EMPTY_RUNS: RunRecord[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRunDuration(run: RunRecord): string {
  if (!run.completedAt) return ''
  const ms = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.floor(ms / 100) / 10}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()

  return formatDate(d, isToday ? 'time' : 'dateTime')
}

function runStatusColor(status: RunRecord['status']): string {
  if (status === 'running') return theme.text.accent
  if (status === 'failed' || status === 'cancelled') return theme.text.danger
  return theme.text.success
}

function runStatusLabel(t: ReturnType<typeof useT>, status: RunRecord['status']): string {
  if (status === 'running') return t('runs.status.running')
  if (status === 'completed') return t('runs.status.completed')
  if (status === 'failed') return t('runs.status.failed')
  if (status === 'cancelled') return t('runs.status.cancelled')
  return status
}

// ---------------------------------------------------------------------------
// Run history item
// ---------------------------------------------------------------------------

interface RunHistoryItemProps {
  run: RunRecord
  isLatest: boolean
  onViewSnapshot: (runId: string) => void
  onRestoreCheckpoint: (runId: string) => void
}

function RunHistoryItem({
  run,
  isLatest,
  onViewSnapshot,
  onRestoreCheckpoint
}: RunHistoryItemProps): React.JSX.Element {
  const t = useT()
  const hasSnapshot = (run.snapshotFileCount ?? 0) > 0

  return (
    <div className="px-3 py-2.5" style={{ borderBottom: `1px solid ${alpha('ink', 0.05)}` }}>
      {/* Status + time row */}
      <div className="flex items-center gap-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: runStatusColor(run.status),
            animation:
              run.status === 'running'
                ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite'
                : undefined
          }}
        />
        <span className="text-[11px] font-medium" style={{ color: theme.text.secondary }}>
          {runStatusLabel(t, run.status)}
        </span>
        {run.completedAt ? (
          <span className="text-[11px]" style={{ color: theme.text.placeholder }}>
            · {formatRunDuration(run)}
          </span>
        ) : null}
        {isLatest ? (
          <span
            className="text-[9px] font-medium uppercase px-1 py-px rounded ml-auto"
            style={{ background: alpha('accent', 0.1), color: theme.text.accent }}
          >
            {t('runs.latest')}
          </span>
        ) : null}
      </div>

      {/* Timestamp + model row */}
      <div className="flex items-center gap-1.5 mt-1">
        <span className="text-[10px]" style={{ color: theme.text.muted }}>
          {formatTimestamp(run.createdAt)}
        </span>
        {run.modelId ? (
          <span
            className="text-[10px] truncate"
            style={{ color: theme.text.placeholder, maxWidth: 140 }}
            title={run.modelId}
          >
            · {run.modelId.split('/').pop()}
          </span>
        ) : null}
      </div>

      {/* Error */}
      {run.error ? (
        <div
          className="mt-1.5 rounded px-2 py-1 text-[10px] truncate"
          style={{
            background: theme.background.dangerSoft,
            color: theme.text.dangerStrong,
            fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
          }}
          title={run.error}
        >
          {run.error}
        </div>
      ) : null}

      {/* Actions row */}
      {hasSnapshot || !isLatest ? (
        <div className="flex items-center gap-1.5 mt-2">
          {hasSnapshot ? (
            <button
              type="button"
              onClick={() => onViewSnapshot(run.id)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
              style={{
                color: theme.text.accent,
                background: alpha('accent', 0.08),
                border: 'none',
                cursor: 'default'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = alpha('accent', 0.14)
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = alpha('accent', 0.08)
              }}
            >
              <GitCompareArrows size={10} strokeWidth={1.7} />
              {tPlural('runs.fileChanges', run.snapshotFileCount ?? 0)}
            </button>
          ) : null}
          {hasSnapshot && !isLatest ? (
            <button
              type="button"
              onClick={() => onRestoreCheckpoint(run.id)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
              style={{
                color: theme.text.danger,
                background: alpha('danger', 0.06),
                border: 'none',
                cursor: 'default'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = alpha('danger', 0.12)
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = alpha('danger', 0.06)
              }}
            >
              <RotateCcw size={10} strokeWidth={1.7} />
              {t('runs.restore')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export interface RunInspectionPanelProps {
  threadId: string | null
}

export function RunInspectionPanel({ threadId }: RunInspectionPanelProps): React.JSX.Element {
  const t = useT()
  const runs = useAppStore((state) =>
    threadId ? (state.runsByThread[threadId] ?? EMPTY_RUNS) : EMPTY_RUNS
  )
  const snapshotReviewByRun = useAppStore((s) => s.snapshotReviewByRun)

  const [viewingSnapshotRunId, setViewingSnapshotRunId] = useState<string | null>(null)
  const [confirmRestoreRunId, setConfirmRestoreRunId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  // Sort runs newest first
  const sortedRuns = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  // Merge persisted snapshotFileCount with ephemeral event data
  const runsWithSnapshots = sortedRuns.map((run) => ({
    ...run,
    snapshotFileCount: run.snapshotFileCount ?? snapshotReviewByRun[run.id]?.fileCount ?? 0
  }))

  const latestRunId = sortedRuns[0]?.id ?? null

  const handleViewSnapshot = useCallback((runId: string) => {
    setViewingSnapshotRunId(runId)
  }, [])

  const handleRestoreCheckpoint = useCallback((runId: string) => {
    setConfirmRestoreRunId(runId)
  }, [])

  const handleConfirmRestore = useCallback(async () => {
    const workspacePath = runsWithSnapshots.find(
      (run) => run.id === confirmRestoreRunId
    )?.workspacePath
    if (!confirmRestoreRunId || !workspacePath) return
    setRestoring(true)
    try {
      await window.api.yachiyo.restoreToCheckpoint({
        runId: confirmRestoreRunId,
        workspacePath
      })
    } finally {
      setRestoring(false)
      setConfirmRestoreRunId(null)
    }
  }, [confirmRestoreRunId, runsWithSnapshots])

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        borderLeft: `1px solid ${theme.border.default}`,
        width: '300px',
        minWidth: '300px'
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center shrink-0 px-4 gap-1.5"
        style={{
          borderBottom: `1px solid ${theme.border.default}`,
          height: '40px'
        }}
      >
        <History size={12} strokeWidth={1.8} style={{ color: theme.text.placeholder }} />
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: theme.text.placeholder, letterSpacing: '0.06em' }}
        >
          {t('runs.runHistory')}
        </span>
        {sortedRuns.length > 0 ? (
          <span className="text-[10px] ml-auto" style={{ color: theme.text.muted }}>
            {sortedRuns.length}
          </span>
        ) : null}
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {sortedRuns.length === 0 ? (
          <div
            className="flex items-center justify-center px-4 py-8"
            style={{ color: theme.text.muted, fontSize: '12px' }}
          >
            {t('runs.noRunsYet')}
          </div>
        ) : (
          runsWithSnapshots.map((run) => (
            <RunHistoryItem
              key={run.id}
              run={run}
              isLatest={run.id === latestRunId}
              onViewSnapshot={handleViewSnapshot}
              onRestoreCheckpoint={handleRestoreCheckpoint}
            />
          ))
        )}
      </div>

      {/* Diff preview modal */}
      {viewingSnapshotRunId ? (
        <DiffPreviewerModal
          runId={viewingSnapshotRunId}
          threadId={threadId ?? ''}
          workspacePath={
            runsWithSnapshots.find((r) => r.id === viewingSnapshotRunId)?.workspacePath ??
            snapshotReviewByRun[viewingSnapshotRunId]?.workspacePath ??
            ''
          }
          isLatestRun={viewingSnapshotRunId === latestRunId}
          onClose={() => setViewingSnapshotRunId(null)}
        />
      ) : null}

      {/* Restore confirmation dialog */}
      {confirmRestoreRunId ? (
        <ConfirmDialog
          title={t('runs.restoreToCheckpoint')}
          description={t('runs.restoreCheckpointDescription')}
          actions={[
            {
              key: 'cancel',
              label: t('common.cancel'),
              tone: 'default'
            },
            {
              key: 'restore',
              label: restoring ? t('runs.restoring') : t('runs.restore'),
              tone: 'danger'
            }
          ]}
          onSelect={(key) => {
            if (key === 'restore') {
              void handleConfirmRestore()
            } else {
              setConfirmRestoreRunId(null)
            }
          }}
          onClose={() => setConfirmRestoreRunId(null)}
        />
      ) : null}
    </div>
  )
}
