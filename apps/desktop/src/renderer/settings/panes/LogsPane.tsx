import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownToLine, FolderOpen } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { theme, alpha } from '@renderer/theme/theme'
import type { AppLogEntry, AppLogLevel } from '@yachiyo/shared/appLogs'
import { SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'
import { filterAppLogEntries, mergeAppLogReads, type LogLevelFilter } from './logsPaneModel'

const POLL_INTERVAL_MS = 2000
const FOLLOW_BOTTOM_THRESHOLD_PX = 48

function levelColor(level: AppLogLevel): string {
  if (level === 'error') return theme.text.danger
  if (level === 'warn') return theme.text.warning
  return theme.text.tertiary
}

export function LogsPane(): React.ReactNode {
  const t = useT()
  const [entries, setEntries] = useState<AppLogEntry[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [level, setLevel] = useState<LogLevelFilter>('all')
  const [query, setQuery] = useState('')
  const [following, setFollowing] = useState(true)
  const cursorRef = useRef<number | null>(null)
  const followingRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  followingRef.current = following

  const filtered = useMemo(
    () => filterAppLogEntries(entries, { level, query }),
    [entries, level, query]
  )

  const scrollToLatest = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
    })
  }, [])

  useEffect(() => {
    let disposed = false
    let inFlight = false

    const poll = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await window.api.appLogs.read(
          cursorRef.current === null ? undefined : { afterByte: cursorRef.current }
        )
        if (disposed) return
        cursorRef.current = result.cursor
        setLoadFailed(false)
        setEntries((existing) => mergeAppLogReads(existing, result))
        if (followingRef.current && (result.entries.length > 0 || result.reset)) {
          scrollToLatest()
        }
      } catch {
        if (!disposed) setLoadFailed(true)
      } finally {
        inFlight = false
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [scrollToLatest])

  // Keep the view pinned to the tail while following, even when filters change.
  useEffect(() => {
    if (following) scrollToLatest()
  }, [following, filtered.length, scrollToLatest])

  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    setFollowing(distanceFromBottom <= FOLLOW_BOTTOM_THRESHOLD_PX)
  }, [])

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 20
  })

  const levelOptions = [
    { value: 'all' as const, label: t('settings.logs.levelAll') },
    { value: 'info' as const, label: t('settings.logs.levelInfo') },
    { value: 'warn' as const, label: t('settings.logs.levelWarn') },
    { value: 'error' as const, label: t('settings.logs.levelError') }
  ]

  const emptyText = loadFailed
    ? t('settings.logs.loadError')
    : entries.length === 0
      ? t('settings.logs.empty')
      : filtered.length === 0
        ? t('settings.logs.emptyFiltered')
        : null

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-6 pt-5 pb-3">
        <SimpleSelect value={level} options={levelOptions} onChange={setLevel} width={170} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('settings.logs.searchPlaceholder')}
          className="flex-1 h-8 rounded-lg px-3 text-[13px] outline-none"
          style={inputStyle()}
        />
        <button
          type="button"
          title={t('settings.logs.openFolder')}
          aria-label={t('settings.logs.openFolder')}
          onClick={() => void window.api.runtimeHealth.openLogs()}
          className="flex items-center justify-center h-8 w-8 rounded-lg cursor-pointer"
          style={{ background: alpha('ink', 0.04), color: theme.text.secondary, border: 'none' }}
        >
          <FolderOpen size={15} />
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-6 pb-4 font-mono text-[11px] leading-[1.7]"
        >
          {emptyText ? (
            <div
              className="flex items-center justify-center h-full text-[13px] font-sans"
              style={{ color: theme.text.muted }}
            >
              {emptyText}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const entry = filtered[virtualRow.index]
                if (!entry) return null
                return (
                  <div
                    key={virtualRow.index}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full flex gap-2"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <span className="shrink-0 select-none" style={{ color: theme.text.muted }}>
                      {entry.timestamp}
                    </span>
                    <span
                      className="shrink-0 w-[42px] uppercase font-semibold"
                      style={{ color: levelColor(entry.level) }}
                    >
                      {entry.level}
                    </span>
                    <span
                      className="whitespace-pre-wrap break-all"
                      style={{ color: theme.text.primary }}
                    >
                      {entry.message}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {!following && filtered.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setFollowing(true)
              scrollToLatest()
            }}
            className="absolute bottom-4 right-6 flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] cursor-pointer"
            style={{
              background: theme.background.surface,
              border: `1px solid ${theme.border.panel}`,
              boxShadow: theme.shadow.panel,
              color: theme.text.secondary
            }}
          >
            <ArrowDownToLine size={13} />
            {t('settings.logs.jumpToLatest')}
          </button>
        )}
      </div>
    </div>
  )
}
