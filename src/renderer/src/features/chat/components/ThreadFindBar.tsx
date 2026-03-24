import type React from 'react'
import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { FindMatch } from '../lib/threadFindBar'

export interface ThreadFindBarProps {
  matches: FindMatch[]
  currentIndex: number
  query: string
  onQueryChange: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function ThreadFindBar({
  matches,
  currentIndex,
  query,
  onQueryChange,
  onNext,
  onPrev,
  onClose
}: ThreadFindBarProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        onPrev()
      } else {
        onNext()
      }
    }
  }

  const hasQuery = query.trim().length >= 2
  const countLabel = hasQuery
    ? matches.length === 0
      ? 'No results'
      : `${currentIndex + 1} of ${matches.length}`
    : ''

  return (
    <div
      className="absolute flex items-center gap-1 px-2 py-1.5"
      style={{
        top: '52px',
        right: '12px',
        zIndex: 50,
        width: '280px',
        background: theme.background.surfaceFrosted,
        border: `1px solid ${theme.border.panel}`,
        borderRadius: '10px',
        boxShadow: theme.shadow.overlay,
        backdropFilter: 'blur(20px)'
      }}
    >
      <Search size={13} style={{ color: theme.icon.muted, flexShrink: 0 }} strokeWidth={1.5} />

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in thread…"
        className="flex-1 min-w-0 bg-transparent outline-none text-sm"
        style={{
          color: theme.text.primary,
          fontFamily: theme.font.ui
        }}
      />

      {countLabel ? (
        <span
          className="text-xs shrink-0 tabular-nums"
          style={{ color: matches.length === 0 ? theme.text.muted : theme.text.secondary }}
        >
          {countLabel}
        </span>
      ) : null}

      <button
        onClick={onPrev}
        disabled={matches.length === 0}
        className="p-0.5 rounded opacity-50 hover:opacity-80 disabled:opacity-25 transition-opacity"
        style={{ color: theme.icon.default }}
        aria-label="Previous match"
      >
        <ChevronUp size={14} strokeWidth={1.5} />
      </button>

      <button
        onClick={onNext}
        disabled={matches.length === 0}
        className="p-0.5 rounded opacity-50 hover:opacity-80 disabled:opacity-25 transition-opacity"
        style={{ color: theme.icon.default }}
        aria-label="Next match"
      >
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>

      <button
        onClick={onClose}
        className="p-0.5 rounded opacity-40 hover:opacity-70 transition-opacity"
        style={{ color: theme.icon.default }}
        aria-label="Close find bar"
      >
        <X size={13} strokeWidth={1.5} />
      </button>
    </div>
  )
}
