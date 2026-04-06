import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, ChevronDown } from 'lucide-react'
import type { Message } from '@renderer/app/types'
import { theme, alpha } from '@renderer/theme/theme'

export interface TimelineScrollbarProps {
  messages: Message[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  onScrollToMessage: (messageId: string) => void
}

interface BarEntry {
  messageId: string
  role: 'user' | 'assistant'
  width: number
  snippet: string
}

/** Minimum / maximum width of a horizontal dash (px). */
const MIN_LINE_WIDTH = 4
const MAX_LINE_WIDTH = 18
/** Vertical gap between dashes and the fixed stroke height. */
const LINE_HEIGHT = 2
const LINE_GAP = 3
/** Overall track width that the scrollbar column occupies. */
const TRACK_WIDTH = 24
const PREVIEW_DELAY = 200

function hasVisibleContent(m: Message): boolean {
  if (m.content.trim().length > 0) return true
  if (m.images && m.images.length > 0) return true
  if (m.attachments && m.attachments.length > 0) return true
  return false
}

function buildBars(messages: Message[]): BarEntry[] {
  const visible = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && hasVisibleContent(m)
  )
  if (visible.length === 0) return []

  const lengths = visible.map((m) => Math.max(m.content.length, 1))
  const maxLen = Math.max(...lengths)

  return visible.map((m, i) => {
    const ratio = maxLen > 0 ? lengths[i] / maxLen : 0
    const width = Math.round(MIN_LINE_WIDTH + ratio * (MAX_LINE_WIDTH - MIN_LINE_WIDTH))

    let snippet: string
    const raw = m.content.replace(/\n+/g, ' ').trim()
    if (raw.length > 0) {
      snippet = raw.length > 80 ? raw.slice(0, 77) + '...' : raw
    } else if (m.images && m.images.length > 0) {
      const count = m.images.length
      snippet = count === 1 ? '1 image' : `${count} images`
    } else if (m.attachments && m.attachments.length > 0) {
      const count = m.attachments.length
      snippet = count === 1 ? '1 attachment' : `${count} attachments`
    } else {
      snippet = '(empty)'
    }

    return {
      messageId: m.id,
      role: m.role as 'user' | 'assistant',
      width,
      snippet
    }
  })
}

function PreviewPopup({
  bar,
  anchorRect
}: {
  bar: BarEntry
  anchorRect: DOMRect
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [top, setTop] = useState(anchorRect.top + anchorRect.height / 2)

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setVisible(true)
      if (ref.current) {
        const popupHeight = ref.current.offsetHeight
        const centeredTop = anchorRect.top + anchorRect.height / 2 - popupHeight / 2
        const clamped = Math.max(8, Math.min(centeredTop, window.innerHeight - popupHeight - 8))
        setTop(clamped)
      }
    })
    return () => cancelAnimationFrame(id)
  }, [anchorRect])

  const roleLabel = bar.role === 'user' ? 'You' : 'Assistant'

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        right: TRACK_WIDTH + 12,
        top,
        maxWidth: 260,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(4px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease',
        pointerEvents: 'none',
        zIndex: 9999,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 10,
        padding: '8px 12px',
        boxShadow: theme.shadow.menu
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
          color: bar.role === 'user' ? theme.text.accent : theme.text.tertiary,
          marginBottom: 3
        }}
      >
        {roleLabel}
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.45,
          color: theme.text.primary,
          wordBreak: 'break-word'
        }}
      >
        {bar.snippet}
      </div>
    </div>
  )
}

export function TimelineScrollbar({
  messages,
  scrollContainerRef,
  onScrollToMessage
}: TimelineScrollbarProps): React.JSX.Element | null {
  const bars = useMemo(() => buildBars(messages), [messages])
  const [isHovering, setIsHovering] = useState(false)
  const [previewBar, setPreviewBar] = useState<{
    bar: BarEntry
    rect: DOMRect
  } | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const currentBarIndexRef = useRef(bars.length - 1)

  // Keep current index valid when bars change
  useEffect(() => {
    if (currentBarIndexRef.current >= bars.length) {
      currentBarIndexRef.current = Math.max(0, bars.length - 1)
    }
  }, [bars.length])

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
  }, [])

  useEffect(() => clearPreviewTimer, [clearPreviewTimer])

  const navigateMessage = useCallback(
    (direction: 'prev' | 'next') => {
      if (bars.length === 0) return

      // Estimate current position from scroll percentage
      const container = scrollContainerRef.current
      if (container) {
        const maxScroll = container.scrollHeight - container.clientHeight
        if (maxScroll > 0) {
          const scrollRatio = container.scrollTop / maxScroll
          currentBarIndexRef.current = Math.round(scrollRatio * (bars.length - 1))
          currentBarIndexRef.current = Math.max(
            0,
            Math.min(bars.length - 1, currentBarIndexRef.current)
          )
        }
      }

      const targetIndex =
        direction === 'prev'
          ? Math.max(0, currentBarIndexRef.current - 1)
          : Math.min(bars.length - 1, currentBarIndexRef.current + 1)

      currentBarIndexRef.current = targetIndex
      onScrollToMessage(bars[targetIndex].messageId)
      setHighlightId(bars[targetIndex].messageId)
      setTimeout(() => setHighlightId(null), 600)
    },
    [bars, scrollContainerRef, onScrollToMessage]
  )

  function handleBarMouseEnter(bar: BarEntry, e: React.MouseEvent<HTMLDivElement>): void {
    clearPreviewTimer()
    const rect = e.currentTarget.getBoundingClientRect()
    previewTimerRef.current = setTimeout(() => {
      setPreviewBar({ bar, rect })
    }, PREVIEW_DELAY)
    setHighlightId(bar.messageId)
  }

  function handleBarMouseLeave(): void {
    clearPreviewTimer()
    setPreviewBar(null)
    setHighlightId(null)
  }

  function handleBarClick(bar: BarEntry): void {
    clearPreviewTimer()
    setPreviewBar(null)
    const index = bars.indexOf(bar)
    if (index >= 0) currentBarIndexRef.current = index
    onScrollToMessage(bar.messageId)
  }

  if (bars.length < 3) return null

  return (
    <div
      className="absolute top-0 bottom-0 right-0 flex flex-col items-end justify-center"
      style={{
        width: TRACK_WIDTH,
        zIndex: 10,
        opacity: isHovering ? 1 : 0.4,
        transition: 'opacity 0.2s ease'
      }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => {
        setIsHovering(false)
        handleBarMouseLeave()
      }}
    >
      {/* Up arrow */}
      <button
        onClick={() => navigateMessage('prev')}
        className="flex items-center justify-center cursor-pointer shrink-0"
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: 'none',
          background: 'transparent',
          color: theme.text.muted,
          opacity: isHovering ? 1 : 0,
          transition: 'opacity 0.15s ease',
          padding: 0,
          marginBottom: 6
        }}
      >
        <ChevronUp size={14} strokeWidth={2} />
      </button>

      {/* Dash track */}
      <div
        className="flex flex-col items-end overflow-hidden"
        style={{
          gap: LINE_GAP,
          maxHeight: 'calc(100% - 52px)',
          paddingRight: 3,
          overflowY: 'auto',
          scrollbarWidth: 'none'
        }}
      >
        {bars.map((bar) => {
          const isHighlighted = highlightId === bar.messageId
          return (
            <div
              key={bar.messageId}
              onMouseEnter={(e) => handleBarMouseEnter(bar, e)}
              onMouseLeave={handleBarMouseLeave}
              onClick={() => handleBarClick(bar)}
              className="shrink-0 cursor-pointer"
              style={{
                width: bar.width,
                height: LINE_HEIGHT,
                borderRadius: 1,
                background: isHighlighted ? theme.text.primary : alpha('ink', 0.18),
                transition: 'background 0.12s ease, width 0.12s ease',
                ...(isHighlighted ? { width: Math.min(bar.width + 4, MAX_LINE_WIDTH) } : {})
              }}
            />
          )
        })}
      </div>

      {/* Down arrow */}
      <button
        onClick={() => navigateMessage('next')}
        className="flex items-center justify-center cursor-pointer shrink-0"
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: 'none',
          background: 'transparent',
          color: theme.text.muted,
          opacity: isHovering ? 1 : 0,
          transition: 'opacity 0.15s ease',
          padding: 0,
          marginTop: 6
        }}
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>

      {/* Preview popup */}
      {previewBar
        ? createPortal(
            <PreviewPopup bar={previewBar.bar} anchorRect={previewBar.rect} />,
            document.body
          )
        : null}
    </div>
  )
}
