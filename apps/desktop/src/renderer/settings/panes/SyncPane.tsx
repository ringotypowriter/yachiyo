import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cloud, RefreshCw } from 'lucide-react'
import type {
  SyncConflictRecord,
  SyncConflictResolution,
  SyncStatus
} from '@yachiyo/shared/protocol'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { alpha, theme } from '@renderer/theme/theme'

interface SyncPaneProps {
  onConfigReload: () => Promise<void>
}

function primaryButtonStyle(disabled = false): React.CSSProperties {
  return {
    minHeight: 34,
    border: '1px solid transparent',
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 600,
    background: disabled ? alpha('ink', 0.04) : theme.background.accentFill,
    // `accentFill` is a deep accent fill; `onAccentFill` its white label (AA-guaranteed).
    color: disabled ? theme.text.muted : theme.text.onAccentFill,
    opacity: disabled ? 0.45 : 1,
    ...(disabled ? {} : { boxShadow: theme.shadow.button })
  }
}

function secondaryButtonStyle(): React.CSSProperties {
  return {
    minHeight: 34,
    border: `1px solid ${theme.border.subtle}`,
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 600,
    background: theme.background.surface,
    color: theme.text.secondary
  }
}

function choiceChipStyle(selected: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    borderRadius: 8,
    padding: '6px 9px',
    border: `1px solid ${selected ? theme.text.accent : theme.border.subtle}`,
    background: selected ? theme.background.accentSoft : theme.background.surface
  }
}

function statusLabel(status: SyncStatus | null, busy: boolean): string {
  if (busy) return 'Syncing...'
  if (!status) return 'Loading sync status...'
  switch (status.state) {
    case 'icloud_unavailable':
      return 'iCloud Drive unavailable'
    case 'not_initialized':
      return status.deviceCount > 0 ? 'Not enabled on this device' : 'Not initialized'
    case 'needs_attention':
      return 'Needs attention'
    case 'ready':
      return 'Ready'
  }
}

export function SyncPane({ onConfigReload }: SyncPaneProps): React.ReactNode {
  const dialog = useAppDialog()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflictRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-conflict, per-field choice for settings merges. Defaults to 'local'.
  const [selections, setSelections] = useState<Record<string, Record<string, 'local' | 'remote'>>>(
    {}
  )

  const fieldChoice = (conflictId: string, path: string): 'local' | 'remote' =>
    selections[conflictId]?.[path] ?? 'local'

  const setFieldChoice = (conflictId: string, path: string, choice: 'local' | 'remote'): void =>
    setSelections((prev) => ({
      ...prev,
      [conflictId]: { ...prev[conflictId], [path]: choice }
    }))

  const setAllChoices = (conflict: SyncConflictRecord, choice: 'local' | 'remote'): void =>
    setSelections((prev) => ({
      ...prev,
      [conflict.id]: Object.fromEntries(
        (conflict.settingsFields ?? []).map((field) => [field.path, choice])
      )
    }))

  const reload = useCallback(async (): Promise<void> => {
    const [nextStatus, conflictResult] = await Promise.all([
      window.api.yachiyo.getSyncStatus(),
      window.api.yachiyo.listSyncConflicts()
    ])
    setStatus(nextStatus)
    setConflicts(conflictResult.conflicts)
  }, [])

  useEffect(() => {
    void reload().catch((reason) => {
      setError(reason instanceof Error ? reason.message : 'Failed to load sync status.')
    })
  }, [reload])

  const handleInit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await window.api.yachiyo.initSync())
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to initialize sync.')
    } finally {
      setBusy(false)
    }
  }

  const handleSyncNow = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await window.api.yachiyo.runSyncNow())
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to sync now.')
    } finally {
      setBusy(false)
    }
  }

  const resolveConflict = async (
    conflict: SyncConflictRecord,
    resolution: SyncConflictResolution,
    fieldSelections?: Record<string, 'local' | 'remote'>
  ): Promise<void> => {
    if (resolution === 'use_remote') {
      const confirmed = await dialog.confirm({
        title: 'Use synced settings?',
        message: 'This replaces this device’s current settings with the synced version.',
        confirmLabel: 'Use Synced Version',
        cancelLabel: 'Cancel'
      })
      if (!confirmed) return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await window.api.yachiyo.resolveSyncConflict({
        conflictId: conflict.id,
        resolution,
        ...(fieldSelections ? { fieldSelections } : {})
      })
      setConflicts(result.conflicts)
      if (resolution === 'use_remote' || resolution === 'merge') {
        await onConfigReload()
      }
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to resolve conflict.')
    } finally {
      setBusy(false)
    }
  }

  const copySyncedToml = async (conflict: SyncConflictRecord): Promise<void> => {
    try {
      const payload = JSON.parse(conflict.payloadJson) as { text?: string }
      await navigator.clipboard.writeText(payload.text ?? conflict.payloadJson)
    } catch {
      await navigator.clipboard.writeText(conflict.payloadJson)
    }
  }

  const unavailable = status?.state === 'icloud_unavailable'
  const initialized = status && status.state !== 'not_initialized' && !unavailable
  // Sync already exists (another device created the universe) but this device
  // hasn't joined yet — offer "Join" instead of first-time "Enable".
  const joinable = status != null && status.state === 'not_initialized' && status.deviceCount > 0

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: theme.text.accent }}
          >
            Sync
          </div>
          <div className="text-lg font-semibold" style={{ color: theme.text.primary }}>
            iCloud Sync
          </div>
          <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Settings and remote chat archives sync through iCloud Drive files. Synced chats from
            other devices stay read-only.
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {!initialized ? (
            <button
              type="button"
              disabled={busy || unavailable}
              onClick={() => void handleInit()}
              style={primaryButtonStyle(busy || unavailable)}
            >
              {joinable ? 'Join This Device' : 'Enable iCloud Sync'}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSyncNow()}
              style={primaryButtonStyle(busy)}
            >
              Sync Now
            </button>
          )}
        </div>
      </div>

      <div
        className="mb-4 rounded-2xl p-4"
        style={{ background: theme.background.surface, border: `1px solid ${theme.border.subtle}` }}
      >
        <div
          className="flex items-center gap-2 text-sm font-semibold"
          style={{ color: theme.text.primary }}
        >
          {busy ? (
            <RefreshCw size={16} color={theme.icon.muted} className="animate-spin" />
          ) : status?.state === 'needs_attention' || unavailable ? (
            <AlertTriangle size={16} color={theme.text.dangerStrong} />
          ) : status?.state === 'ready' ? (
            <CheckCircle2 size={16} color={theme.text.success} />
          ) : (
            <Cloud size={16} color={theme.icon.muted} />
          )}
          {statusLabel(status, busy)}
        </div>
        <div className="mt-2 text-xs leading-5 break-all" style={{ color: theme.text.muted }}>
          {status?.syncDir ?? 'Resolving iCloud Drive path...'}
        </div>
        {status ? (
          <div className="mt-3 flex flex-wrap gap-3 text-xs" style={{ color: theme.text.tertiary }}>
            <span>
              {status.deviceCount} device{status.deviceCount === 1 ? '' : 's'}
            </span>
            <span>
              {conflicts.length} pending conflict{conflicts.length === 1 ? '' : 's'}
            </span>
            {status.deviceId ? <span>Device {status.deviceId.slice(0, 8)}</span> : null}
          </div>
        ) : null}
        {unavailable ? (
          <div className="mt-3 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Sign in to iCloud Drive and enable Documents sync in macOS before turning this on.
          </div>
        ) : null}
        {joinable ? (
          <div className="mt-3 text-sm leading-5" style={{ color: theme.text.tertiary }}>
            Sync is already active on another device. Join to pull your synced chats here.
          </div>
        ) : null}
        {error || status?.lastError ? (
          <div className="mt-3 text-sm" style={{ color: theme.text.dangerStrong }}>
            {error ?? status?.lastError}
          </div>
        ) : null}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
          Conflicts
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="flex items-center gap-1.5"
          style={secondaryButtonStyle()}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {conflicts.length === 0 ? (
        <div
          className="rounded-2xl p-4 text-sm"
          style={{ background: alpha('ink', 0.03), color: theme.text.tertiary }}
        >
          No pending sync conflicts.
        </div>
      ) : (
        <div className="space-y-3">
          {conflicts.map((conflict) => (
            <div
              key={conflict.id}
              className="rounded-2xl p-4"
              style={{
                background: theme.background.surface,
                border: `1px solid ${theme.border.subtle}`
              }}
            >
              <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                {conflict.entityId}
              </div>
              <div className="mt-1 text-xs leading-5" style={{ color: theme.text.tertiary }}>
                From device {conflict.deviceId.slice(0, 8)} · {conflict.createdAt}
              </div>
              {conflict.settingsFields && conflict.settingsFields.length > 0 ? (
                <>
                  <div
                    className="mt-3 flex items-center gap-3 text-xs"
                    style={{ color: theme.text.tertiary }}
                  >
                    <span>
                      {conflict.settingsFields.length} field
                      {conflict.settingsFields.length === 1 ? '' : 's'} differ
                    </span>
                    <button
                      type="button"
                      className="underline"
                      style={{ color: theme.text.accent }}
                      onClick={() => setAllChoices(conflict, 'local')}
                    >
                      All: this device
                    </button>
                    <button
                      type="button"
                      className="underline"
                      style={{ color: theme.text.accent }}
                      onClick={() => setAllChoices(conflict, 'remote')}
                    >
                      All: synced
                    </button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {conflict.settingsFields.map((field) => (
                      <div key={field.path}>
                        <div
                          className="text-xs font-medium"
                          style={{ color: theme.text.secondary }}
                        >
                          {field.path}
                        </div>
                        <div className="mt-1 flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setFieldChoice(conflict.id, field.path, 'local')}
                            style={choiceChipStyle(
                              fieldChoice(conflict.id, field.path) === 'local'
                            )}
                          >
                            <div
                              className="text-[10px] uppercase tracking-wide"
                              style={{ color: theme.text.muted }}
                            >
                              This device
                            </div>
                            <div className="truncate text-xs" style={{ color: theme.text.primary }}>
                              {field.localValue ?? '—'}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => setFieldChoice(conflict.id, field.path, 'remote')}
                            style={choiceChipStyle(
                              fieldChoice(conflict.id, field.path) === 'remote'
                            )}
                          >
                            <div
                              className="text-[10px] uppercase tracking-wide"
                              style={{ color: theme.text.muted }}
                            >
                              Synced
                            </div>
                            <div className="truncate text-xs" style={{ color: theme.text.primary }}>
                              {field.remoteValue ?? '—'}
                            </div>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void resolveConflict(conflict, 'merge', selections[conflict.id] ?? {})
                      }
                      style={primaryButtonStyle(busy)}
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={() => void copySyncedToml(conflict)}
                      style={secondaryButtonStyle()}
                    >
                      Copy Synced TOML
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 grid gap-1 text-xs" style={{ color: theme.text.muted }}>
                    <span>Local: {conflict.localHash}</span>
                    <span>Synced: {conflict.remoteHash}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resolveConflict(conflict, 'keep_local')}
                      style={secondaryButtonStyle()}
                    >
                      Keep This Device
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resolveConflict(conflict, 'use_remote')}
                      style={primaryButtonStyle(busy)}
                    >
                      Use Synced Version
                    </button>
                    <button
                      type="button"
                      onClick={() => void copySyncedToml(conflict)}
                      style={secondaryButtonStyle()}
                    >
                      Copy Synced TOML
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
