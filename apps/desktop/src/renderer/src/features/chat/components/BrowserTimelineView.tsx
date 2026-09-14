import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'

import type { BrowserActivitySession } from '../lib/browser-activity/browserActivity'
import { getBrowserSessionLabel } from '../lib/browser-activity/browserSessionLabel'
import type {
  BrowserAutomationActivityBubbleState,
  BrowserAutomationOverlayTheme
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
  sessionId,
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
  const requestedSessionRef = useRef<{ threadId: string; session: string } | null>(null)
  const requestSeqRef = useRef(0)
  const activityBubbleRef = useRef<BrowserAutomationActivityBubbleState | null>(
    activityBubble ?? null
  )
  const [error, setError] = useState<string | null>(null)

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
      if (!element || !sessionId || suspended || sessionPickerOpen) {
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
    [hideRequestedSession, sessionId, sessionPickerOpen, suspended, t, threadId]
  )

  useLayoutEffect(() => {
    syncBrowserView('show')
    return hideRequestedSession
  }, [hideRequestedSession, syncBrowserView])

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
    <div className="browser-timeline-view">
      <div className="browser-timeline-view__chrome">
        <div className="browser-timeline-view__title">
          {activitySession?.title ?? activitySession?.url ?? sessionId}
        </div>
        {activitySession?.url ? (
          <div className="browser-timeline-view__url">{activitySession.url}</div>
        ) : null}
      </div>
      <div className="browser-timeline-view__viewport-shell">
        <div ref={viewportRef} className="browser-timeline-view__viewport" />
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
        {error ? <div className="browser-timeline-view__error">{error}</div> : null}
      </div>
    </div>
  )
}
