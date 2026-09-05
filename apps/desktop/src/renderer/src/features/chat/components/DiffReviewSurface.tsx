import { useCallback, useEffect, useState } from 'react'
import {
  RotateCcw,
  FilePlus2,
  FileMinus2,
  FileEdit,
  SquareArrowOutUpRight,
  ChevronDown,
  Check
} from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { buildDiffFileOpenRequest } from './diffFileOpenRequest'
import { ToolCodeBlock } from './ToolCodeBlock'
import { useContentReaderStore } from '../state/useContentReaderStore'
import type { FileChangeForReview, FileChangeStatus } from '@yachiyo/shared/fileSnapshot'

interface DiffReviewSurfaceProps {
  runId: string
  threadId: string
  workspacePath: string
  /** When false, revert buttons are hidden to prevent silently discarding later runs' edits. */
  isLatestRun?: boolean
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

export function DiffReviewSurface({
  runId,
  threadId,
  workspacePath,
  isLatestRun = true
}: DiffReviewSurfaceProps): React.JSX.Element {
  const t = useT()
  const dialog = useAppDialog()
  const editorApp = useAppStore((s) => s.config?.workspace?.editorApp)
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
    if (reverting) return
    const state = useAppStore.getState()
    if (
      !isLatestRun ||
      state.activeRunIdsByThread[threadId] ||
      state.latestRunsByThread[threadId]?.id !== runId
    ) {
      setConfirmRevertMode(null)
      setConfirmRevertPath(null)
      return
    }
    const mode = confirmRevertMode
    const path = confirmRevertPath
    setConfirmRevertMode(null)
    setConfirmRevertPath(null)
    try {
      if (mode === 'file' && path) await executeRevertFile(path)
      else if (mode === 'all') await executeRevertAll()
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Unable to revert changes.'
      })
    }
  }, [
    confirmRevertMode,
    confirmRevertPath,
    executeRevertFile,
    executeRevertAll,
    isLatestRun,
    reverting,
    threadId,
    runId,
    dialog
  ])

  const handleOpenFile = useCallback(
    async (relativePath: string) => {
      const request = buildDiffFileOpenRequest({ workspacePath, relativePath, editorApp })
      if (!request) return
      try {
        await window.api.yachiyo.openFile(request)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : t('chat.diff.openFileFailed')
        })
      }
    },
    [dialog, editorApp, t, workspacePath]
  )

  const selected = changes?.[selectedIdx]
  useEffect(() => {
    useContentReaderStore.getState().selectDiffFile(runId, selected?.relativePath)
  }, [runId, selected?.relativePath])

  return (
    <>
      <div className="content-reader-diff">
        {selected && changes ? (
          <>
            <div className="content-reader-diff__toolbar">
              <details
                className="content-reader-file-picker"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && event.currentTarget.hasAttribute('open')) {
                    event.preventDefault()
                    event.stopPropagation()
                    event.currentTarget.removeAttribute('open')
                  }
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    event.currentTarget.removeAttribute('open')
                }}
              >
                <summary aria-label="Changed files" title={selected.relativePath}>
                  <FileEdit size={14} strokeWidth={1.6} />
                  <span className="content-reader-file-picker__name">{selected.relativePath}</span>
                  <span className="content-reader-file-picker__count">
                    {selectedIdx + 1} / {changes.length}
                  </span>
                  <ChevronDown size={12} />
                </summary>
                <div className="content-reader-file-picker__menu">
                  {changes.map((change, index) => {
                    const Icon = statusIcon[change.status]
                    return (
                      <button
                        key={change.relativePath}
                        type="button"
                        aria-current={index === selectedIdx ? 'true' : undefined}
                        onClick={(event) => {
                          setSelectedIdx(index)
                          event.currentTarget.closest('details')?.removeAttribute('open')
                        }}
                      >
                        <Icon size={14} style={{ color: statusColor[change.status] }} />
                        <span
                          title={change.relativePath}
                          style={{ opacity: change.reverted ? 0.5 : 1 }}
                        >
                          {change.relativePath}
                        </span>
                        {index === selectedIdx ? <Check size={13} /> : null}
                      </button>
                    )
                  })}
                </div>
              </details>
              <div className="content-reader-diff__actions">
                {selected.status !== 'deleted' &&
                buildDiffFileOpenRequest({
                  workspacePath,
                  relativePath: selected.relativePath,
                  editorApp
                }) ? (
                  <button
                    type="button"
                    title="Open in editor"
                    aria-label="Open in editor"
                    onClick={() => void handleOpenFile(selected.relativePath)}
                  >
                    <SquareArrowOutUpRight size={14} />
                  </button>
                ) : null}
                {selected.reverted ? (
                  <span className="content-reader-diff__reverted">{t('chat.diff.reverted')}</span>
                ) : isLatestRun ? (
                  <button
                    type="button"
                    disabled={reverting}
                    onClick={() => handleRevertFile(selected.relativePath)}
                  >
                    <RotateCcw size={12} />
                    <span>Revert file</span>
                  </button>
                ) : null}
                {isLatestRun && changes.some((change) => !change.reverted) ? (
                  <button
                    type="button"
                    className="content-reader-diff__revert-all"
                    disabled={reverting}
                    onClick={handleRevertAll}
                  >
                    {t('chat.diff.revertAll')}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="content-reader-diff__code">
              <ToolCodeBlock
                key={selected.relativePath}
                value={selected.diff}
                filePath={
                  selected.status !== 'deleted'
                    ? workspacePath +
                      (workspacePath.endsWith('/') ? '' : '/') +
                      selected.relativePath
                    : undefined
                }
                variant="diff"
                fillHeight
              />
            </div>
          </>
        ) : (
          <div className="content-reader-empty" role={error ? 'alert' : 'status'}>
            <FileEdit size={24} strokeWidth={1.2} />
            <span>
              {error
                ? t('chat.diff.loadFailed')
                : changes === null
                  ? t('common.loading')
                  : t('chat.diff.noFileChanges')}
            </span>
          </div>
        )}
      </div>
      {confirmRevertMode ? (
        <ConfirmDialog
          title={
            confirmRevertMode === 'file'
              ? t('chat.diff.revertFileTitle')
              : t('chat.diff.revertAllTitle')
          }
          description={
            confirmRevertMode === 'file'
              ? t('chat.diff.revertFileDescription', { path: confirmRevertPath ?? '' })
              : t('chat.diff.revertAllDescription')
          }
          actions={[
            {
              key: 'revert',
              label: reverting ? t('chat.diff.reverting') : t('chat.diff.revert'),
              tone: 'danger'
            },
            { key: 'cancel', label: t('common.cancel'), tone: 'default' }
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
