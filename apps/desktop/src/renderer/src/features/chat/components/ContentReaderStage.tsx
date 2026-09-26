import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquare,
  Globe,
  X,
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
import { EMPTY_READER_CONVERSATION, useContentReaderStore } from '../state/useContentReaderStore'
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor,
  type TimelineViewportAnchor
} from '../lib/timeline/timelineViewportAnchor'
import { DocumentReader } from './DocumentReader'
import { DiffReviewSurface } from './DiffReviewSurface'

import type { BrowserAutomationActivityBubbleState } from '@yachiyo/shared/protocol'
import type { ReaderTarget } from '../lib/contentReader'
import { BrowserTimelineView } from './BrowserTimelineView'

function readerTitle(target: ReaderTarget): string {
  if (target.kind === 'diff') return 'File Changes'
  if (target.kind === 'web') return target.title || target.url || target.session
  return (
    target.path?.split(/[\\/]/).pop() ||
    (target.kind === 'image' ? target.alt || 'Image' : 'Document')
  )
}

export function ContentReaderStage({
  threadId,
  children,
  browserSuspended = false,
  browserActivityBubble
}: {
  threadId: string | null
  children?: ReactNode
  browserSuspended?: boolean
  browserActivityBubble?: BrowserAutomationActivityBubbleState | null
}): React.JSX.Element {
  const conversations = useContentReaderStore((state) => state.conversations)
  const conversation = threadId
    ? (conversations[threadId] ?? EMPTY_READER_CONVERSATION)
    : EMPTY_READER_CONVERSATION
  const running = useAppStore((state) => !!threadId && !!state.activeRunIdsByThread[threadId])
  const needsAttention = useAppStore(
    (state) =>
      !!threadId &&
      (state.planDocumentsByThread[threadId]?.decision === 'pending' ||
        !!state.toolCalls[threadId]?.some((call) => call.status === 'waiting-for-user'))
  )
  const select = useContentReaderStore((state) => state.select)
  const closeTab = useContentReaderStore((state) => state.closeTab)
  const opened = conversation.activeId !== 'chat'
  useLayoutEffect(() => {
    useContentReaderStore.getState().setThread(threadId)
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
      <div
        className="content-reader-tabs"
        role="tablist"
        aria-label="Conversation tabs"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.getAttribute('role') !== 'tab')
            return
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
          )
          const index = tabs.indexOf(event.target as HTMLButtonElement)
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : -1
          if (next < 0) return
          event.preventDefault()
          tabs[next].click()
          tabs[next].focus()
        }}
      >
        <button
          type="button"
          role="tab"
          tabIndex={opened ? -1 : 0}
          aria-selected={!opened}
          onClick={() => threadId && select(threadId, 'chat')}
        >
          <MessageSquare size={14} />
          Chat
          {needsAttention ? (
            <MessageCircleQuestion size={14} aria-label="Needs your attention" />
          ) : running ? (
            <LoaderCircle size={13} className="animate-spin" aria-label="Yachiyo is working" />
          ) : null}
        </button>
        {conversation.tabs.map((tab) => (
          <div className="content-reader-tab" key={tab.id}>
            <button
              type="button"
              role="tab"
              tabIndex={conversation.activeId === tab.id ? 0 : -1}
              aria-selected={conversation.activeId === tab.id}
              title={readerTitle(tab.target)}
              onClick={() => threadId && select(threadId, tab.id)}
            >
              {tab.target.kind === 'web' ? (
                <Globe size={14} />
              ) : tab.target.kind === 'image' ? (
                <ImageIcon size={14} />
              ) : tab.target.kind === 'diff' ? (
                <FileDiff size={14} />
              ) : (
                <FileText size={14} />
              )}
              <span>{readerTitle(tab.target)}</span>
            </button>
            <button
              type="button"
              className="content-reader-tab-close"
              aria-label={`Close ${readerTitle(tab.target)}`}
              onClick={() => threadId && closeTab(threadId, tab.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
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
          entry.tabs.map((tab) => (
            <ReaderPanel
              browserSuspended={browserSuspended}
              browserActivityBubble={browserActivityBubble}
              key={JSON.stringify([owner, tab.id])}
              target={tab.target}
              active={owner === threadId && entry.activeId === tab.id}
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
  active,
  close,
  ask,
  browserSuspended,
  browserActivityBubble
}: {
  target: ReaderTarget
  active: boolean
  close: () => void
  ask: () => void
  browserSuspended: boolean
  browserActivityBubble?: BrowserAutomationActivityBubbleState | null
}): React.JSX.Element {
  const threadId = target.threadId
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
      <header className="content-reader-header">
        <span className="content-reader-title" title={title}>
          {target.kind === 'image' ? (
            <ImageIcon size={14} />
          ) : target.kind === 'diff' ? (
            <FileDiff size={14} />
          ) : target.kind === 'web' ? (
            <Globe size={14} />
          ) : (
            <FileText size={14} />
          )}
          <span>{title}</span>
        </span>
        <div className="content-reader-tools">
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
        </div>
      </header>
      <div className="content-reader-body">
        {target.kind === 'web' ? (
          <BrowserTimelineView
            threadId={threadId}
            sessionId={target.session}
            activityBubble={browserActivityBubble}
            activitySession={{
              session: target.session,
              url: target.url,
              title: target.title,
              updatedAt: ''
            }}
            suspended={!active || browserSuspended}
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
