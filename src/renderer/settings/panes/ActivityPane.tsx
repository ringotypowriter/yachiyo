import { Loader2, LockKeyhole, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { ActivitySourceRecord, SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import { SettingLabel, SettingRow, SettingSection, SimpleSelect } from '../components/primitives'

interface ActivityPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0 ? `${minutes}min ${remainingSeconds}s` : `${minutes}min`
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function summarizeEntries(record: ActivitySourceRecord): string {
  if (record.entries.length === 0) return 'No app entries.'

  return record.entries
    .slice(0, 3)
    .map((entry) =>
      [entry.appName, entry.windowTitle ? `“${entry.windowTitle}”` : null]
        .filter((part): part is string => part !== null)
        .join(' · ')
    )
    .join(' / ')
}

export function ActivityPane({ draft, onChange }: ActivityPaneProps): React.JSX.Element {
  const [records, setRecords] = useState<ActivitySourceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isMac = window.api.process.platform === 'darwin'
  const activityTracking = draft.general?.activityTracking
  const activityTrackingMode = activityTracking?.mode ?? 'simple'
  const activityTrackingWarning =
    activityTracking?.accessibilityDenied === true
      ? activityTrackingMode === 'full'
        ? 'Full mode is not active yet. Save to ask macOS for Accessibility access.'
        : 'Full mode was not enabled. Grant Accessibility access in System Settings, then choose Full again.'
      : null

  const loadRecords = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)

    try {
      const nextRecords = await window.api.yachiyo.listActivitySourceRecords({ limit: 50 })
      setRecords(nextRecords)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to load activity source.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  const openAccessibilitySettings = (): void => {
    window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel
          action={
            isMac ? (
              <button
                className="text-[11px] font-medium hover:underline "
                style={{ color: theme.text.secondary }}
                onClick={openAccessibilitySettings}
              >
                Accessibility Settings…
              </button>
            ) : undefined
          }
        >
          Activity tracking
        </SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Mode
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {activityTrackingMode === 'full'
                ? 'Records app and window activity between runs. Requires Accessibility.'
                : activityTrackingMode === 'simple'
                  ? 'Records app activity between runs. No extra permissions needed.'
                  : 'No activity tracking.'}
            </div>
            {activityTrackingWarning ? (
              <div className="text-xs leading-4 mt-0.5" style={{ color: theme.text.dangerStrong }}>
                {activityTrackingWarning}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <SimpleSelect
              value={activityTrackingMode}
              options={[
                { value: 'off' as const, label: 'Off' },
                { value: 'simple' as const, label: 'Simple' },
                { value: 'full' as const, label: 'Full' }
              ]}
              onChange={(mode) => {
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    activityTracking: { mode }
                  }
                })
              }}
              width={130}
            />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel
          action={
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] font-medium transition-opacity opacity-60 hover:opacity-100"
              style={{ color: theme.text.secondary }}
              onClick={() => void loadRecords()}
              disabled={loading}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh
            </button>
          }
        >
          Activity source
        </SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <LockKeyhole size={14} style={{ color: theme.icon.muted }} />
              <span style={{ color: theme.text.primary }}>Encrypted records</span>
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Activity payloads are stored in the local data SQL database.
            </div>
          </div>
          <div className="shrink-0 text-sm" style={{ color: theme.text.muted }}>
            {records.length} shown
          </div>
        </SettingRow>

        {loading ? (
          <div className="px-7 py-4 text-sm" style={{ color: theme.text.muted }}>
            Loading activity source...
          </div>
        ) : records.length > 0 ? (
          <div style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
            {records.map((record) => (
              <div
                key={record.id}
                className="content-selectable px-7 py-3.5"
                style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                    {formatTimestamp(record.startedAt)}
                  </div>
                  <div className="shrink-0 text-xs" style={{ color: theme.text.muted }}>
                    {formatDuration(record.totalDurationMs)}
                  </div>
                </div>
                <div className="mt-1 text-sm leading-5" style={{ color: theme.text.tertiary }}>
                  {summarizeEntries(record)}
                </div>
                <div className="mt-1 text-xs leading-5" style={{ color: theme.text.muted }}>
                  {record.uniqueApps} {record.uniqueApps === 1 ? 'app' : 'apps'}
                  {record.afkDurationMs ? ` · AFK ${formatDuration(record.afkDurationMs)}` : ''}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-7 py-4 text-sm" style={{ color: theme.text.muted }}>
            No activity records yet.
          </div>
        )}

        {error ? (
          <div className="px-7 pb-3 text-sm" style={{ color: theme.text.warning }}>
            {error}
          </div>
        ) : null}
      </SettingSection>
    </div>
  )
}
