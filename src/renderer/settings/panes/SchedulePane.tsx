import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Clock, RotateCw } from 'lucide-react'
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
import { CronQuickPick, DateTimePick } from './SchedulePickers'
import { cronToHuman } from './scheduleTimeFormat'

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
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium "
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
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg "
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
        className="p-1 rounded "
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
  const isBundled = initial?.bundled === true
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
          style={{
            ...inputStyle(),
            flex: '1 1 0%',
            opacity: isBundled ? 0.6 : 1,
            cursor: isBundled ? 'default' : undefined
          }}
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={isBundled}
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
              className="flex-1 py-1 rounded "
              style={{
                background: mode === m ? alpha('ink', 0.12) : 'transparent',
                color: mode === m ? theme.text.primary : theme.text.secondary,
                border: 'none',
                fontWeight: mode === m ? 500 : 400,
                letterSpacing: '0.01em',
                opacity: isBundled ? 0.6 : 1
              }}
              disabled={isBundled}
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
              <CronQuickPick value={cron} onPick={setCron} />
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
        style={{
          ...inputStyle(),
          minHeight: 80,
          opacity: isBundled ? 0.6 : 1,
          cursor: isBundled ? 'default' : undefined
        }}
        placeholder="Prompt — what should the model do?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        readOnly={isBundled}
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
              className="text-xs mt-1 "
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
          className="px-3 py-1 rounded-md text-xs font-medium "
          style={{ color: theme.text.secondary }}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="px-3 py-1.5 rounded-md text-xs font-medium "
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
  const [refreshKey, setRefreshKey] = useState(0)

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

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
  }, [refreshKey])

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
        <RunRow
          key={run.id}
          run={run}
          scheduleName={schedules.get(run.scheduleId)?.name}
          onRetry={refresh}
        />
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
  scheduleName,
  onRetry
}: {
  run: ScheduleRunRecord
  scheduleName?: string
  onRetry: () => void
}): React.ReactNode {
  const badge = statusBadgeColors(run)
  const canNavigate = !!run.threadId && run.status !== 'running'
  const canRetry = run.status === 'skipped' || run.status === 'failed'
  const [triggering, setTriggering] = useState(false)

  const handleRetry = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setTriggering(true)
    try {
      await window.api.yachiyo.triggerScheduleNow({ scheduleId: run.scheduleId })
      // Give the run a moment to start before refreshing.
      setTimeout(onRetry, 600)
    } finally {
      setTriggering(false)
    }
  }

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
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
      {canRetry && (
        <button
          className="shrink-0 p-1.5 rounded-md transition-colors"
          style={{
            color: theme.text.secondary,
            background: 'transparent'
          }}
          title="Rerun this schedule"
          disabled={triggering}
          onClick={(e) => void handleRetry(e)}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = alpha('ink', 0.06)
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <RotateCw size={14} className={triggering ? 'animate-spin' : ''} />
        </button>
      )}
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
