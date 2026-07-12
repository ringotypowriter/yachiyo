import { Loader2, LockKeyhole, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { formatDate, tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import type { ActivitySourceRecord, SettingsConfig } from '@yachiyo/shared/protocol'
import { theme } from '@renderer/theme/theme'
import {
  ListPagination,
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

const ACTIVITY_RECORDS_PAGE_SIZE = 12

interface ActivityPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

type Translate = typeof import('@yachiyo/i18n/index').t

function formatDuration(ms: number, t: Translate): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return t('settings.activity.durationSeconds', { seconds })
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0
    ? t('settings.activity.durationMinutesSeconds', { minutes, seconds: remainingSeconds })
    : t('settings.activity.durationMinutes', { minutes })
}

function formatTimestamp(iso: string): string {
  return formatDate(new Date(iso), 'dateTime')
}

function formatTimeOnly(iso: string): string {
  return formatDate(new Date(iso), 'time')
}

function formatDateOnly(iso: string): string {
  return formatDate(new Date(iso), 'date')
}

function formatActivityRange(record: ActivitySourceRecord): string {
  const started = new Date(record.startedAt)
  const ended = new Date(record.endedAt)
  if (started.toDateString() === ended.toDateString()) {
    return `${formatDateOnly(record.startedAt)} · ${formatTimeOnly(record.startedAt)}–${formatTimeOnly(record.endedAt)}`
  }
  return `${formatTimestamp(record.startedAt)} → ${formatTimestamp(record.endedAt)}`
}

function summarizeEntries(record: ActivitySourceRecord, t: Translate): string {
  if (record.entries.length === 0) return t('settings.activity.noAppEntries')

  const shownEntries = record.entries
    .slice(0, 4)
    .map((entry) =>
      entry.windowTitle && entry.windowTitle !== entry.appName
        ? `${entry.appName} “${entry.windowTitle}”`
        : entry.appName
    )
    .join(' · ')
  const hiddenEntryCount = record.entries.length - 4

  return hiddenEntryCount > 0
    ? `${shownEntries} · ${t('settings.activity.moreEntries', { count: hiddenEntryCount })}`
    : shownEntries
}

function countOcrSnapshots(record: ActivitySourceRecord): number {
  return record.snapshots?.filter((snapshot) => snapshot.ocr).length ?? 0
}

export function ActivityPane({ draft, onChange }: ActivityPaneProps): React.JSX.Element {
  const t = useT()
  const [records, setRecords] = useState<ActivitySourceRecord[]>([])
  const [activityPage, setActivityPage] = useState(1)
  const [activityTotalCount, setActivityTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isMac = window.api.process.platform === 'darwin'
  const activityTracking = draft.general?.activityTracking
  const activityTrackingMode = activityTracking?.mode ?? 'simple'
  const activityTrackingWarning =
    activityTracking?.accessibilityDenied === true
      ? activityTrackingMode === 'full'
        ? t('settings.activity.warningFullPending')
        : t('settings.activity.warningFullDenied')
      : null
  const activityOcr = activityTracking?.ocr ?? { enabled: false, excludedApps: [] }
  const excludedApps = activityOcr.excludedApps ?? []
  const [manualExcludedApp, setManualExcludedApp] = useState('')
  const recentAppOptions = buildRecentActivityAppOptions(records, excludedApps).slice(0, 6)
  const activityPageCount = Math.max(1, Math.ceil(activityTotalCount / ACTIVITY_RECORDS_PAGE_SIZE))
  const activityStartIndex =
    activityTotalCount === 0 ? 0 : (activityPage - 1) * ACTIVITY_RECORDS_PAGE_SIZE
  const activityEndIndex = Math.min(activityStartIndex + records.length, activityTotalCount)

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

  const loadRecords = useCallback(
    async (page: number): Promise<void> => {
      let redirecting = false
      setLoading(true)
      setError(null)

      try {
        const offset = (page - 1) * ACTIVITY_RECORDS_PAGE_SIZE
        const result = await window.api.yachiyo.listActivitySourceRecords({
          limit: ACTIVITY_RECORDS_PAGE_SIZE,
          offset
        })
        setActivityTotalCount(result.totalCount)

        if (result.totalCount > 0 && result.records.length === 0 && page > 1) {
          redirecting = true
          setRecords([])
          setActivityPage(Math.max(1, Math.ceil(result.totalCount / ACTIVITY_RECORDS_PAGE_SIZE)))
          return
        }

        setRecords(result.records)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('settings.activity.loadFailed'))
      } finally {
        if (!redirecting) {
          setLoading(false)
        }
      }
    },
    [t]
  )

  useEffect(() => {
    void loadRecords(activityPage)
  }, [activityPage, loadRecords])

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
                {t('settings.activity.accessibilitySettings')}
              </button>
            ) : undefined
          }
        >
          {t('settings.activity.activityTracking')}
        </SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.activity.mode')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {activityTrackingMode === 'full'
                ? t('settings.activity.modeFullDescription')
                : activityTrackingMode === 'simple'
                  ? t('settings.activity.modeSimpleDescription')
                  : t('settings.activity.modeOffDescription')}
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
                { value: 'off' as const, label: t('common.off') },
                { value: 'simple' as const, label: t('settings.activity.modeSimple') },
                { value: 'full' as const, label: t('settings.activity.modeFull') }
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
              {t('settings.activity.screenOcr')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.activity.screenOcrDescription')}
            </div>
            {!isMac ? (
              <div className="text-xs leading-4 mt-0.5" style={{ color: theme.text.warning }}>
                {t('settings.activity.ocrMacOnly')}
              </div>
            ) : activityTrackingMode === 'off' ? (
              <div className="text-xs leading-4 mt-0.5" style={{ color: theme.text.warning }}>
                {t('settings.activity.ocrNeedsTracking')}
              </div>
            ) : null}
          </div>

          <SettingSwitch
            ariaLabel={t('settings.activity.enableScreenOcr')}
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
                {t('settings.activity.excludedApps')}
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                {t('settings.activity.excludedAppsDescription')}
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
                      aria-label={t('settings.activity.removeFromExclusions', { app })}
                      onClick={() => setExcludedApps(removeExcludedApp(excludedApps, app))}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs" style={{ color: theme.text.muted }}>
                {t('settings.activity.noExcludedApps')}
              </div>
            )}

            <div className="flex gap-2">
              <input
                value={manualExcludedApp}
                spellCheck={false}
                placeholder={t('settings.activity.addAppPlaceholder')}
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
                {t('common.add')}
              </button>
            </div>

            {recentAppOptions.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs font-medium" style={{ color: theme.text.muted }}>
                  {t('settings.activity.recentApps')}
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
              onClick={() => void loadRecords(activityPage)}
              disabled={loading}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('settings.activity.refresh')}
            </button>
          }
        >
          {t('settings.activity.activitySource')}
        </SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <LockKeyhole size={14} style={{ color: theme.icon.muted }} />
              <span style={{ color: theme.text.primary }}>
                {t('settings.activity.encryptedRecords')}
              </span>
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.activity.encryptedRecordsDescription')}
            </div>
          </div>
          <div className="shrink-0 text-sm" style={{ color: theme.text.muted }}>
            {t('settings.activity.totalCount', { count: activityTotalCount })}
          </div>
        </SettingRow>

        {loading ? (
          <div className="px-7 py-4 text-sm" style={{ color: theme.text.muted }}>
            {t('settings.activity.loadingActivity')}
          </div>
        ) : records.length > 0 ? (
          <>
            <div style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
              {records.map((record, index) => {
                const entrySummary = summarizeEntries(record, t)
                const snapshotCount = record.snapshots?.length ?? 0
                const ocrSnapshotCount = countOcrSnapshots(record)

                return (
                  <div
                    key={record.id}
                    className="content-selectable px-7 py-2"
                    style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
                  >
                    <div className="flex gap-3">
                      <div
                        className="w-8 shrink-0 pt-0.5 text-xs tabular-nums"
                        style={{ color: theme.text.muted }}
                      >
                        #{activityStartIndex + index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-3">
                          <div
                            className="min-w-0 text-sm font-medium"
                            style={{ color: theme.text.primary }}
                          >
                            {formatActivityRange(record)}
                          </div>
                          <div className="shrink-0 text-xs" style={{ color: theme.text.muted }}>
                            {formatDuration(record.totalDurationMs, t)}
                          </div>
                        </div>
                        <div
                          className="mt-0.5 truncate text-sm leading-5"
                          style={{ color: theme.text.tertiary }}
                          title={entrySummary}
                        >
                          {entrySummary}
                        </div>
                        <div
                          className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-5"
                          style={{ color: theme.text.muted }}
                        >
                          <span>{tPlural('settings.activity.appCount', record.uniqueApps)}</span>
                          <span>
                            · {tPlural('settings.activity.entryCount', record.entries.length)}
                          </span>
                          {snapshotCount > 0 ? (
                            <span>
                              · {tPlural('settings.activity.snapshotCount', snapshotCount)}
                              {ocrSnapshotCount > 0
                                ? ` / ${t('settings.activity.ocrCount', { count: ocrSnapshotCount })}`
                                : ''}
                            </span>
                          ) : null}
                          {record.afkDurationMs ? (
                            <span>
                              ·{' '}
                              {t('settings.activity.afkDuration', {
                                duration: formatDuration(record.afkDurationMs, t)
                              })}
                            </span>
                          ) : null}
                          <span>
                            · {t('settings.activity.createdPrefix')}{' '}
                            <time dateTime={record.createdAt}>
                              {formatTimestamp(record.createdAt)}
                            </time>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <ListPagination
              page={activityPage}
              pageCount={activityPageCount}
              startIndex={activityStartIndex}
              endIndex={activityEndIndex}
              totalCount={activityTotalCount}
              itemLabel={tPlural('settings.activity.recordUnit', activityTotalCount)}
              onPageChange={setActivityPage}
            />
          </>
        ) : (
          <div className="px-7 py-4 text-sm" style={{ color: theme.text.muted }}>
            {t('settings.activity.noRecords')}
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
