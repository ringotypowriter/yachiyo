import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, RotateCcw, FilePlus2, FileMinus2, FileEdit, SquareArrowOutUpRight } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { ToolCodeBlock } from './ToolCodeBlock'
import type {
  FileChangeForReview,
  FileChangeStatus
} from '../../../../../shared/yachiyo/fileSnapshot.ts'

interface DiffPreviewerModalProps {
  runId: string
  threadId: string
  workspacePath: string
  /** When false, revert buttons are hidden to prevent silently discarding later runs' edits. */
  isLatestRun?: boolean
  onClose: () => void
}

const statusIcon: Record<FileChangeStatus, typeof FileEdit> = {
  modified: FileEdit,
  created: FilePlus2,
  deleted: FileMinus2
}

const statusColor: Record<FileChangeStatus, string> = {
  modified: theme.text.accent,
  created: theme.text.success,
  deleted: theme.text.danger
}

export function DiffPreviewerModal({
  runId,
  threadId,
  workspacePath,
  isLatestRun = true,
  onClose
}: DiffPreviewerModalProps): React.JSX.Element {
  const editorApp = useAppStore((s) => s.config?.workspace?.editorApp)
  const markdownApp = useAppStore((s) => s.config?.workspace?.markdownApp)
  const [changes, setChanges] = useState<FileChangeForReview[] | null>(null)
  const [error, setError] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [reverting, setReverting] = useState(false)
  const [confirmRevertMode, setConfirmRevertMode] = useState<'file' | 'all' | null>(null)
  const [confirmRevertPath, setConfirmRevertPath] = useState<string | null>(null)

  useEffect(() => {
    setChanges(null)
    setError(false)
    let ignore = false
    window.api.yachiyo
      .getSnapshotDiff({ runId, workspacePath })
      .then((result) => {
        if (ignore) return
        setChanges(result)
        if (result.length > 0) setSelectedIdx(0)
      })
      .catch(() => {
        if (ignore) return
        setError(true)
      })
    return () => {
      ignore = true
    }
  }, [runId, threadId, workspacePath])

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [handleEscape])

  const handleRevertFile = useCallback((relativePath: string) => {
    setConfirmRevertPath(relativePath)
    setConfirmRevertMode('file')
  }, [])

  const handleRevertAll = useCallback(() => {
    setConfirmRevertMode('all')
  }, [])

  const executeRevertFile = useCallback(
    async (relativePath: string) => {
      setReverting(true)
      try {
        await window.api.yachiyo.revertSnapshotFile({ runId, workspacePath, relativePath })
        // Re-fetch diffs after revert
        const updated = await window.api.yachiyo.getSnapshotDiff({ runId, workspacePath })
        setChanges(updated)
        if (selectedIdx >= updated.length) setSelectedIdx(Math.max(0, updated.length - 1))
        const activeCount = updated.filter((c) => !c.reverted).length
        useAppStore.getState().updateSnapshotFileCount(threadId, runId, activeCount)
      } finally {
        setReverting(false)
      }
    },
    [runId, threadId, workspacePath, selectedIdx]
  )

  const executeRevertAll = useCallback(async () => {
    setReverting(true)
    try {
      await window.api.yachiyo.revertSnapshotRun({ runId, workspacePath })
      setChanges([])
      setSelectedIdx(0)
      useAppStore.getState().updateSnapshotFileCount(threadId, runId, 0)
    } finally {
      setReverting(false)
    }
  }, [runId, threadId, workspacePath])

  const handleConfirmRevert = useCallback(async () => {
    if (confirmRevertMode === 'file' && confirmRevertPath) {
      await executeRevertFile(confirmRevertPath)
    } else if (confirmRevertMode === 'all') {
      await executeRevertAll()
    }
    setConfirmRevertMode(null)
    setConfirmRevertPath(null)
  }, [confirmRevertMode, confirmRevertPath, executeRevertFile, executeRevertAll])

  const handleOpenInEditor = useCallback(
    async (relativePath: string) => {
      const fullPath = workspacePath.endsWith('/')
        ? `${workspacePath}${relativePath}`
        : `${workspacePath}/${relativePath}`
      const isMd = relativePath.toLowerCase().endsWith('.md')
      const app = isMd ? markdownApp || editorApp : editorApp
      if (!app) return
      try {
        await window.api.yachiyo.openFileInEditor({ path: fullPath, editorApp: app })
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Failed to open in editor.')
      }
    },
    [workspacePath, editorApp, markdownApp]
  )

  const selected = changes?.[selectedIdx]

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 200, background: 'rgba(0, 0, 0, 0.25)' }}
          onMouseDown={onClose}
        >
          <div
            className="flex flex-col"
            style={{
              width: '65vw',
              minWidth: 600,
              maxWidth: 1100,
              height: '70vh',
              maxHeight: 'min(800px, 85vh)',
              background: theme.background.surfaceFrosted,
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              border: `1px solid ${theme.border.strong}`,
              borderRadius: 16,
              boxShadow: theme.shadow.menu
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between shrink-0 px-5 pt-4 pb-3"
              style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
            >
              <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
                File changes
                {changes ? (
                  <span style={{ color: theme.text.muted, fontWeight: 400 }}>
                    {' '}
                    ({changes.length} {changes.length === 1 ? 'file' : 'files'})
                  </span>
                ) : null}
              </span>
              <button
                onClick={onClose}
                className="p-1 rounded-md transition-opacity opacity-40 hover:opacity-70"
                style={{
                  color: theme.icon.default,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer'
                }}
                aria-label="Close"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>

            {/* Body */}
            <div className="flex flex-1" style={{ minHeight: 0 }}>
              {/* File list sidebar */}
              <div
                className="shrink-0 overflow-y-auto min-h-0"
                style={{
                  width: 200,
                  borderRight: `1px solid ${theme.border.subtle}`
                }}
              >
                {error ? (
                  <div className="p-3 text-xs" style={{ color: theme.text.muted }}>
                    Failed to load changes.
                  </div>
                ) : changes === null ? (
                  <div className="p-3 text-xs" style={{ color: theme.text.muted }}>
                    Loading...
                  </div>
                ) : changes.length === 0 ? (
                  <div className="p-3 text-xs" style={{ color: theme.text.muted }}>
                    No file changes.
                  </div>
                ) : (
                  changes.map((change, i) => {
                    const Icon = statusIcon[change.status]
                    const isSelected = i === selectedIdx
                    return (
                      <button
                        key={change.relativePath}
                        type="button"
                        onClick={() => setSelectedIdx(i)}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 transition-colors"
                        style={{
                          background: isSelected ? alpha('ink', 0.06) : 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          borderBottom: `1px solid ${alpha('ink', 0.04)}`,
                          opacity: change.reverted ? 0.5 : 1
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.background = alpha('ink', 0.03)
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = isSelected
                            ? alpha('ink', 0.06)
                            : 'transparent'
                        }}
                      >
                        <Icon
                          size={12}
                          strokeWidth={1.5}
                          style={{ color: statusColor[change.status], flexShrink: 0 }}
                        />
                        <span
                          className="text-xs truncate"
                          style={{ color: isSelected ? theme.text.primary : theme.text.secondary }}
                          title={change.relativePath}
                        >
                          {change.relativePath.split('/').pop()}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>

              {/* Diff panel */}
              <div className="flex-1 flex flex-col overflow-hidden p-4" style={{ minHeight: 0 }}>
                {selected ? (
                  <div className="flex flex-col gap-2 min-h-0 flex-1">
                    <div className="flex items-center justify-between shrink-0">
                      <span className="text-xs" style={{ color: theme.text.muted }}>
                        {selected.relativePath}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {selected.status !== 'deleted'
                          ? (() => {
                              const isMd = selected.relativePath.toLowerCase().endsWith('.md')
                              const app = isMd ? markdownApp || editorApp : editorApp
                              return app ? (
                                <button
                                  type="button"
                                  onClick={() => handleOpenInEditor(selected.relativePath)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-opacity hover:opacity-80"
                                  style={{
                                    color: theme.text.accent,
                                    background: alpha('ink', 0.05),
                                    border: 'none',
                                    cursor: 'pointer'
                                  }}
                                >
                                  <SquareArrowOutUpRight size={10} strokeWidth={2} />
                                  Open in {app}
                                </button>
                              ) : null
                            })()
                          : null}
                        {selected.reverted ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs"
                            style={{
                              color: theme.text.muted,
                              background: alpha('ink', 0.05)
                            }}
                          >
                            <RotateCcw size={10} strokeWidth={2} />
                            Reverted
                          </span>
                        ) : isLatestRun ? (
                          <button
                            type="button"
                            onClick={() => handleRevertFile(selected.relativePath)}
                            disabled={reverting}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-opacity hover:opacity-80"
                            style={{
                              color: theme.text.danger,
                              background: alpha('danger', 0.08),
                              border: 'none',
                              cursor: reverting ? 'not-allowed' : 'pointer',
                              opacity: reverting ? 0.5 : 1
                            }}
                          >
                            <RotateCcw size={10} strokeWidth={2} />
                            Revert
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto">
                      <ToolCodeBlock
                        key={selected.relativePath}
                        value={selected.diff}
                        filePath={
                          selected.status !== 'deleted'
                            ? `${workspacePath}${workspacePath.endsWith('/') ? '' : '/'}${selected.relativePath}`
                            : undefined
                        }
                        variant="diff"
                        fillHeight
                      />
                    </div>
                  </div>
                ) : changes && changes.length === 0 ? (
                  <div
                    className="flex items-center justify-center h-full text-xs"
                    style={{ color: theme.text.muted }}
                  >
                    All changes have been reverted.
                  </div>
                ) : null}
              </div>
            </div>

            {/* Footer */}
            <div
              className="shrink-0 px-5 py-3 flex justify-end gap-2"
              style={{ borderTop: `1px solid ${theme.border.subtle}` }}
            >
              {isLatestRun && changes && changes.some((c) => !c.reverted) ? (
                <button
                  onClick={handleRevertAll}
                  disabled={reverting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity hover:opacity-80 inline-flex items-center gap-1.5"
                  style={{
                    background: alpha('danger', 0.08),
                    color: theme.text.danger,
                    border: 'none',
                    cursor: reverting ? 'not-allowed' : 'pointer',
                    opacity: reverting ? 0.5 : 1
                  }}
                >
                  <RotateCcw size={11} strokeWidth={2} />
                  Revert all
                </button>
              ) : null}
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity hover:opacity-80"
                style={{
                  background: alpha('ink', 0.06),
                  color: theme.text.primary,
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {confirmRevertMode ? (
        <ConfirmDialog
          title={confirmRevertMode === 'file' ? 'Revert file' : 'Revert all changes'}
          description={
            confirmRevertMode === 'file'
              ? `This will restore ${confirmRevertPath} to its previous state. This cannot be undone.`
              : 'This will restore all files to their previous state. This cannot be undone.'
          }
          actions={[
            { key: 'revert', label: reverting ? 'Reverting...' : 'Revert', tone: 'danger' },
            { key: 'cancel', label: 'Cancel', tone: 'default' }
          ]}
          onSelect={(key) => {
            if (key === 'revert') {
              void handleConfirmRevert()
            } else {
              setConfirmRevertMode(null)
              setConfirmRevertPath(null)
            }
          }}
          onClose={() => {
            setConfirmRevertMode(null)
            setConfirmRevertPath(null)
          }}
        />
      ) : null}
    </>
  )
}
