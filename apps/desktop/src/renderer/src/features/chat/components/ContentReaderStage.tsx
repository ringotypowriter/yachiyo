import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  FileText,
  Image as ImageIcon,
  FileDiff
} from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { ImageCanvas } from '@renderer/lib/markdown/ImageDetailViewer'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import { resolveTimelineFileOpenTarget } from '@renderer/lib/markdown/linkableCodeFileAction'
import { useContentReaderStore } from '../state/useContentReaderStore'
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor,
  type TimelineViewportAnchor
} from '../lib/timeline/timelineViewportAnchor'
import { DocumentReader } from './DocumentReader'
import { DiffReviewSurface } from './DiffReviewSurface'

export function ContentReaderStage({
  threadId,
  children
}: {
  threadId: string | null
  children?: ReactNode
}): React.JSX.Element {
  const target = useContentReaderStore((state) =>
    state.target?.threadId === threadId ? state.target : null
  )
  const close = useContentReaderStore((state) => state.close)
  const latestRun = useAppStore((state) =>
    threadId ? state.latestRunsByThread[threadId] : undefined
  )
  const activeRunId = useAppStore((state) =>
    threadId ? state.activeRunIdsByThread[threadId] : undefined
  )
  const config = useAppStore((state) => state.config?.workspace)
  const dialog = useAppDialog()
  const [refresh, setRefresh] = useState(0)
  const [responseReady, setResponseReady] = useState(false)
  useEffect(() => {
    const unsubscribeRuns = useAppStore.subscribe((state, previous) => {
      if (!threadId || useContentReaderStore.getState().target?.threadId !== threadId) return
      const completedAt = state.latestRunsByThread[threadId]?.completedAt
      if (completedAt && completedAt !== previous.latestRunsByThread[threadId]?.completedAt) {
        setRefresh((value) => value + 1)
        setResponseReady(true)
      }
    })
    const unsubscribeReader = useContentReaderStore.subscribe((state) => {
      if (!state.target) setResponseReady(false)
    })
    return () => {
      unsubscribeRuns()
      unsubscribeReader()
    }
  }, [threadId])
  const timelineRef = useRef<HTMLDivElement>(null)
  const origin = useRef<{
    top: number
    anchor: TimelineViewportAnchor | null
    focus: HTMLElement | null
  } | null>(null)
  const opened = target !== null
  useLayoutEffect(() => {
    const container = timelineRef.current?.querySelector<HTMLElement>('[data-timeline-scroll]')
    if (opened && !origin.current) {
      origin.current = {
        top: container?.scrollTop ?? 0,
        anchor: container ? captureTimelineViewportAnchor(container) : null,
        focus: document.activeElement instanceof HTMLElement ? document.activeElement : null
      }
    } else if (!opened && origin.current) {
      const saved = origin.current
      origin.current = null
      if (container) {
        container.scrollTop = saved.top
        if (saved.anchor) restoreTimelineViewportAnchor(container, saved.anchor)
      }
      if (saved.focus?.isConnected) saved.focus.focus({ preventScroll: true })
    }
  }, [opened])
  useEffect(
    () => () => {
      if (useContentReaderStore.getState().target?.threadId === threadId) close()
    },
    [threadId, close]
  )
  useEffect(() => {
    if (!opened) return
    const onKey = (event: KeyboardEvent): void => {
      if (!isDismissEscapeKey(event) || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [opened, close])

  const path = target && target.kind !== 'diff' ? target.path : null
  const title =
    target?.kind === 'diff'
      ? 'File Changes'
      : path?.split(/[\\/]/).pop() ||
        (target?.kind === 'image' ? target.alt || 'Image' : 'Document')
  const revision = String(refresh)
  const fileAction = async (reveal: boolean): Promise<void> => {
    if (!path) return
    try {
      const input = {
        path,
        threadId: threadId ?? undefined,
        workspacePath: target?.workspacePath,
        workspaceOnly: !!target?.workspacePath
      }
      if (reveal) await window.api.yachiyo.revealFile(input)
      else {
        const selected = resolveTimelineFileOpenTarget({
          filePath: path,
          editorApp: config?.editorApp,
          markdownApp: config?.markdownApp
        })
        await window.api.yachiyo.openFile({
          ...input,
          ...(selected.mode === 'configured'
            ? { appSelection: selected.appSelection, appKind: selected.appKind }
            : {})
        })
      }
    } catch (error) {
      await dialog.alert({ title: error instanceof Error ? error.message : 'Unable to open file.' })
    }
  }

  return (
    <div className="content-reader-stage">
      <div
        ref={timelineRef}
        className="content-reader-conversation"
        data-covered={opened}
        inert={opened || undefined}
        aria-hidden={opened || undefined}
      >
        {children}
      </div>
      {target ? (
        <section className="content-reader" data-reader-kind={target.kind} aria-label={title}>
          <header className="content-reader-header">
            <button
              type="button"
              className="content-reader-back"
              onClick={close}
              title="Back to conversation"
              aria-label="Back to conversation"
            >
              <ArrowLeft size={15} />
            </button>
            <span className="content-reader-title" title={title}>
              {target.kind === 'image' ? (
                <ImageIcon size={14} />
              ) : target.kind === 'diff' ? (
                <FileDiff size={14} />
              ) : (
                <FileText size={14} />
              )}
              <span>{title}</span>
            </span>
            <div className="content-reader-tools">
              {target.kind !== 'diff' ? (
                <button
                  type="button"
                  title="Reload file"
                  aria-label="Reload file"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  <RefreshCw size={14} />
                </button>
              ) : null}
              {path ? (
                <>
                  <button
                    type="button"
                    title="Open externally"
                    aria-label="Open externally"
                    onClick={() => void fileAction(false)}
                  >
                    <ExternalLink size={14} />
                  </button>
                  <button
                    type="button"
                    title="Show in folder"
                    aria-label="Show in folder"
                    onClick={() => void fileAction(true)}
                  >
                    <FolderOpen size={14} />
                  </button>
                </>
              ) : null}
            </div>
          </header>
          <div className="content-reader-body">
            {target.kind === 'image' ? (
              <ImageCanvas
                key={target.src}
                src={
                  target.src.startsWith('yachiyo-asset:')
                    ? `${target.src}&v=${revision}`
                    : target.src
                }
                alt={target.alt}
                onClose={close}
                embedded
              />
            ) : null}
            {target.kind === 'file' ? (
              <DocumentReader key={target.path} target={target} revision={revision} />
            ) : null}
            {target.kind === 'diff' ? (
              <DiffReviewSurface
                key={target.runId}
                runId={target.runId}
                threadId={target.threadId}
                workspacePath={target.workspacePath}
                isLatestRun={
                  latestRun?.id === target.runId && !!latestRun.completedAt && !activeRunId
                }
              />
            ) : null}
          </div>
          {activeRunId ? (
            <div className="content-reader-status" role="status">
              Yachiyo is working…
            </div>
          ) : responseReady ? (
            <div className="content-reader-status" role="status">
              <span>Response ready</span>
              <button type="button" onClick={close}>
                View conversation
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
