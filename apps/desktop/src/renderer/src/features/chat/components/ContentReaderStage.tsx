import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircleQuestion, ExternalLink, FolderOpen, RefreshCw } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { ImageCanvas } from '@renderer/lib/markdown/ImageDetailViewer'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import { resolveTimelineFileOpenTarget } from '@renderer/lib/markdown/linkableCodeFileAction'
import { EMPTY_READER_CONVERSATION, useContentReaderStore } from '../state/useContentReaderStore'
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor,
  type TimelineViewportAnchor
} from '../lib/timeline/timelineViewportAnchor'
import { DocumentReader } from './DocumentReader'
import { DiffReviewSurface } from './DiffReviewSurface'

import type { BrowserAutomationActivityBubbleState } from '@yachiyo/shared/protocol'
import { readerTitle, type ReaderTarget } from '../lib/contentReader'
import { RetainedBrowserPreview } from './RetainedBrowserPreview'
import type { PreviewReadingState } from '../lib/previewRetention'

export function ContentReaderStage({
  threadId,
  children,
  browserSuspended = false,
  browserActivityBubble,
  toolsHost
}: {
  threadId: string | null
  children?: ReactNode
  browserSuspended?: boolean
  browserActivityBubble?: BrowserAutomationActivityBubbleState | null
  /** Header element where the active preview renders its actions. */
  toolsHost: HTMLElement | null
}): React.JSX.Element {
  const conversations = useContentReaderStore((state) => state.conversations)
  const conversation = threadId
    ? (conversations[threadId] ?? EMPTY_READER_CONVERSATION)
    : EMPTY_READER_CONVERSATION
  const select = useContentReaderStore((state) => state.select)
  const closeTab = useContentReaderStore((state) => state.closeTab)
  const opened = conversation.activeId !== 'chat'
  useLayoutEffect(() => {
    useContentReaderStore.getState().setThread(threadId)
    return () => {
      useContentReaderStore.getState().setThread(null)
    }
  }, [threadId])
  const timelineRef = useRef<HTMLDivElement>(null)
  const origin = useRef<{
    top: number
    anchor: TimelineViewportAnchor | null
    focus: HTMLElement | null
  } | null>(null)
  useLayoutEffect(() => {
    origin.current = null
  }, [threadId])
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
      if (saved.focus?.isConnected && document.activeElement?.getAttribute('role') !== 'tab')
        saved.focus.focus({ preventScroll: true })
    }
  }, [opened, threadId])

  useEffect(() => {
    if (!opened || !threadId) return
    const onKey = (event: KeyboardEvent): void => {
      if (
        !isDismissEscapeKey(event) ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"]')
      )
        return
      event.preventDefault()
      select(threadId, 'chat')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [opened, threadId, select])
  return (
    <div className="content-reader-stage">
      <div className="content-reader-panels">
        <div
          ref={timelineRef}
          className="content-reader-conversation"
          data-covered={opened}
          inert={opened || undefined}
          aria-hidden={opened || undefined}
        >
          {children}
        </div>
        {Object.entries(conversations).flatMap(([owner, entry]) =>
          entry.tabs
            .filter((tab) => tab.hot)
            .map((tab) => (
              <ReaderPanel
                browserSuspended={browserSuspended}
                browserActivityBubble={browserActivityBubble}
                key={JSON.stringify([owner, tab.id, tab.generation])}
                tabId={tab.id}
                reading={tab.reading}
                target={tab.target}
                active={owner === threadId && entry.activeId === tab.id}
                toolsSlot={toolsHost}
                close={() => closeTab(owner, tab.id)}
                ask={() => useContentReaderStore.getState().ask(owner, tab.id)}
              />
            ))
        )}
      </div>
    </div>
  )
}

function ReaderPanel({
  target,
  tabId,
  reading,
  active,
  toolsSlot,
  close,
  ask,
  browserSuspended,
  browserActivityBubble
}: {
  target: ReaderTarget
  tabId: string
  reading: PreviewReadingState
  active: boolean
  toolsSlot: HTMLElement | null
  close: () => void
  ask: () => void
  browserSuspended: boolean
  browserActivityBubble?: BrowserAutomationActivityBubbleState | null
}): React.JSX.Element {
  const threadId = target.threadId
  const [initialReading] = useState(reading)
  const saveReading = useCallback(
    (reading: PreviewReadingState): void => {
      useContentReaderStore.getState().saveReading(threadId, tabId, reading)
    },
    [threadId, tabId]
  )
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
  const webSession = target.kind === 'web' ? target.session : null
  useEffect(() => {
    if (!active || !webSession) return
    // Native navigation updates the service record, not the renderer target.
    const refreshMetadata = (): void => {
      void useContentReaderStore
        .getState()
        .refreshWeb(threadId, webSession, window.api.yachiyo.listBrowserAutomationSessions)
        .catch(() => {})
    }
    refreshMetadata()
    const timer = setInterval(refreshMetadata, 1000)
    return () => clearInterval(timer)
  }, [active, threadId, webSession])

  const webAction = async (action: 'ask' | 'external'): Promise<void> => {
    if (!webSession) return
    try {
      const page = await useContentReaderStore
        .getState()
        .refreshWeb(threadId, webSession, window.api.yachiyo.listBrowserAutomationSessions)
      const current = useContentReaderStore.getState().target
      if (
        current?.kind !== 'web' ||
        current.threadId !== threadId ||
        current.session !== webSession
      )
        return
      if (!page) throw new Error('This browser preview is no longer available.')
      if (action === 'ask') ask()
      else if (page.url) window.open(page.url, '_blank', 'noreferrer')
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Unable to read browser preview.'
      })
    }
  }
  useEffect(() => {
    const unsubscribeRuns = useAppStore.subscribe((state, previous) => {
      if (!threadId || useContentReaderStore.getState().target?.threadId !== threadId) return
      const completedAt = state.latestRunsByThread[threadId]?.completedAt
      if (completedAt && completedAt !== previous.latestRunsByThread[threadId]?.completedAt) {
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

  const path = target.kind !== 'diff' && target.kind !== 'web' ? target.path : null
  const title = readerTitle(target)
  const externalUrl =
    target.kind === 'web'
      ? target.url
      : target.kind === 'image' && /^https?:\/\//i.test(target.src)
        ? target.src
        : null
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
    <section
      role="tabpanel"
      hidden={!active}
      aria-hidden={!active || undefined}
      inert={!active || undefined}
      className="content-reader"
      data-reader-kind={target.kind}
      aria-label={title}
    >
      {active && toolsSlot
        ? createPortal(
            <>
              <button
                type="button"
                onClick={() => (webSession ? void webAction('ask') : ask())}
                title="Ask Yachiyo"
                aria-label="Ask Yachiyo"
              >
                <MessageCircleQuestion size={14} />
                <span>Ask Yachiyo</span>
              </button>
              {webSession ? (
                <button
                  type="button"
                  title="Open in browser"
                  aria-label="Open in browser"
                  onClick={() => void webAction('external')}
                >
                  <ExternalLink size={14} />
                </button>
              ) : externalUrl ? (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in browser"
                  aria-label="Open in browser"
                >
                  <ExternalLink size={14} />
                </a>
              ) : null}
              {target.kind !== 'diff' && target.kind !== 'web' ? (
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
            </>,
            toolsSlot
          )
        : null}
      <div className="content-reader-body">
        {target.kind === 'web' ? (
          <RetainedBrowserPreview
            target={target}
            reading={initialReading}
            suspended={!active || browserSuspended}
            activityBubble={browserActivityBubble}
          />
        ) : null}
        {target.kind === 'image' ? (
          <ImageCanvas
            key={target.src}
            src={
              target.src.startsWith('yachiyo-asset:') ? `${target.src}&v=${revision}` : target.src
            }
            alt={target.alt}
            onClose={close}
            embedded
            reading={initialReading}
            onReadingChange={saveReading}
          />
        ) : null}
        {target.kind === 'file' ? (
          <DocumentReader
            key={target.path}
            target={target}
            revision={revision}
            reading={initialReading}
            onReadingChange={saveReading}
          />
        ) : null}
        {target.kind === 'diff' ? (
          <DiffReviewSurface
            key={target.runId}
            runId={target.runId}
            reading={initialReading}
            onReadingChange={saveReading}
            threadId={target.threadId}
            workspacePath={target.workspacePath}
            isLatestRun={latestRun?.id === target.runId && !!latestRun.completedAt && !activeRunId}
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
          <button
            type="button"
            onClick={() => useContentReaderStore.getState().select(threadId, 'chat')}
          >
            View conversation
          </button>
        </div>
      ) : null}
    </section>
  )
}
