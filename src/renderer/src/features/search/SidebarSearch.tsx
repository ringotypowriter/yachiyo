import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ThreadSearchResult } from '../../../../shared/yachiyo/protocol'
import { theme } from '@renderer/theme/theme'

interface Segment {
  text: string
  highlighted: boolean
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[(.+?)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
}

function splitHighlight(text: string, query: string): Segment[] {
  if (!query) return [{ text, highlighted: false }]
  const lower = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const segments: Segment[] = []
  let offset = 0
  while (offset < text.length) {
    const idx = lower.indexOf(lowerQuery, offset)
    if (idx < 0) {
      segments.push({ text: text.slice(offset), highlighted: false })
      break
    }
    if (idx > offset) segments.push({ text: text.slice(offset, idx), highlighted: false })
    segments.push({ text: text.slice(idx, idx + query.length), highlighted: true })
    offset = idx + query.length
  }
  return segments
}

function HighlightedText({ text, query }: { text: string; query: string }): React.JSX.Element {
  return (
    <>
      {splitHighlight(text, query).map((seg, i) =>
        seg.highlighted ? (
          <mark
            key={i}
            style={{
              background: theme.background.accentPanel,
              color: theme.text.accentStrong,
              borderRadius: '2px',
              padding: '0 1px',
              fontWeight: 600
            }}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}

type SelectableItem =
  | { kind: 'thread'; threadId: string }
  | { kind: 'message'; threadId: string; messageId: string }

interface SidebarSearchProps {
  onClose: () => void
  onSelectThread: (threadId: string, query: string) => void
  onSelectMessage: (threadId: string, messageId: string, query: string) => void
}

export function SidebarSearch({
  onClose,
  onSelectThread,
  onSelectMessage
}: SidebarSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ThreadSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  const flatItems = useMemo<SelectableItem[]>(() => {
    const items: SelectableItem[] = []
    for (const result of results) {
      if (result.titleMatched && result.messageMatches.length === 0) {
        items.push({ kind: 'thread', threadId: result.threadId })
      }
      for (const m of result.messageMatches) {
        items.push({ kind: 'message', threadId: result.threadId, messageId: m.messageId })
      }
    }
    return items
  }, [results])

  // Reset focus when results change
  useEffect(() => {
    setFocusedIndex(-1)
    itemRefs.current.clear()
  }, [results])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    itemRefs.current.get(focusedIndex)?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)
    const timeout = setTimeout(async () => {
      try {
        const res = await window.api.yachiyo.searchThreadsAndMessages({ query: trimmed })
        setResults(res)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 280)

    return () => clearTimeout(timeout)
  }, [query])

  function selectItem(item: SelectableItem): void {
    if (item.kind === 'thread') {
      onSelectThread(item.threadId, query.trim())
    } else {
      onSelectMessage(item.threadId, item.messageId, query.trim())
    }
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (flatItems.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex((i) => (i + 1) % flatItems.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex((i) => (i <= 0 ? flatItems.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[focusedIndex >= 0 ? focusedIndex : 0]
      if (item) selectItem(item)
    }
  }

  // Build a flat index counter per result for mapping to focusedIndex
  let itemIdx = 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 shrink-0"
        style={{
          height: '40px',
          borderBottom: `1px solid ${theme.border.subtle}`
        }}
      >
        <Search size={13} style={{ color: theme.icon.muted, flexShrink: 0 }} strokeWidth={1.5} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Search chats…"
          className="flex-1 bg-transparent text-sm outline-none min-w-0"
          style={{
            color: theme.text.primary,
            fontFamily: theme.font.ui
          }}
        />
        <button
          onClick={onClose}
          className="p-1 rounded opacity-40 hover:opacity-70 transition-opacity shrink-0"
          style={{ color: theme.icon.default }}
          title="Close search"
          aria-label="Close search"
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="px-4 py-3 text-xs" style={{ color: theme.text.muted }}>
            Searching…
          </p>
        )}

        {!loading && query.trim() && results.length === 0 && (
          <p className="px-4 py-3 text-xs" style={{ color: theme.text.muted }}>
            No results
          </p>
        )}

        {!loading &&
          results.map((result) => {
            const threadItemIdx =
              result.titleMatched && result.messageMatches.length === 0 ? itemIdx++ : -1

            return (
              <div key={result.threadId} className="py-1 px-1">
                {result.titleMatched && result.messageMatches.length === 0 ? (
                  <button
                    ref={(el) => {
                      if (el) itemRefs.current.set(threadItemIdx, el)
                    }}
                    onClick={() => onSelectThread(result.threadId, query.trim())}
                    className="w-full text-left px-2 py-1 rounded-md no-drag"
                    style={{
                      background:
                        focusedIndex === threadItemIdx
                          ? theme.background.hoverStrong
                          : 'transparent'
                    }}
                    onMouseEnter={(e) => {
                      ;(e.currentTarget as HTMLElement).style.background = theme.background.hover
                    }}
                    onMouseLeave={(e) => {
                      ;(e.currentTarget as HTMLElement).style.background =
                        focusedIndex === threadItemIdx
                          ? theme.background.hoverStrong
                          : 'transparent'
                    }}
                  >
                    <span
                      className="block text-xs font-semibold truncate"
                      style={{ color: theme.text.tertiary }}
                    >
                      <HighlightedText text={result.threadTitle} query={query.trim()} />
                    </span>
                  </button>
                ) : (
                  <div className="px-2 py-1">
                    <span
                      className="block text-xs font-semibold truncate"
                      style={{ color: theme.text.tertiary }}
                    >
                      <HighlightedText text={result.threadTitle} query={query.trim()} />
                    </span>
                  </div>
                )}
                {result.messageMatches.map((m) => {
                  const msgItemIdx = itemIdx++
                  return (
                    <button
                      key={m.messageId}
                      ref={(el) => {
                        if (el) itemRefs.current.set(msgItemIdx, el)
                      }}
                      onClick={() => onSelectMessage(result.threadId, m.messageId, query.trim())}
                      className="w-full text-left px-2 py-1 rounded-md no-drag"
                      style={{
                        background:
                          focusedIndex === msgItemIdx ? theme.background.hoverStrong : 'transparent'
                      }}
                      onMouseEnter={(e) => {
                        ;(e.currentTarget as HTMLElement).style.background = theme.background.hover
                      }}
                      onMouseLeave={(e) => {
                        ;(e.currentTarget as HTMLElement).style.background =
                          focusedIndex === msgItemIdx ? theme.background.hoverStrong : 'transparent'
                      }}
                    >
                      <span
                        className="block text-xs truncate"
                        style={{ color: theme.text.secondary }}
                      >
                        <HighlightedText text={stripMarkdown(m.snippet)} query={query.trim()} />
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
      </div>
    </div>
  )
}
