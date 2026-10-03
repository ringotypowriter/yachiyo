import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  RefreshCw,
  X,
  Hand,
  Play,
  MessageSquarePlus,
  Expand,
  Minimize2
} from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { SimpleSelect } from '../../../../settings/components/primitives'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useContentReaderStore } from '../state/useContentReaderStore'

import type { BrowserActivitySession } from '../lib/browser-activity/browserActivity'
import { getBrowserSessionLabel } from '../lib/browser-activity/browserSessionLabel'
import type {
  BrowserAutomationActivityBubbleState,
  BrowserAutomationOverlayTheme,
  BrowserAutomationSessionRecord,
  ControlBrowserAutomationSessionInput
} from '@yachiyo/shared/protocol'

interface BrowserTimelineViewProps {
  threadId: string
  sessionId: string | null
  activitySession?: BrowserActivitySession
  activityBubble?: BrowserAutomationActivityBubbleState | null
  suspended?: boolean
  sessions?: BrowserActivitySession[]
  sessionPickerOpen?: boolean
  onSelectedSessionChange?: (session: string) => void
  onSessionPickerOpenChange?: (open: boolean) => void
}

function getElementBounds(element: HTMLElement): {
  x: number
  y: number
  width: number
  height: number
} {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}

function readRgbVariable(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || undefined
}

function getOverlayTheme(): BrowserAutomationOverlayTheme {
  const theme: BrowserAutomationOverlayTheme = {}
  const entries = [
    ['accentRgb', '--yachiyo-rgb-accent'],
    ['accentStrongRgb', '--yachiyo-rgb-accent-strong'],
    ['surfaceRgb', '--yachiyo-rgb-surface'],
    ['inkRgb', '--yachiyo-rgb-ink'],
    ['textMutedRgb', '--yachiyo-rgb-text-muted'],
    ['scrimRgb', '--yachiyo-rgb-scrim']
  ] as const

  for (const [key, variable] of entries) {
    const value = readRgbVariable(variable)
    if (value) theme[key] = value
  }

  return theme
}

export function BrowserTimelineView({
  threadId,
  sessionId: initialSessionId,
  activitySession,
  activityBubble,
  suspended = false,
  sessions = [],
  sessionPickerOpen = false,
  onSelectedSessionChange,
  onSessionPickerOpenChange
}: BrowserTimelineViewProps): React.JSX.Element {
  const t = useT()
  const viewportRef = useRef<HTMLDivElement>(null)
  const tabPickerRef = useRef<HTMLSpanElement>(null)
  const requestedSessionRef = useRef<{ threadId: string; session: string } | null>(null)
  const requestSeqRef = useRef(0)
  const refreshGenerationRef = useRef(0)
  const activityBubbleRef = useRef<BrowserAutomationActivityBubbleState | null>(
    activityBubble ?? null
  )
  const [error, setError] = useState<string | null>(null)
  const [viewAttempt, setViewAttempt] = useState(0)
  const [liveSessions, setLiveSessions] = useState<BrowserAutomationSessionRecord[]>([])
  const [tabOverride, setTabOverride] = useState<string | null>(null)
  const [closedSessionId, setClosedSessionId] = useState<string | null>(null)
  const [tabPickerOpen, setTabPickerOpen] = useState(false)
  const sessionId =
    tabOverride && liveSessions.some((entry) => entry.session === tabOverride)
      ? tabOverride
      : closedSessionId === initialSessionId
        ? null
        : initialSessionId
  useEffect(() => {
    setTabOverride(null)
    setClosedSessionId(null)
  }, [initialSessionId, threadId])
  const [address, setAddress] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  const [comment, setComment] = useState('')
  const [dismissedAnnotation, setDismissedAnnotation] = useState<string | null>(null)
  const [dialogText, setDialogText] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const live = liveSessions.find((entry) => entry.session === sessionId)
  const annotationKey = live?.annotation ? JSON.stringify([sessionId, live.annotation]) : null
  const pageUrl = live?.url ?? activitySession?.url ?? ''

  useEffect(() => {
    if (!editingAddress) setAddress(pageUrl)
  }, [editingAddress, pageUrl])

  useEffect(() => {
    setDialogText(live?.dialog?.defaultPrompt ?? '')
  }, [live?.dialog?.message, live?.dialog?.defaultPrompt])

  useEffect(() => {
    const trigger = tabPickerRef.current?.querySelector('button')
    if (!trigger || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      setTabPickerOpen(trigger.getAttribute('aria-expanded') === 'true')
    })
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] })
    return () => observer.disconnect()
  }, [liveSessions.length])

  useEffect(() => {
    let cancelled = false
    let lastAppliedRequest = 0
    let nextRequest = 0
    const refresh = (): void => {
      const generation = refreshGenerationRef.current
      const request = ++nextRequest
      void window.api.yachiyo
        .listBrowserAutomationSessions({ threadId })
        .then((records) => {
          if (
            cancelled ||
            generation !== refreshGenerationRef.current ||
            request < lastAppliedRequest
          )
            return
          lastAppliedRequest = request
          setLiveSessions(records)
          if (closedSessionId && records.some((entry) => entry.session === closedSessionId)) {
            // Only a post-close refresh can reattach a session created with the same ID.
            setClosedSessionId(null)
          }
        })
        .catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [closedSessionId, threadId])

  const control = async (
    action: ControlBrowserAutomationSessionInput['action'],
    url?: string,
    text?: string
  ): Promise<void> => {
    if (!sessionId || busy) return
    if (action === 'annotate') setDismissedAnnotation(null)
    if (action === 'close') refreshGenerationRef.current += 1
    setBusy(true)
    try {
      const record = await window.api.yachiyo.controlBrowserAutomationSession({
        threadId,
        session: sessionId,
        action,
        url,
        text
      })
      setLiveSessions((previous) =>
        action === 'close'
          ? previous.filter((entry) => entry.session !== sessionId)
          : [...previous.filter((entry) => entry.session !== sessionId), record]
      )
      if (action === 'close') {
        refreshGenerationRef.current += 1
        setClosedSessionId(sessionId)
        const next = liveSessions.find((entry) => entry.session !== sessionId)?.session ?? null
        setTabOverride(next)
        if (next) onSelectedSessionChange?.(next)
      }
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Browser action failed.')
    } finally {
      setBusy(false)
    }
  }

  const sendAnnotation = (): void => {
    if (!live?.annotation || !comment.trim() || useAppStore.getState().activeThreadId !== threadId)
      return
    const { annotation } = live
    const target = {
      kind: 'web' as const,
      threadId,
      session: sessionId!,
      url: pageUrl,
      title: live.title
    }
    const reader = useContentReaderStore.getState()
    reader.open(target, { activate: false, resident: true })
    const tab = useContentReaderStore
      .getState()
      .conversations[threadId]?.tabs.find(
        (entry) => entry.target.kind === 'web' && entry.target.session === sessionId
      )
    if (tab) reader.ask(threadId, tab.id)
    const app = useAppStore.getState()
    const existing = app.composerDrafts[threadId]?.text ?? ''
    app.setComposerValue(
      [
        existing,
        `${comment}\n\nPage: ${pageUrl}\nTarget: ${annotation.text || annotation.selector || 'Selected area'} (${annotation.x}, ${annotation.y}, ${annotation.width} × ${annotation.height})`
      ]
        .filter(Boolean)
        .join('\n\n')
    )
    setDismissedAnnotation(annotationKey)
    setComment('')
  }

  const hideRequestedSession = useCallback((): void => {
    requestSeqRef.current += 1
    const requested = requestedSessionRef.current
    if (!requested) return
    requestedSessionRef.current = null
    void window.api.yachiyo.hideBrowserAutomationSession(requested).catch(() => {})
  }, [])

  const syncBrowserView = useCallback(
    (mode: 'show' | 'bounds'): void => {
      const element = viewportRef.current
      if (!element || !sessionId || suspended || sessionPickerOpen || tabPickerOpen) {
        hideRequestedSession()
        return
      }

      const bounds = getElementBounds(element)
      const requestSeq = ++requestSeqRef.current
      const input = {
        threadId,
        session: sessionId,
        bounds,
        overlay: { activityBubble: activityBubbleRef.current, theme: getOverlayTheme() }
      }
      // Cleanup owns the session as soon as show is sent, not when its promise settles.
      if (mode === 'show') requestedSessionRef.current = { threadId, session: sessionId }
      const operation =
        mode === 'show'
          ? window.api.yachiyo.showBrowserAutomationSession(input)
          : window.api.yachiyo.setBrowserAutomationSessionBounds(input)

      void operation
        .then(() => {
          if (requestSeq !== requestSeqRef.current) return
          setError(null)
        })
        .catch((err: unknown) => {
          if (requestSeq !== requestSeqRef.current) return
          hideRequestedSession()
          setError(err instanceof Error ? err.message : t('chat.browser.showSessionFailed'))
        })
    },
    [hideRequestedSession, sessionId, sessionPickerOpen, suspended, t, threadId, tabPickerOpen]
  )

  useLayoutEffect(() => {
    syncBrowserView('show')
    return hideRequestedSession
  }, [hideRequestedSession, syncBrowserView, viewAttempt])

  useEffect(() => {
    activityBubbleRef.current = activityBubble ?? null
    syncBrowserView('bounds')
  }, [activityBubble, syncBrowserView])

  useEffect(() => {
    const element = viewportRef.current
    if (!element || !sessionId) return

    const syncBounds = (): void => syncBrowserView('bounds')
    const observer = new ResizeObserver(syncBounds)
    observer.observe(element)
    window.addEventListener('resize', syncBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [sessionId, syncBrowserView])

  if (!sessionId) {
    return (
      <div className="browser-timeline-view browser-timeline-view--empty">
        <div className="browser-timeline-view__empty-card">
          <div className="browser-timeline-view__empty-title">{t('chat.browser.noSessions')}</div>
          <div className="browser-timeline-view__empty-copy">
            {t('chat.browser.sessionsAppearHere')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`browser-timeline-view${expanded ? ' browser-timeline-view--expanded' : ''}`}>
      <div className="browser-timeline-view__chrome">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={busy || !live?.canGoBack}
          onClick={() => void control('back')}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={busy || !live?.canGoForward}
          onClick={() => void control('forward')}
        >
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          disabled={busy}
          onClick={() => void control('reload')}
        >
          <RefreshCw size={15} />
        </button>
        <form
          className="browser-timeline-view__address"
          onSubmit={(event) => {
            event.preventDefault()
            setEditingAddress(false)
            if (address.trim()) void control('navigate', address.trim())
          }}
        >
          <input
            aria-label="Page address"
            value={address}
            onFocus={() => setEditingAddress(true)}
            onBlur={() => setEditingAddress(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        {liveSessions.length > 1 ? (
          <span
            ref={tabPickerRef}
            onPointerDownCapture={() => {
              hideRequestedSession()
              setTabPickerOpen(true)
            }}
            onKeyDownCapture={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                hideRequestedSession()
                setTabPickerOpen(true)
              }
            }}
          >
            <SimpleSelect
              ariaLabel="Browser tabs"
              value={sessionId}
              width={130}
              options={liveSessions.map((entry) => ({
                value: entry.session,
                label: entry.title || entry.url || entry.session
              }))}
              onChange={(next) => {
                setTabOverride(next)
                setTabPickerOpen(false)
                onSelectedSessionChange?.(next)
              }}
            />
          </span>
        ) : null}
        <span className="browser-timeline-view__status" role="status">
          {live?.loading
            ? 'Loading'
            : live?.controlledBy === 'user'
              ? 'Your control'
              : live?.controlledBy === 'agent'
                ? 'Agent control'
                : 'Browser ready'}
        </span>
        <button
          type="button"
          aria-label={expanded ? 'Restore browser' : 'Expand browser'}
          title={expanded ? 'Restore browser' : 'Expand browser'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 size={15} /> : <Expand size={15} />}
        </button>
        <button
          type="button"
          aria-label="Annotate page"
          title="Select element or area"
          disabled={busy}
          onClick={() => void control('annotate')}
        >
          <MessageSquarePlus size={15} />
        </button>
        <button
          type="button"
          aria-label={live?.controlledBy === 'user' ? 'Resume' : 'Take over'}
          title={live?.controlledBy === 'user' ? 'Resume' : 'Take over'}
          disabled={busy}
          onClick={() => void control(live?.controlledBy === 'user' ? 'resume' : 'takeOver')}
        >
          {live?.controlledBy === 'user' ? <Play size={15} /> : <Hand size={15} />}
        </button>
        <button
          type="button"
          aria-label="Close tab"
          title="Close tab"
          disabled={busy}
          onClick={() => void control('close')}
        >
          <X size={15} />
        </button>
      </div>
      {live?.annotation && annotationKey !== dismissedAnnotation ? (
        <div className="browser-timeline-view__notice browser-timeline-view__annotation">
          <span>Selected: {live.annotation.text || live.annotation.selector || 'Page area'}</span>
          <textarea
            aria-label="Annotation"
            placeholder="Tell Yachiyo about this selection"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button type="button" disabled={!comment.trim()} onClick={sendAnnotation}>
            Ask Yachiyo
          </button>
        </div>
      ) : null}
      {live?.dialog ? (
        <div className="browser-timeline-view__notice" role="alert">
          <span>{live.dialog.message}</span>
          {live.dialog.type === 'prompt' ? (
            <input
              aria-label="Dialog response"
              value={dialogText}
              placeholder={live.dialog.defaultPrompt}
              onChange={(event) => setDialogText(event.target.value)}
            />
          ) : null}
          <button type="button" onClick={() => void control('acceptDialog', undefined, dialogText)}>
            Accept
          </button>
          <button type="button" onClick={() => void control('dismissDialog')}>
            Dismiss
          </button>
        </div>
      ) : null}
      {live?.download ? (
        <div className="browser-timeline-view__notice" role="status">
          {live.download.fileName} · {live.download.state}{' '}
          {live.download.totalBytes > 0
            ? `${Math.round((100 * live.download.receivedBytes) / live.download.totalBytes)}%`
            : ''}
        </div>
      ) : null}
      {error || live?.error ? (
        <div className="browser-timeline-view__error" role="alert">
          {error || live?.error}
          <button
            type="button"
            onClick={() => {
              setError(null)
              setViewAttempt((attempt) => attempt + 1)
              void control('reload')
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div className="browser-timeline-view__viewport-shell">
        <div ref={viewportRef} className="browser-timeline-view__viewport" />
        {tabPickerOpen ? (
          <span className="browser-timeline-view__picker-placeholder">Select a tab</span>
        ) : null}
        {sessionPickerOpen && sessions.length > 1 ? (
          <div
            className="browser-session-picker"
            role="presentation"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) onSessionPickerOpenChange?.(false)
            }}
          >
            <div
              className="browser-session-picker__panel"
              role="listbox"
              aria-label={t('chat.browser.sessionsAria')}
            >
              {sessions.map((session) => {
                const isSelected = session.session === sessionId
                return (
                  <button
                    key={session.session}
                    type="button"
                    className="browser-session-picker__option"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onSelectedSessionChange?.(session.session)
                      onSessionPickerOpenChange?.(false)
                    }}
                  >
                    <span className="browser-session-picker__option-text">
                      <span className="browser-session-picker__option-label">
                        {getBrowserSessionLabel(session)}
                      </span>
                      {session.url ? (
                        <span className="browser-session-picker__option-url">{session.url}</span>
                      ) : null}
                    </span>
                    {isSelected ? <Check size={13} strokeWidth={2.4} /> : null}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
