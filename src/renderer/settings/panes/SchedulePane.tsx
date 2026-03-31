import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Clock, CalendarClock } from 'lucide-react'
import { createPortal } from 'react-dom'
import { theme, alpha } from '@renderer/theme/theme'
import { inputStyle } from '../components/styles'
import { imeSafeChange } from '../components/imeUtils'
import { SettingSwitch, SimpleSelect } from '../components/primitives'
import type {
  ScheduleRecord,
  ScheduleRunRecord,
  SettingsConfig,
  ThreadModelOverride,
  CreateScheduleInput
} from '../../../shared/yachiyo/protocol'

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
    async (input: CreateScheduleInput) => {
      await window.api.yachiyo.createSchedule(input)
      setAdding(false)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleUpdate = useCallback(
    async (input: CreateScheduleInput & { id: string }) => {
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
            {cronToHuman(schedule.cronExpression)}
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
  onSubmit: (input: CreateScheduleInput) => Promise<void>
  onCancel: () => void
  onNavigateToTab?: (tab: string) => void
  submitLabel?: string
}): React.ReactNode {
  const [name, setName] = useState(initial?.name ?? '')
  const [cron, setCron] = useState(initial?.cronExpression ?? '')
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
    if (!name.trim() || !cron.trim() || !prompt.trim()) {
      setError('All fields are required.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const isEdit = !!initial
      await onSubmit({
        name: name.trim(),
        cronExpression: cron.trim(),
        prompt: prompt.trim(),
        // On edit, explicitly send null to clear; on create, just omit.
        modelOverride: modelOverride ?? (isEdit ? null : undefined),
        workspacePath: workspacePath ?? (isEdit ? null : undefined)
      } as CreateScheduleInput)
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
      <div className="flex gap-3">
        <input
          className="flex-1 rounded-md px-2.5 py-1.5 text-sm outline-none"
          style={inputStyle()}
          placeholder="Name"
          value={name}
          onChange={imeSafeChange(setName)}
          autoFocus
        />
        <div className="flex items-center gap-1.5">
          <input
            className="rounded-md px-2.5 py-1.5 text-sm outline-none"
            style={{ ...inputStyle(), width: 150 }}
            placeholder="Cron (e.g. 0 9 * * *)"
            value={cron}
            onChange={imeSafeChange(setCron)}
          />
          <CronQuickPick onPick={setCron} />
        </div>
      </div>
      {cron.trim() && cronToHuman(cron.trim()) !== cron.trim() && (
        <span className="text-xs -mt-1" style={{ color: theme.text.tertiary }}>
          {cronToHuman(cron.trim())}
        </span>
      )}
      <textarea
        className="rounded-md px-2.5 py-1.5 text-sm outline-none resize-none"
        style={{ ...inputStyle(), minHeight: 80 }}
        placeholder="Prompt — what should the model do?"
        value={prompt}
        onChange={imeSafeChange(setPrompt)}
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
