import { useEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'

import type { BrowserActivitySession } from '../lib/browser-activity/browserActivity'
import { getBrowserSessionLabel } from '../lib/browser-activity/browserSessionLabel'

export type MessageTimelineSurface = 'timeline' | 'browser'

interface TimelineSurfaceHeaderProps {
  activeSurface: MessageTimelineSurface
  browserSessions: BrowserActivitySession[]
  selectedBrowserSession: string | null
  browserSessionMenuOpen: boolean
  onActiveSurfaceChange: (surface: MessageTimelineSurface) => void
  onBrowserSessionMenuOpenChange?: (open: boolean) => void
}

function BrowserSessionTrigger({
  sessions,
  selectedSession,
  open,
  onOpenChange
}: {
  sessions: BrowserActivitySession[]
  selectedSession: string | null
  open: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element | null {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = sessions.find((session) => session.session === selectedSession) ?? sessions[0]

  useEffect(() => {
    return () => onOpenChange?.(false)
  }, [onOpenChange])

  if (!selected) return null

  return (
    <button
      ref={triggerRef}
      type="button"
      className="message-surface-session-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => onOpenChange?.(!open)}
    >
      <span className="message-surface-session-trigger__label">
        {getBrowserSessionLabel(selected)}
      </span>
      <ChevronDown size={13} strokeWidth={2} />
    </button>
  )
}

export function TimelineSurfaceHeader({
  activeSurface,
  browserSessions,
  selectedBrowserSession,
  browserSessionMenuOpen,
  onActiveSurfaceChange,
  onBrowserSessionMenuOpenChange
}: TimelineSurfaceHeaderProps): React.JSX.Element {
  return (
    <div className="message-surface-header">
      <div className="message-surface-tabs" role="tablist" aria-label="Thread surface">
        <button
          type="button"
          className="message-surface-tab"
          data-active={activeSurface === 'timeline'}
          role="tab"
          aria-selected={activeSurface === 'timeline'}
          onClick={() => onActiveSurfaceChange('timeline')}
        >
          Conversation
        </button>
        <button
          type="button"
          className="message-surface-tab"
          data-active={activeSurface === 'browser'}
          role="tab"
          aria-selected={activeSurface === 'browser'}
          onClick={() => onActiveSurfaceChange('browser')}
        >
          Browser
        </button>
      </div>
      {activeSurface === 'browser' && browserSessions.length > 1 ? (
        <BrowserSessionTrigger
          sessions={browserSessions}
          selectedSession={selectedBrowserSession}
          open={browserSessionMenuOpen}
          onOpenChange={onBrowserSessionMenuOpenChange}
        />
      ) : null}
    </div>
  )
}
