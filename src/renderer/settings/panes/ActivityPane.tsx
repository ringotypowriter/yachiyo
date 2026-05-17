import { Loader2, LockKeyhole, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { ActivitySourceRecord, SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import { theme } from '@renderer/theme/theme'
import {
  SettingLabel,
  SettingRow,
  SettingSection,
  SettingSwitch,
  SimpleSelect
} from '../components/primitives'
import {
  addExcludedApp,
  buildRecentActivityAppOptions,
  parseExcludedAppTokens,
  removeExcludedApp
} from './activityExcludedApps.ts'

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
  const activityOcr = activityTracking?.ocr ?? { enabled: false, excludedApps: [] }
  const excludedApps = activityOcr.excludedApps ?? []
  const [manualExcludedApp, setManualExcludedApp] = useState('')
  const recentAppOptions = buildRecentActivityAppOptions(records, excludedApps).slice(0, 6)

  const updateActivityTracking = (
    next: NonNullable<SettingsConfig['general']>['activityTracking']
  ): void => {
    onChange({
      ...draft,
      general: {
        ...draft.general,
        activityTracking: next
      }
    })
  }

  const updateActivityOcr = (ocr: NonNullable<typeof activityOcr>): void => {
    updateActivityTracking({
      mode: activityTrackingMode,
      ...(activityTracking?.accessibilityDenied === true ? { accessibilityDenied: true } : {}),
      ocr
    })
  }

  const setExcludedApps = (nextExcludedApps: string[]): void => {
    updateActivityOcr({
      enabled: activityOcr.enabled,
      excludedApps: nextExcludedApps
    })
  }

  const addExcludedAppValue = (value: string): void => {
    const nextExcludedApps = addExcludedApp(excludedApps, value)
    setExcludedApps(nextExcludedApps)
    setManualExcludedApp('')
  }

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
                updateActivityTracking({
                  ...(activityTracking ?? {}),
                  mode,
                  ocr: activityOcr
                })
              }}
              width={130}
            />
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Screen OCR
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Capture text from the active window while Yachiyo is unfocused. OCR text is stored in
              encrypted activity records.
            </div>
            {!isMac ? (
              <div className="text-xs leading-4 mt-0.5" style={{ color: theme.text.warning }}>
                Screen OCR is available on macOS only.
              </div>
            ) : activityTrackingMode === 'off' ? (
              <div className="text-xs leading-4 mt-0.5" style={{ color: theme.text.warning }}>
                Turn on activity tracking before enabling OCR.
              </div>
            ) : null}
          </div>

          <SettingSwitch
            ariaLabel="Enable activity screen OCR"
            checked={activityOcr.enabled === true}
            disabled={!isMac || activityTrackingMode === 'off'}
            onChange={() => {
              updateActivityOcr({
                enabled: activityOcr.enabled !== true,
                excludedApps
              })
            }}
          />
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-0.5">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Excluded apps
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                Add apps that OCR should always skip. Recent activity apps can be excluded with one
                click.
              </div>
            </div>

            {excludedApps.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {excludedApps.map((app) => (
                  <span
                    key={app.toLocaleLowerCase()}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
                    style={{
                      color: theme.text.secondary,
                      background: theme.background.surfaceMuted,
                      border: `1px solid ${theme.border.subtle}`
                    }}
                  >
                    <span className="truncate">{app}</span>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full opacity-70 transition-opacity hover:opacity-100"
                      style={{ color: theme.text.muted }}
                      aria-label={`Remove ${app} from OCR exclusions`}
                      onClick={() => setExcludedApps(removeExcludedApp(excludedApps, app))}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs" style={{ color: theme.text.muted }}>
                No excluded apps yet.
              </div>
            )}

            <div className="flex gap-2">
              <input
                value={manualExcludedApp}
                spellCheck={false}
                placeholder="Add app name or bundle id"
                onChange={(event) => setManualExcludedApp(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addExcludedAppValue(manualExcludedApp)
                }}
                className="min-w-0 flex-1 text-sm outline-none"
                style={{
                  color: theme.text.primary,
                  background: theme.background.surfaceMuted,
                  border: `1px solid ${theme.border.input}`,
                  borderRadius: 10,
                  padding: '8px 10px',
                  lineHeight: '20px'
                }}
              />
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-medium disabled:opacity-40"
                style={{
                  color: theme.text.primary,
                  background: theme.background.surfaceMuted,
                  border: `1px solid ${theme.border.input}`
                }}
                disabled={parseExcludedAppTokens(manualExcludedApp).length === 0}
                onClick={() => addExcludedAppValue(manualExcludedApp)}
              >
                <Plus size={14} />
                Add
              </button>
            </div>

            {recentAppOptions.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs font-medium" style={{ color: theme.text.muted }}>
                  Recent apps
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {recentAppOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className="min-w-0 rounded-lg px-3 py-2 text-left transition-opacity hover:opacity-85"
                      style={{
                        color: theme.text.primary,
                        background: theme.background.surfaceMuted,
                        border: `1px solid ${theme.border.subtle}`
                      }}
                      onClick={() => addExcludedAppValue(option.appName)}
                    >
                      <div className="truncate text-sm font-medium">{option.appName}</div>
                      <div className="truncate text-xs" style={{ color: theme.text.muted }}>
                        {option.bundleId}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
