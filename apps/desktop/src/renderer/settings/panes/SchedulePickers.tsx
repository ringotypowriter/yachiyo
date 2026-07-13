import { useEffect, useRef, useState } from 'react'
import { CalendarClock, CalendarDays } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useLocale, useT } from '@yachiyo/i18n/react'
import { theme, alpha } from '@renderer/theme/theme'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'
import { SimpleSelect } from '../components/primitives'
import { weekdayLabels } from './scheduleTimeFormat'

// ---------------------------------------------------------------------------
// Quick-pick schedule widget
// ---------------------------------------------------------------------------

interface CronQuickPickProps {
  value?: string
  onPick: (cron: string) => void
}

type BuilderMode = 'interval' | 'hourly' | 'daily' | 'weekly'

const INTERVAL_OPTIONS = [5, 10, 15, 30, 45] as const
const BUILDER_MODE_VALUES: BuilderMode[] = ['interval', 'hourly', 'daily', 'weekly']

function builderToCron(
  mode: BuilderMode,
  hour: number,
  minute: number,
  interval: number,
  days: number[]
): string {
  switch (mode) {
    case 'interval':
      return `*/${interval} * * * *`
    case 'hourly':
      return `${minute} * * * *`
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekly': {
      const d = days.length > 0 ? days.sort((a, b) => a - b).join(',') : '1'
      return `${minute} ${hour} * * ${d}`
    }
  }
}

function cronToBuilder(
  cron: string
): { mode: BuilderMode; hour: string; minute: string; interval: number; days: number[] } | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minStr, hourStr, , , dowStr] = parts

  // Interval: */n * * * *
  if (minStr.startsWith('*/') && hourStr === '*' && dowStr === '*') {
    const n = parseInt(minStr.slice(2), 10)
    if (!isNaN(n) && INTERVAL_OPTIONS.includes(n as (typeof INTERVAL_OPTIONS)[number])) {
      return { mode: 'interval', hour: '0', minute: '0', interval: n, days: [] }
    }
  }

  // Hourly: m * * * *
  if (!minStr.includes('*') && !minStr.includes('/') && hourStr === '*' && dowStr === '*') {
    return { mode: 'hourly', hour: '0', minute: minStr, interval: 30, days: [] }
  }

  // Daily: m h * * *
  if (
    !minStr.includes('*') &&
    !minStr.includes('/') &&
    !hourStr.includes('*') &&
    !hourStr.includes('/') &&
    dowStr === '*'
  ) {
    return { mode: 'daily', hour: hourStr, minute: minStr, interval: 30, days: [] }
  }

  // Weekdays: m h * * 1-5
  if (
    !minStr.includes('*') &&
    !minStr.includes('/') &&
    !hourStr.includes('*') &&
    !hourStr.includes('/') &&
    dowStr === '1-5'
  ) {
    return { mode: 'weekly', hour: hourStr, minute: minStr, interval: 30, days: [1, 2, 3, 4, 5] }
  }

  // Weekly: m h * * d1,d2,...
  if (
    !minStr.includes('*') &&
    !minStr.includes('/') &&
    !hourStr.includes('*') &&
    !hourStr.includes('/') &&
    /^[\d,]+$/.test(dowStr)
  ) {
    const days = dowStr
      .split(',')
      .map((d) => parseInt(d, 10))
      .filter((d) => !isNaN(d) && d >= 0 && d <= 6)
    if (days.length > 0) {
      return { mode: 'weekly', hour: hourStr, minute: minStr, interval: 30, days }
    }
  }

  return null
}

export function CronQuickPick({ value, onPick }: CronQuickPickProps): React.ReactNode {
  const t = useT()
  const locale = useLocale()
  const builderModeLabels: Record<BuilderMode, string> = {
    interval: t('settings.schedule.builder.minutes'),
    hourly: t('settings.schedule.builder.hourly'),
    daily: t('settings.schedule.builder.daily'),
    weekly: t('settings.schedule.builder.weekly')
  }
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { floatingRef: panelRef, style: panelPositionStyle } = useFloatingPanelLayout({
    open,
    referenceRef: btnRef,
    width: 256,
    maxHeight: 420,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 6
  })
  useRestoreFocusOnUnmount(open)

  const [mode, setMode] = useState<BuilderMode>('daily')
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('0')
  const [interval, setInterval] = useState(30)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])

  function handleOpen(): void {
    const parsed = value ? cronToBuilder(value) : null
    if (parsed) {
      setMode(parsed.mode)
      setHour(parsed.hour)
      setMinute(parsed.minute)
      setInterval(parsed.interval)
      setDays(parsed.days)
    }
    setOpen(true)
  }

  function handleApply(): void {
    onPick(builderToCron(mode, Number(hour), Number(minute), interval, days))
    setOpen(false)
  }

  function toggleDay(d: number): void {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as Node
      if (!btnRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open, panelRef])

  const preview = builderToCron(mode, Number(hour), Number(minute), interval, days)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={t('settings.schedule.builder.title')}
        className="flex items-center justify-center rounded-md shrink-0"
        style={{
          width: 32,
          height: 32,
          background: open ? alpha('accent', 0.12) : alpha('ink', 0.04),
          color: open ? theme.text.accent : theme.text.tertiary,
          border: 'none'
        }}
        onClick={() => (open ? setOpen(false) : handleOpen())}
      >
        <CalendarClock size={15} />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              ...panelPositionStyle,
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 12,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: theme.shadow.menu,
              padding: 10,
              overflowY: 'auto',
              overscrollBehavior: 'contain'
            }}
          >
            {/* Mode segmented control */}
            <div className="flex rounded-lg p-0.5" style={{ background: alpha('ink', 0.05) }}>
              {BUILDER_MODE_VALUES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="flex-1 py-1.5 rounded-md text-[11px] font-medium transition-all"
                  style={{
                    background: mode === m ? theme.background.surface : 'transparent',
                    color: mode === m ? theme.text.primary : theme.text.tertiary,
                    border: 'none',
                    boxShadow: mode === m ? theme.shadow.button : 'none'
                  }}
                  onClick={() => setMode(m)}
                >
                  {builderModeLabels[m]}
                </button>
              ))}
            </div>

            {/* Body — consistent height container */}
            <div className="py-3 flex flex-col gap-2.5">
              {/* Interval */}
              {mode === 'interval' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs shrink-0" style={{ color: theme.text.secondary }}>
                    {t('settings.schedule.builder.every')}
                  </span>
                  <div className="flex gap-1 flex-1">
                    {INTERVAL_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className="flex-1 py-1.5 rounded-md text-[11px] font-medium "
                        style={{
                          background: interval === n ? alpha('accent', 0.14) : alpha('ink', 0.04),
                          color: interval === n ? theme.text.accent : theme.text.secondary,
                          border: 'none'
                        }}
                        onClick={() => setInterval(n)}
                      >
                        {t('settings.schedule.builder.minuteOption', { minutes: n })}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Hourly */}
              {mode === 'hourly' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs shrink-0" style={{ color: theme.text.secondary }}>
                    {t('settings.schedule.builder.atMinute')}
                  </span>
                  <SimpleSelect
                    value={minute}
                    options={[0, 5, 10, 15, 20, 30, 45].map((m) => ({
                      value: String(m),
                      label: `:${String(m).padStart(2, '0')}`
                    }))}
                    onChange={setMinute}
                    width="100%"
                  />
                </div>
              )}

              {/* Daily / Weekly */}
              {(mode === 'daily' || mode === 'weekly') && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs shrink-0" style={{ color: theme.text.secondary }}>
                      {t('settings.schedule.builder.time')}
                    </span>
                    <SimpleSelect
                      value={hour}
                      options={Array.from({ length: 24 }, (_, i) => ({
                        value: String(i),
                        label: String(i).padStart(2, '0')
                      }))}
                      onChange={setHour}
                      width="100%"
                    />
                    <span className="text-xs font-medium" style={{ color: theme.text.tertiary }}>
                      :
                    </span>
                    <SimpleSelect
                      value={minute}
                      options={[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => ({
                        value: String(m),
                        label: String(m).padStart(2, '0')
                      }))}
                      onChange={setMinute}
                      width="100%"
                    />
                  </div>

                  {mode === 'weekly' && (
                    <div className="flex gap-0.75">
                      {weekdayLabels(locale, 'narrow').map((label, i) => {
                        const active = days.includes(i)
                        return (
                          <button
                            key={i}
                            type="button"
                            className="flex-1 py-1.5 rounded-md text-[11px] font-medium "
                            style={{
                              background: active ? alpha('accent', 0.14) : alpha('ink', 0.04),
                              color: active ? theme.text.accent : theme.text.tertiary,
                              border: 'none'
                            }}
                            onClick={() => toggleDay(i)}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div
              className="flex items-center justify-between pt-2"
              style={{ borderTop: `1px solid ${alpha('ink', 0.06)}` }}
            >
              <code className="text-[11px]" style={{ color: theme.text.tertiary }}>
                {preview}
              </code>
              <button
                type="button"
                className="px-3 py-1 rounded-md text-xs font-medium "
                style={{
                  background: alpha('accent', 0.12),
                  color: theme.text.accent,
                  border: 'none'
                }}
                onClick={handleApply}
              >
                {t('settings.schedule.builder.apply')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Date-time picker widget
// ---------------------------------------------------------------------------

function buildCalendarGrid(year: number, month: number): (number | null)[] {
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const grid: (number | null)[] = Array(firstDow).fill(null)
  for (let d = 1; d <= daysInMonth; d++) grid.push(d)
  while (grid.length % 7 !== 0) grid.push(null)
  return grid
}

export function DateTimePick({
  value,
  onPick
}: {
  value: string
  onPick: (dt: string) => void
}): React.ReactNode {
  const t = useT()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { floatingRef: panelRef, style: panelPositionStyle } = useFloatingPanelLayout({
    open,
    referenceRef: btnRef,
    width: 240,
    maxHeight: 340,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 6
  })
  useRestoreFocusOnUnmount(open)

  const [viewYear, setViewYear] = useState(new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(new Date().getMonth())
  const [selYear, setSelYear] = useState<number | null>(null)
  const [selMonth, setSelMonth] = useState<number | null>(null)
  const [selDay, setSelDay] = useState<number | null>(null)
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)

  function handleOpen(): void {
    const parsed = value ? new Date(value.replace(' ', 'T')) : null
    const base = parsed && !isNaN(parsed.getTime()) ? parsed : new Date()
    setViewYear(base.getFullYear())
    setViewMonth(base.getMonth())
    if (parsed && !isNaN(parsed.getTime())) {
      setSelYear(parsed.getFullYear())
      setSelMonth(parsed.getMonth())
      setSelDay(parsed.getDate())
      setHour(parsed.getHours())
      setMinute(Math.round(parsed.getMinutes() / 5) * 5)
    } else {
      setSelYear(base.getFullYear())
      setSelMonth(base.getMonth())
      setSelDay(base.getDate())
      setHour(base.getHours())
      setMinute(Math.round(base.getMinutes() / 5) * 5)
    }
    setOpen(true)
  }

  function handleApply(): void {
    if (selYear == null || selMonth == null || selDay == null) return
    const pad = (n: number): string => String(n).padStart(2, '0')
    onPick(`${selYear}-${pad(selMonth + 1)}-${pad(selDay)} ${pad(hour)}:${pad(minute)}`)
    setOpen(false)
  }

  function prevMonth(): void {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1)
      setViewMonth(11)
    } else setViewMonth((m) => m - 1)
  }
  function nextMonth(): void {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1)
      setViewMonth(0)
    } else setViewMonth((m) => m + 1)
  }

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as Node
      if (!btnRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open, panelRef])

  const grid = buildCalendarGrid(viewYear, viewMonth)
  const today = new Date()
  const isSelected = (d: number): boolean =>
    d === selDay && viewMonth === selMonth && viewYear === selYear
  const isToday = (d: number): boolean =>
    d === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear()

  const preview =
    selYear != null && selMonth != null && selDay != null
      ? `${selYear}-${String(selMonth + 1).padStart(2, '0')}-${String(selDay).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      : '—'

  const navBtn = (onClick: () => void, label: string): React.ReactNode => (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'default',
        color: theme.text.secondary,
        borderRadius: 6,
        width: 24,
        height: 24,
        fontSize: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {label}
    </button>
  )

  const stepBtn = (onClick: () => void, label: string): React.ReactNode => (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: alpha('ink', 0.05),
        border: 'none',
        cursor: 'default',
        color: theme.text.secondary,
        borderRadius: 5,
        width: 22,
        height: 22,
        fontSize: 13,
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}
    >
      {label}
    </button>
  )

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={t('settings.schedule.builder.dateTimePicker')}
        className="flex items-center justify-center rounded-md shrink-0"
        style={{
          width: 32,
          height: 32,
          background: open ? alpha('accent', 0.12) : alpha('ink', 0.04),
          color: open ? theme.text.accent : theme.text.tertiary,
          border: 'none'
        }}
        onClick={() => (open ? setOpen(false) : handleOpen())}
      >
        <CalendarDays size={15} />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              ...panelPositionStyle,
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 12,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: theme.shadow.menu,
              padding: 10,
              overflowY: 'auto',
              overscrollBehavior: 'contain'
            }}
          >
            {/* Month navigation */}
            <div className="flex items-center justify-between mb-2">
              {navBtn(prevMonth, '‹')}
              <span className="text-xs font-medium" style={{ color: theme.text.primary }}>
                {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
                  new Date(viewYear, viewMonth)
                )}
              </span>
              {navBtn(nextMonth, '›')}
            </div>

            {/* Weekday labels */}
            <div className="grid grid-cols-7 mb-1">
              {weekdayLabels(locale, 'narrow').map((l, i) => (
                <span
                  key={i}
                  className="text-center text-[10px] font-medium py-0.5"
                  style={{ color: theme.text.tertiary }}
                >
                  {l}
                </span>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((day, i) =>
                day == null ? (
                  <span key={i} />
                ) : (
                  <button
                    key={i}
                    type="button"
                    className="rounded-md text-[12px] py-1 "
                    style={{
                      background: isSelected(day) ? alpha('accent', 0.16) : 'transparent',
                      color: isSelected(day)
                        ? theme.text.accent
                        : isToday(day)
                          ? theme.text.accent
                          : theme.text.primary,
                      fontWeight: isSelected(day) || isToday(day) ? 600 : 400,
                      border:
                        isToday(day) && !isSelected(day)
                          ? `1px solid ${alpha('accent', 0.3)}`
                          : '1px solid transparent'
                    }}
                    onClick={() => {
                      setSelYear(viewYear)
                      setSelMonth(viewMonth)
                      setSelDay(day)
                    }}
                  >
                    {day}
                  </button>
                )
              )}
            </div>

            {/* Time steppers */}
            <div
              className="flex items-center gap-2 mt-3 pt-2.5"
              style={{ borderTop: `1px solid ${alpha('ink', 0.06)}` }}
            >
              <span className="text-xs shrink-0" style={{ color: theme.text.secondary }}>
                {t('settings.schedule.builder.time')}
              </span>
              <div className="flex items-center gap-1 flex-1">
                {stepBtn(() => setHour((h) => (h + 23) % 24), '−')}
                <span
                  className="flex-1 text-center text-xs font-medium tabular-nums"
                  style={{ color: theme.text.primary }}
                >
                  {String(hour).padStart(2, '0')}
                </span>
                {stepBtn(() => setHour((h) => (h + 1) % 24), '+')}
              </div>
              <span className="text-xs font-medium" style={{ color: theme.text.tertiary }}>
                :
              </span>
              <div className="flex items-center gap-1 flex-1">
                {stepBtn(() => setMinute((m) => (m - 5 + 60) % 60), '−')}
                <span
                  className="flex-1 text-center text-xs font-medium tabular-nums"
                  style={{ color: theme.text.primary }}
                >
                  {String(minute).padStart(2, '0')}
                </span>
                {stepBtn(() => setMinute((m) => (m + 5) % 60), '+')}
              </div>
            </div>

            {/* Footer */}
            <div
              className="flex items-center justify-between pt-2 mt-2"
              style={{ borderTop: `1px solid ${alpha('ink', 0.06)}` }}
            >
              <code className="text-[11px]" style={{ color: theme.text.tertiary }}>
                {preview}
              </code>
              <button
                type="button"
                className="px-3 py-1 rounded-md text-xs font-medium "
                style={{
                  background: selDay != null ? alpha('accent', 0.12) : alpha('ink', 0.06),
                  color: selDay != null ? theme.text.accent : theme.text.tertiary,
                  border: 'none'
                }}
                onClick={handleApply}
              >
                {t('settings.schedule.builder.apply')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
