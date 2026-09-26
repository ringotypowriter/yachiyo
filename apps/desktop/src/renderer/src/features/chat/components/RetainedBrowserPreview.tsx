import { useEffect, useRef, useState } from 'react'
import type { BrowserAutomationActivityBubbleState } from '@yachiyo/shared/protocol'
import type { ReaderTarget } from '../lib/contentReader'
import type { PreviewReadingState } from '../lib/previewRetention'
import { BrowserTimelineView } from './BrowserTimelineView'

export function RetainedBrowserPreview({
  target,
  reading,
  suspended,
  activityBubble
}: {
  target: Extract<ReaderTarget, { kind: 'web' }>
  reading: PreviewReadingState
  suspended: boolean
  activityBubble?: BrowserAutomationActivityBubbleState | null
}): React.JSX.Element {
  const initial = useRef({ target, reading })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (suspended) return
    setReady(false)
    let cancelled = false
    const { target, reading } = initial.current
    void (async () => {
      try {
        const sessions = await window.api.yachiyo.listBrowserAutomationSessions({
          threadId: target.threadId
        })
        if (!sessions.some((session) => session.session === target.session)) {
          if (cancelled) return
          if (!target.url) throw new Error('The browser page is no longer available.')
          await window.api.yachiyo.openBrowserPreview({
            threadId: target.threadId,
            session: target.session,
            url: target.url,
            reading
          })
        }
        if (!cancelled) {
          setReady(true)
          setError(null)
        }
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : 'Unable to restore browser preview.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attempt, suspended])
  if (!ready)
    return (
      <div className="content-reader-notice" role={error ? 'alert' : 'status'}>
        {error ?? 'Loading web page…'}
        {error ? (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setAttempt((value) => value + 1)
            }}
          >
            Retry preview
          </button>
        ) : null}
      </div>
    )
  return (
    <BrowserTimelineView
      threadId={target.threadId}
      sessionId={target.session}
      suspended={suspended}
      activityBubble={activityBubble}
      activitySession={{
        session: target.session,
        url: target.url,
        title: target.title,
        updatedAt: ''
      }}
    />
  )
}
