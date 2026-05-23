import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

import type { BrowserActivitySession } from '../lib/browserActivity'

export type MessageTimelineSurface = 'timeline' | 'browser'

interface TimelineSurfaceHeaderProps {
  activeSurface: MessageTimelineSurface
  browserSessions: BrowserActivitySession[]
  selectedBrowserSession: string | null
  onActiveSurfaceChange: (surface: MessageTimelineSurface) => void
  onSelectedBrowserSessionChange: (session: string | null) => void
}

function getBrowserSessionLabel(session: BrowserActivitySession): string {
  return session.title?.trim() || session.session
}

function BrowserSessionDropdown({
  sessions,
  selectedSession,
  onSelect
}: {
  sessions: BrowserActivitySession[]
  selectedSession: string | null
  onSelect: (session: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = sessions.find((session) => session.session === selectedSession) ?? sessions[0]

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  if (!selected) return null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="message-surface-session-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          const rect = triggerRef.current?.getBoundingClientRect() ?? null
          setTriggerRect(rect)
          setOpen((value) => !value)
        }}
      >
        <span className="message-surface-session-trigger__label">
          {getBrowserSessionLabel(selected)}
        </span>
        <ChevronDown size={13} strokeWidth={2} />
      </button>
      {open && triggerRect
        ? createPortal(
            <div
              ref={menuRef}
              className="message-surface-session-menu"
              role="listbox"
              style={{
                top: triggerRect.bottom + 6,
                left: triggerRect.left,
                width: triggerRect.width
              }}
            >
              {sessions.map((session) => {
                const isSelected = session.session === selected.session
                return (
                  <button
                    key={session.session}
                    type="button"
                    className="message-surface-session-option"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onSelect(session.session)
                      setOpen(false)
                    }}
                  >
                    <span className="message-surface-session-option__text">
                      <span className="message-surface-session-option__label">
                        {getBrowserSessionLabel(session)}
                      </span>
                      {session.url ? (
                        <span className="message-surface-session-option__url">{session.url}</span>
                      ) : null}
                    </span>
                    {isSelected ? <Check size={13} strokeWidth={2.4} /> : null}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

export function TimelineSurfaceHeader({
  activeSurface,
  browserSessions,
  selectedBrowserSession,
  onActiveSurfaceChange,
  onSelectedBrowserSessionChange
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
          Timeline
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
        <BrowserSessionDropdown
          sessions={browserSessions}
          selectedSession={selectedBrowserSession}
          onSelect={onSelectedBrowserSessionChange}
        />
      ) : null}
    </div>
  )
}
