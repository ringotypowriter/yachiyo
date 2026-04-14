import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, RotateCcw, FilePlus2, FileMinus2, FileEdit } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { ToolCodeBlock } from './ToolCodeBlock'
import type {
  FileChangeForReview,
  FileChangeStatus
} from '../../../../../shared/yachiyo/fileSnapshot.ts'

interface DiffPreviewerModalProps {
  runId: string
  workspacePath: string
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
  workspacePath,
  onClose
}: DiffPreviewerModalProps): React.JSX.Element {
  const [changes, setChanges] = useState<FileChangeForReview[] | null>(null)
  const [error, setError] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [reverting, setReverting] = useState(false)

  useEffect(() => {
    window.api.yachiyo
      .getSnapshotDiff({ runId, workspacePath })
      .then((result) => {
        setChanges(result)
        if (result.length > 0) setSelectedIdx(0)
      })
      .catch(() => setError(true))
  }, [runId, workspacePath])

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

  const handleRevertFile = useCallback(
    async (relativePath: string) => {
      setReverting(true)
      try {
        await window.api.yachiyo.revertSnapshotFile({ runId, workspacePath, relativePath })
        // Re-fetch diffs after revert
        const updated = await window.api.yachiyo.getSnapshotDiff({ runId, workspacePath })
        setChanges(updated)
        if (selectedIdx >= updated.length) setSelectedIdx(Math.max(0, updated.length - 1))
      } finally {
        setReverting(false)
      }
    },
    [runId, workspacePath, selectedIdx]
  )

  const handleRevertAll = useCallback(async () => {
    setReverting(true)
    try {
      await window.api.yachiyo.revertSnapshotRun({ runId, workspacePath })
      setChanges([])
      setSelectedIdx(0)
    } finally {
      setReverting(false)
    }
  }, [runId, workspacePath])

  const selected = changes?.[selectedIdx]

  return createPortal(
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
            className="shrink-0 overflow-y-auto"
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
                      borderBottom: `1px solid ${alpha('ink', 0.04)}`
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
          <div className="flex-1 overflow-y-auto p-4" style={{ minHeight: 0 }}>
            {selected ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs" style={{ color: theme.text.muted }}>
                    {selected.relativePath}
                  </span>
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
                </div>
                <ToolCodeBlock
                  key={selected.relativePath}
                  value={selected.diff}
                  filePath={selected.relativePath}
                  variant="diff"
                />
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
          {changes && changes.length > 0 ? (
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
  )
}
