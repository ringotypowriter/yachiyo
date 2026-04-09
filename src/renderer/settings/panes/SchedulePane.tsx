import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Clock, CalendarClock, CalendarDays } from 'lucide-react'
import { createPortal } from 'react-dom'
import { theme, alpha } from '@renderer/theme/theme'
import { inputStyle } from '../components/styles'
import { SettingSwitch, SimpleSelect } from '../components/primitives'
import type {
  CreateScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  SettingsConfig,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol'
import { buildScheduleFormSubmitInput, type ScheduleFormSubmitInput } from './schedulePaneModel'

// ---------------------------------------------------------------------------
// Human-friendly cron helpers
// ---------------------------------------------------------------------------

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [min, hour, , , dow] = parts
  const pad = (n: string): string => n.padStart(2, '0')

  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`
  if (!min.includes('*') && !min.includes('/') && hour === '*') return `Every hour at :${pad(min)}`
  if (
    !min.includes('*') &&
    !min.includes('/') &&
    !hour.includes('*') &&
    !hour.includes('/') &&
    dow === '*'
  )
    return `Daily at ${pad(hour)}:${pad(min)}`
  if (!min.includes('*') && !hour.includes('*') && dow === '1-5')
    return `Weekdays at ${pad(hour)}:${pad(min)}`
  if (!min.includes('*') && !hour.includes('*') && /^[\d,]+$/.test(dow)) {
    const dayNames = dow
      .split(',')
      .map((d) => DAY_LABELS[parseInt(d)] ?? d)
      .join(', ')
    return `${dayNames} at ${pad(hour)}:${pad(min)}`
  }

  return cron
}

// ---------------------------------------------------------------------------
// Quick-pick schedule widget
// ---------------------------------------------------------------------------

interface CronQuickPickProps {
  onPick: (cron: string) => void
}

type BuilderMode = 'interval' | 'hourly' | 'daily' | 'weekly'

const INTERVAL_OPTIONS = [5, 10, 15, 30, 45] as const
const BUILDER_MODES: { value: BuilderMode; label: string }[] = [
  { value: 'interval', label: 'Minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
]

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

function CronQuickPick({ onPick }: CronQuickPickProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [popupRect, setPopupRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const [mode, setMode] = useState<BuilderMode>('daily')
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('0')
  const [interval, setInterval] = useState(30)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])

  function handleOpen(): void {
    if (btnRef.current) setPopupRect(btnRef.current.getBoundingClientRect())
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
  }, [open])

  const preview = builderToCron(mode, Number(hour), Number(minute), interval, days)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Schedule builder"
        className="flex items-center justify-center rounded-md cursor-pointer shrink-0"
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
        popupRect &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: popupRect.bottom + 6,
              left: popupRect.right,
              transform: 'translateX(-100%)',
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 12,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: '0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06)',
              padding: 10,
              width: 256
            }}
          >
            {/* Mode segmented control */}
            <div className="flex rounded-lg p-0.5" style={{ background: alpha('ink', 0.05) }}>
              {BUILDER_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className="flex-1 py-1.5 rounded-md text-[11px] font-medium cursor-pointer transition-all"
                  style={{
                    background: mode === m.value ? theme.background.surface : 'transparent',
                    color: mode === m.value ? theme.text.primary : theme.text.tertiary,
                    border: 'none',
                    boxShadow: mode === m.value ? '0 1px 3px rgba(0,0,0,0.08)' : 'none'
                  }}
                  onClick={() => setMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Body — consistent height container */}
            <div className="py-3 flex flex-col gap-2.5">
              {/* Interval */}
              {mode === 'interval' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs shrink-0" style={{ color: theme.text.secondary }}>
                    Every
                  </span>
                  <div className="flex gap-1 flex-1">
                    {INTERVAL_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className="flex-1 py-1.5 rounded-md text-[11px] font-medium cursor-pointer"
                        style={{
                          background: interval === n ? alpha('accent', 0.14) : alpha('ink', 0.04),
                          color: interval === n ? theme.text.accent : theme.text.secondary,
                          border: 'none'
                        }}
                        onClick={() => setInterval(n)}
                      >
                        {n}m
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Hourly */}
              {mode === 'hourly' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs shrink-0" style={{ color: theme.text.secondary }}>
                    At minute
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
                      Time
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
                      {DAY_LABELS.map((label, i) => {
                        const active = days.includes(i)
                        return (
                          <button
                            key={i}
                            type="button"
                            className="flex-1 py-1.5 rounded-md text-[11px] font-medium cursor-pointer"
                            style={{
                              background: active ? alpha('accent', 0.14) : alpha('ink', 0.04),
                              color: active ? theme.text.accent : theme.text.tertiary,
                              border: 'none'
                            }}
                            onClick={() => toggleDay(i)}
                          >
                            {label[0]}
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
                className="px-3 py-1 rounded-md text-xs font-medium cursor-pointer"
                style={{
                  background: alpha('accent', 0.12),
                  color: theme.text.accent,
                  border: 'none'
                }}
                onClick={handleApply}
              >
                Apply
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

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

function buildCalendarGrid(year: number, month: number): (number | null)[] {
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const grid: (number | null)[] = Array(firstDow).fill(null)
  for (let d = 1; d <= daysInMonth; d++) grid.push(d)
  while (grid.length % 7 !== 0) grid.push(null)
  return grid
}

function DateTimePick({
  value,
  onPick
}: {
  value: string
  onPick: (dt: string) => void
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [popupPos, setPopupPos] = useState<{ top: number; left: number; flipUp: boolean } | null>(
    null
  )
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const [viewYear, setViewYear] = useState(new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(new Date().getMonth())
  const [selYear, setSelYear] = useState<number | null>(null)
  const [selMonth, setSelMonth] = useState<number | null>(null)
  const [selDay, setSelDay] = useState<number | null>(null)
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)

  const POPUP_H = 340

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
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const flipUp = r.bottom + 6 + POPUP_H > window.innerHeight
      setPopupPos({ top: flipUp ? r.top - POPUP_H - 6 : r.bottom + 6, left: r.right, flipUp })
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
  }, [open])

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
        cursor: 'pointer',
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
        cursor: 'pointer',
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
        title="Date & time picker"
        className="flex items-center justify-center rounded-md cursor-pointer shrink-0"
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
        popupPos &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: popupPos.top,
              left: popupPos.left,
              transform: 'translateX(-100%)',
              zIndex: 9999,
              background: theme.background.surface,
              borderRadius: 12,
              border: `1px solid ${theme.border.subtle}`,
              boxShadow: '0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06)',
              padding: 10,
              width: 240
            }}
          >
            {/* Month navigation */}
            <div className="flex items-center justify-between mb-2">
              {navBtn(prevMonth, '‹')}
              <span className="text-xs font-medium" style={{ color: theme.text.primary }}>
                {MONTH_NAMES[viewMonth]} {viewYear}
              </span>
              {navBtn(nextMonth, '›')}
            </div>

            {/* Weekday labels */}
            <div className="grid grid-cols-7 mb-1">
              {WEEKDAY_LABELS.map((l) => (
                <span
                  key={l}
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
                    className="rounded-md text-[12px] py-1 cursor-pointer"
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
                Time
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
                className="px-3 py-1 rounded-md text-xs font-medium cursor-pointer"
                style={{
                  background: selDay != null ? alpha('accent', 0.12) : alpha('ink', 0.06),
                  color: selDay != null ? theme.text.accent : theme.text.tertiary,
                  border: 'none',
                  cursor: selDay != null ? 'pointer' : 'default'
                }}
                onClick={handleApply}
              >
                Apply
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

interface SchedulePaneProps {
  activeSubTab: string
  onNavigateToTab?: (tab: string) => void
}

export function SchedulePane({
  activeSubTab,
  onNavigateToTab
}: SchedulePaneProps): React.ReactNode {
  if (activeSubTab === 'history') {
    return <HistorySubTab />
  }
  return <ScheduleListSubTab onNavigateToTab={onNavigateToTab} />
}

// ---------------------------------------------------------------------------
// Schedule List
// ---------------------------------------------------------------------------

function ScheduleListSubTab({
  onNavigateToTab
}: {
  onNavigateToTab?: (tab: string) => void
}): React.ReactNode {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo.listSchedules().then((list) => {
      if (!cancelled) {
        setSchedules(list)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      if (enabled) {
        await window.api.yachiyo.disableSchedule({ id })
      } else {
        await window.api.yachiyo.enableSchedule({ id })
      }
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      await window.api.yachiyo.deleteSchedule({ id })
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleCreate = useCallback(
    async (input: ScheduleFormSubmitInput) => {
      await window.api.yachiyo.createSchedule(input as CreateScheduleInput)
      setAdding(false)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleUpdate = useCallback(
    async (input: ScheduleFormSubmitInput & { id: string }) => {
      const { id, ...fields } = input
      await window.api.yachiyo.updateSchedule({ id, ...fields })
      setEditingId(null)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm" style={{ color: theme.text.muted }}>
          Loading...
        </span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: theme.text.secondary }}
        >
          Schedules
        </span>
        <button
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer"
          style={{
            background: alpha('ink', 0.06),
            color: theme.text.primary
          }}
          onClick={() => setAdding(true)}
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {adding && (
        <ScheduleForm
          onSubmit={handleCreate}
          onCancel={() => setAdding(false)}
          onNavigateToTab={onNavigateToTab}
        />
      )}

      {schedules.length === 0 && !adding && (
        <div className="flex flex-col items-center gap-2 py-8" style={{ opacity: 0.4 }}>
          <Clock size={24} stroke={theme.icon.muted} />
          <span className="text-sm" style={{ color: theme.text.muted }}>
            No schedules yet
          </span>
        </div>
      )}

      {schedules.map((s) =>
        editingId === s.id ? (
          <ScheduleForm
            key={s.id}
            initial={s}
            onSubmit={(input) => handleUpdate({ ...input, id: s.id })}
            onCancel={() => setEditingId(null)}
            onNavigateToTab={onNavigateToTab}
            submitLabel="Save"
          />
        ) : (
          <ScheduleRow
            key={s.id}
            schedule={s}
            onToggle={() => handleToggle(s.id, s.enabled)}
            onDelete={() => handleDelete(s.id)}
            onEdit={() => setEditingId(s.id)}
          />
        )
      )}
    </div>
  )
}

function ScheduleRow({
  schedule,
  onToggle,
  onDelete,
  onEdit
}: {
  schedule: ScheduleRecord
  onToggle: () => void
  onDelete: () => void
  onEdit: () => void
}): React.ReactNode {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer"
      style={{ background: alpha('ink', 0.02) }}
      onClick={onEdit}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-medium truncate"
            style={{ color: schedule.enabled ? theme.text.primary : theme.text.muted }}
          >
            {schedule.name}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs" style={{ color: theme.text.tertiary }}>
            {schedule.runAt
              ? `Once: ${new Date(schedule.runAt).toLocaleString()}`
              : cronToHuman(schedule.cronExpression ?? '')}
          </span>
          {schedule.modelOverride && (
            <span className="text-xs" style={{ color: theme.text.tertiary }}>
              · {schedule.modelOverride.model}
            </span>
          )}
        </div>
        <p className="text-xs mt-1 line-clamp-1" style={{ color: theme.text.muted, margin: 0 }}>
          {schedule.prompt}
        </p>
      </div>
      <span role="presentation" onClick={(e) => e.stopPropagation()}>
        <SettingSwitch
          ariaLabel={`Enable ${schedule.name}`}
          checked={schedule.enabled}
          onChange={onToggle}
        />
      </span>
      <button
        className="p-1 rounded cursor-pointer"
        style={{ color: theme.text.muted }}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title="Delete schedule"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
  onNavigateToTab,
  submitLabel = 'Create'
}: {
  initial?: ScheduleRecord
  onSubmit: (input: ScheduleFormSubmitInput) => Promise<void>
  onCancel: () => void
  onNavigateToTab?: (tab: string) => void
  submitLabel?: string
}): React.ReactNode {
  const [mode, setMode] = useState<'recurring' | 'one-off'>(
    initial?.runAt ? 'one-off' : 'recurring'
  )
  const isOneOff = mode === 'one-off'
  const [name, setName] = useState(initial?.name ?? '')
  const [cron, setCron] = useState(initial?.cronExpression ?? '')
  const [runAt, setRunAt] = useState(() => {
    if (!initial?.runAt) return ''
    const d = new Date(initial.runAt)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [modelOverride, setModelOverride] = useState<ThreadModelOverride | undefined>(
    initial?.modelOverride
  )
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(initial?.workspacePath)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [config, setConfig] = useState<SettingsConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo.getConfig().then((cfg) => {
      if (!cancelled) setConfig(cfg)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = async (): Promise<void> => {
    const submission = buildScheduleFormSubmitInput({
      initial,
      mode,
      name,
      cron,
      runAt,
      prompt,
      modelOverride,
      workspacePath
    })
    if (!submission.ok) {
      setError(submission.error)
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      await onSubmit(submission.input)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const modelOptions = (config?.providers ?? []).flatMap((p) =>
    p.modelList.enabled.map((m) => ({ value: `${p.name}::${m}`, label: `${p.name}: ${m}` }))
  )

  const workspaceOptions = config?.workspace?.savedPaths ?? []

  return (
    <div className="flex flex-col gap-3 p-3 rounded-lg" style={{ background: alpha('ink', 0.03) }}>
      <div className="flex gap-2 items-center">
        {/* 1/3 — Name */}
        <input
          className="rounded-md px-2.5 py-1.5 text-sm outline-none min-w-0"
          style={{ ...inputStyle(), flex: '1 1 0%' }}
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {/* 1/3 — Mode toggle */}
        <div
          className="flex rounded-md text-xs"
          style={{ flex: '1 1 0%', background: alpha('ink', 0.06), padding: 2 }}
        >
          {(['recurring', 'one-off'] as const).map((m) => (
            <button
              key={m}
              className="flex-1 py-1 rounded cursor-pointer"
              style={{
                background: mode === m ? alpha('ink', 0.12) : 'transparent',
                color: mode === m ? theme.text.primary : theme.text.secondary,
                border: 'none',
                fontWeight: mode === m ? 500 : 400,
                letterSpacing: '0.01em'
              }}
              onClick={() => setMode(m)}
            >
              {m === 'recurring' ? 'Recurring' : 'One-off'}
            </button>
          ))}
        </div>
        {/* 1/3 — Schedule input */}
        <div className="flex items-center gap-1.5 min-w-0" style={{ flex: '1 1 0%' }}>
          {isOneOff ? (
            <>
              <input
                className="flex-1 rounded-md px-2.5 py-1.5 text-sm outline-none min-w-0"
                style={inputStyle()}
                placeholder="e.g. 2026-04-15 09:00"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
              <DateTimePick value={runAt} onPick={setRunAt} />
            </>
          ) : (
            <>
              <input
                className="flex-1 rounded-md px-2.5 py-1.5 text-sm outline-none min-w-0"
                style={inputStyle()}
                placeholder="Cron (e.g. 0 9 * * *)"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
              />
              <CronQuickPick onPick={setCron} />
            </>
          )}
        </div>
      </div>
      {!isOneOff && cron.trim() && cronToHuman(cron.trim()) !== cron.trim() && (
        <span className="text-xs -mt-1" style={{ color: theme.text.tertiary }}>
          {cronToHuman(cron.trim())}
        </span>
      )}
      <textarea
        className="rounded-md px-2.5 py-1.5 text-sm outline-none resize-none"
        style={{ ...inputStyle(), minHeight: 80 }}
        placeholder="Prompt — what should the model do?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex gap-3">
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium" style={{ color: theme.text.secondary }}>
            Model
          </span>
          <div className="mt-1">
            <SimpleSelect
              value={modelOverride ? `${modelOverride.providerName}::${modelOverride.model}` : ''}
              options={[{ value: '', label: 'Default (same as chat)' }, ...modelOptions]}
              onChange={(val) => {
                if (!val) {
                  setModelOverride(undefined)
                } else {
                  const [providerName, model] = val.split('::')
                  setModelOverride({ providerName, model })
                }
              }}
              width="100%"
            />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium" style={{ color: theme.text.secondary }}>
            Workspace
          </span>
          <div className="mt-1">
            <SimpleSelect
              value={workspacePath ?? ''}
              options={[
                { value: '', label: 'Temporary (auto)' },
                ...workspaceOptions.map((p) => ({ value: p, label: p }))
              ]}
              onChange={(val) => setWorkspacePath(val || undefined)}
              width="100%"
            />
          </div>
          {onNavigateToTab && (
            <button
              className="text-xs mt-1 cursor-pointer"
              style={{ color: theme.text.accent, background: 'none', border: 'none', padding: 0 }}
              onClick={() => onNavigateToTab('workspace')}
            >
              Manage workspaces...
            </button>
          )}
        </div>
      </div>
      {error && (
        <span className="text-xs" style={{ color: theme.text.danger }}>
          {error}
        </span>
      )}
      <div className="flex justify-end gap-2">
        <button
          className="px-3 py-1 rounded-md text-xs font-medium cursor-pointer"
          style={{ color: theme.text.secondary }}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer"
          style={{
            background: theme.text.accent,
            color: theme.text.inverse,
            opacity: submitting ? 0.6 : 1
          }}
          disabled={submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? `${submitLabel}...` : submitLabel}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistorySubTab(): React.ReactNode {
  const [runs, setRuns] = useState<ScheduleRunRecord[]>([])
  const [schedules, setSchedules] = useState<Map<string, ScheduleRecord>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [runList, scheduleList] = await Promise.all([
        window.api.yachiyo.listRecentScheduleRuns({ limit: 50 }),
        window.api.yachiyo.listSchedules()
      ])
      if (cancelled) return
      setRuns(runList)
      setSchedules(new Map(scheduleList.map((s) => [s.id, s])))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm" style={{ color: theme.text.muted }}>
          Loading...
        </span>
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2" style={{ opacity: 0.4 }}>
          <Clock size={24} stroke={theme.icon.muted} />
          <span className="text-sm" style={{ color: theme.text.muted }}>
            No runs yet
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-1">
      <span
        className="text-xs font-semibold uppercase tracking-wider mb-3"
        style={{ color: theme.text.secondary }}
      >
        Recent Runs
      </span>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} scheduleName={schedules.get(run.scheduleId)?.name} />
      ))}
    </div>
  )
}

function statusBadgeColors(run: ScheduleRunRecord): { bg: string; fg: string } {
  if (run.status === 'skipped') {
    return { bg: alpha('ink', 0.04), fg: theme.text.tertiary }
  }
  if (run.status === 'completed' && run.resultStatus !== 'failure') {
    return { bg: alpha('success', 0.06), fg: theme.text.success }
  }
  if (run.status === 'failed' || run.resultStatus === 'failure') {
    return { bg: alpha('danger', 0.05), fg: theme.text.danger }
  }
  return { bg: alpha('warning', 0.06), fg: theme.text.warning }
}

function RunRow({
  run,
  scheduleName
}: {
  run: ScheduleRunRecord
  scheduleName?: string
}): React.ReactNode {
  const badge = statusBadgeColors(run)
  // Only allow navigation when the run finished (thread is archived).
  // Running threads aren't archived yet, and restored threads are no longer in the archive.
  const canNavigate = !!run.threadId && run.status !== 'running'

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg${canNavigate ? ' cursor-pointer' : ''}`}
      style={{ background: alpha('ink', 0.02) }}
      onClick={canNavigate ? () => window.api.navigateToArchivedThread(run.threadId!) : undefined}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
            {scheduleName ?? run.scheduleId}
          </span>
          <span className="text-xs" style={{ color: theme.text.tertiary }}>
            {formatTimestamp(run.startedAt)}
          </span>
        </div>
        {run.resultSummary && (
          <p className="text-xs mt-0.5 line-clamp-2" style={{ color: theme.text.secondary }}>
            {run.resultSummary}
          </p>
        )}
        {run.error && (
          <p className="text-xs mt-0.5 line-clamp-2" style={{ color: theme.text.danger }}>
            {run.error}
          </p>
        )}
      </div>
      <span
        className="text-xs shrink-0 px-2 py-0.5 rounded-full font-medium"
        style={{ background: badge.bg, color: badge.fg }}
      >
        {run.resultStatus ?? run.status}
      </span>
    </div>
  )
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso)
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}
