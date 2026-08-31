import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  ManagedPythonEnvironmentAction,
  ManagedPythonEnvironmentPhase,
  ManagedPythonEnvironmentState,
  ManagedPythonEnvironmentStatus
} from '@yachiyo/shared/protocol'
import { useT } from '@yachiyo/i18n/react'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { alpha, theme } from '@renderer/theme/theme'

type Translate = ReturnType<typeof useT>

function phaseLabel(phase: ManagedPythonEnvironmentPhase, t: Translate): string {
  switch (phase) {
    case 'checking':
      return t('settings.pythonEnvironment.phaseChecking')
    case 'preparing-helper':
      return t('settings.pythonEnvironment.phasePreparingHelper')
    case 'installing-python':
      return t('settings.pythonEnvironment.phaseInstallingPython')
    case 'creating-environment':
      return t('settings.pythonEnvironment.phaseCreatingEnvironment')
    case 'installing-packages':
      return t('settings.pythonEnvironment.phaseInstallingPackages')
    case 'verifying-environment':
      return t('settings.pythonEnvironment.phaseVerifyingEnvironment')
    case 'removing-environment':
      return t('settings.pythonEnvironment.phaseRemovingEnvironment')
  }
}

function stateText(
  state: ManagedPythonEnvironmentState,
  t: Translate
): { label: string; description: string; color: string; icon: React.ReactNode } {
  switch (state) {
    case 'ready':
      return {
        label: t('settings.pythonEnvironment.stateReady'),
        description: t('settings.pythonEnvironment.stateReadyDescription'),
        color: theme.text.success,
        icon: <CheckCircle2 size={18} />
      }
    case 'needs-repair':
      return {
        label: t('settings.pythonEnvironment.stateNeedsRepair'),
        description: t('settings.pythonEnvironment.stateNeedsRepairDescription'),
        color: theme.text.warning,
        icon: <AlertTriangle size={18} />
      }
    case 'unavailable':
      return {
        label: t('settings.pythonEnvironment.stateUnavailable'),
        description: t('settings.pythonEnvironment.stateUnavailableDescription'),
        color: theme.text.dangerStrong,
        icon: <CircleOff size={18} />
      }
    case 'not-installed':
      return {
        label: t('settings.pythonEnvironment.stateNotInstalled'),
        description: t('settings.pythonEnvironment.stateNotInstalledDescription'),
        color: theme.text.muted,
        icon: <CircleOff size={18} />
      }
  }
}

function ActionButton({
  children,
  disabled,
  tone = 'secondary',
  onClick
}: {
  children: React.ReactNode
  disabled: boolean
  tone?: 'primary' | 'secondary' | 'danger'
  onClick: () => void
}): React.JSX.Element {
  const color =
    tone === 'primary'
      ? disabled
        ? theme.text.muted
        : theme.text.onAccentFill
      : tone === 'danger'
        ? theme.text.dangerStrong
        : theme.text.secondary
  const background =
    tone === 'primary'
      ? disabled
        ? alpha('ink', 0.04)
        : theme.background.accentFill
      : tone === 'danger'
        ? alpha('danger', disabled ? 0.03 : 0.07)
        : disabled
          ? alpha('ink', 0.03)
          : theme.background.surface

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-8 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
      style={{
        color,
        background,
        border: tone === 'primary' ? '1px solid transparent' : `1px solid ${theme.border.subtle}`
      }}
    >
      {children}
    </button>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="grid grid-cols-[minmax(130px,0.38fr)_minmax(0,1fr)] gap-5 py-3 text-sm"
      style={{ borderTop: `1px solid ${theme.border.subtle}` }}
    >
      <dt style={{ color: theme.text.muted }}>{label}</dt>
      <dd className="min-w-0 break-all text-right" style={{ color: theme.text.secondary }}>
        {value}
      </dd>
    </div>
  )
}

function ActionRow({
  title,
  description,
  button
}: {
  title: string
  description: string
  button: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="flex items-start justify-between gap-6 py-4"
      style={{ borderTop: `1px solid ${theme.border.subtle}` }}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
          {title}
        </div>
        <div className="mt-1 text-sm leading-5" style={{ color: theme.text.tertiary }}>
          {description}
        </div>
      </div>
      {button}
    </div>
  )
}

export function PythonEnvironmentPane(): React.ReactNode {
  const t = useT()
  const dialog = useAppDialog()
  const [status, setStatus] = useState<ManagedPythonEnvironmentStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<ManagedPythonEnvironmentAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inspectEnvironment = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await window.api.yachiyo.getPythonEnvironmentStatus())
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('settings.pythonEnvironment.loadFailed')
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let eventReceived = false
    const unsubscribe = window.api.yachiyo.subscribe((event) => {
      if (event.type !== 'python-environment.updated') return
      eventReceived = true
      if (!cancelled) {
        setStatus(event.status)
        setLoading(false)
      }
    })

    void window.api.yachiyo
      .getPythonEnvironmentStatus()
      .then((nextStatus) => {
        if (!cancelled && !eventReceived) setStatus(nextStatus)
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : t('settings.pythonEnvironment.loadFailed')
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [t])

  const runAction = async (action: ManagedPythonEnvironmentAction): Promise<void> => {
    if (action === 'rebuild') {
      const confirmed = await dialog.confirm({
        title: t('settings.pythonEnvironment.rebuildConfirmTitle'),
        message: t('settings.pythonEnvironment.rebuildConfirmMessage'),
        confirmLabel: t('settings.pythonEnvironment.rebuildConfirmLabel'),
        tone: 'danger'
      })
      if (!confirmed) return
    } else if (action === 'remove') {
      const confirmed = await dialog.confirm({
        title: t('settings.pythonEnvironment.removeConfirmTitle'),
        message: t('settings.pythonEnvironment.removeConfirmMessage'),
        confirmLabel: t('settings.pythonEnvironment.removeConfirmLabel'),
        tone: 'danger'
      })
      if (!confirmed) return
    }

    setPendingAction(action)
    setError(null)
    try {
      setStatus(await window.api.yachiyo.managePythonEnvironment(action))
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : t('settings.pythonEnvironment.actionFailed')
      try {
        const nextStatus = await window.api.yachiyo.getPythonEnvironmentStatus()
        setStatus(nextStatus)
        if (!nextStatus.lastFailure) setError(message)
      } catch {
        setError(message)
      }
    } finally {
      setPendingAction(null)
    }
  }

  const busy = pendingAction !== null || status?.operation !== undefined
  const managementBlocked = status?.managementBlocked === true
  const state = status ? stateText(status.state, t) : null
  const canInstall = status?.state === 'not-installed' || status?.state === 'unavailable'
  const canMaintain = status?.state === 'ready' || status?.state === 'needs-repair'
  const failureTime = status?.lastFailure
    ? new Date(status.lastFailure.occurredAt).toLocaleString()
    : null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-7 py-6">
        <header className="flex items-start justify-between gap-5 pb-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold" style={{ color: theme.text.primary }}>
              {t('settings.pythonEnvironment.title')}
            </h2>
            <p className="mt-1 text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.pythonEnvironment.description')}
            </p>
          </div>
          <ActionButton disabled={loading || busy} onClick={() => void inspectEnvironment()}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
            {t('settings.pythonEnvironment.refresh')}
          </ActionButton>
        </header>

        {loading && !status ? (
          <div
            className="flex items-center gap-2 py-5 text-sm"
            style={{ borderTop: `1px solid ${theme.border.subtle}`, color: theme.text.muted }}
          >
            <LoaderCircle size={16} className="animate-spin" />
            {t('settings.pythonEnvironment.loading')}
          </div>
        ) : status && state ? (
          <>
            <div
              className="flex items-start justify-between gap-6 py-5"
              style={{ borderTop: `1px solid ${theme.border.subtle}` }}
              aria-live="polite"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 shrink-0" style={{ color: state.color }}>
                  {status.operation ? (
                    <LoaderCircle size={18} className="animate-spin" />
                  ) : (
                    state.icon
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: state.color }}>
                    {status.operation && status.phase ? phaseLabel(status.phase, t) : state.label}
                  </div>
                  <div className="mt-1 text-sm leading-5" style={{ color: theme.text.tertiary }}>
                    {state.description}
                  </div>
                </div>
              </div>
              {canInstall ? (
                <ActionButton
                  disabled={busy || managementBlocked}
                  tone="primary"
                  onClick={() => void runAction('install')}
                >
                  <Download size={14} />
                  {pendingAction === 'install'
                    ? t('settings.pythonEnvironment.starting')
                    : status.state === 'unavailable'
                      ? t('settings.pythonEnvironment.retry')
                      : t('settings.pythonEnvironment.install')}
                </ActionButton>
              ) : null}
            </div>

            <dl>
              <DetailRow
                label={t('settings.pythonEnvironment.pythonVersion')}
                value={status.pythonVersion}
              />
              <DetailRow
                label={t('settings.pythonEnvironment.uvVersion')}
                value={status.uvVersion}
              />
              <DetailRow
                label={t('settings.pythonEnvironment.location')}
                value={status.environmentPath}
              />
              <DetailRow
                label={t('settings.pythonEnvironment.activeProcesses')}
                value={t('settings.pythonEnvironment.activeProcessCount', {
                  count: status.activeProcessCount
                })}
              />
            </dl>

            {managementBlocked ? (
              <div className="py-3 text-sm" style={{ color: theme.text.warning }}>
                {t('settings.pythonEnvironment.managementBlocked')}
              </div>
            ) : null}

            {status.lastFailure ? (
              <div
                className="py-4"
                style={{ borderTop: `1px solid ${theme.border.subtle}` }}
                aria-live="polite"
              >
                <div className="text-sm font-medium" style={{ color: theme.text.dangerStrong }}>
                  {t('settings.pythonEnvironment.lastFailure')}
                </div>
                <div
                  className="mt-1 whitespace-pre-wrap break-words text-sm leading-5"
                  style={{ color: theme.text.secondary }}
                >
                  {status.lastFailure.message}
                </div>
                {failureTime ? (
                  <div className="mt-1 text-xs" style={{ color: theme.text.muted }}>
                    {t('settings.pythonEnvironment.lastFailureAt', { time: failureTime })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {canMaintain ? (
              <div className="pt-2">
                <ActionRow
                  title={t('settings.pythonEnvironment.repair')}
                  description={t('settings.pythonEnvironment.repairDescription')}
                  button={
                    <ActionButton
                      disabled={busy || managementBlocked}
                      tone={status.state === 'needs-repair' ? 'primary' : 'secondary'}
                      onClick={() => void runAction('repair')}
                    >
                      <Wrench size={14} />
                      {pendingAction === 'repair'
                        ? t('settings.pythonEnvironment.starting')
                        : t('settings.pythonEnvironment.repair')}
                    </ActionButton>
                  }
                />
                <ActionRow
                  title={t('settings.pythonEnvironment.rebuild')}
                  description={t('settings.pythonEnvironment.rebuildDescription')}
                  button={
                    <ActionButton
                      disabled={busy || managementBlocked}
                      onClick={() => void runAction('rebuild')}
                    >
                      <RotateCcw size={14} />
                      {pendingAction === 'rebuild'
                        ? t('settings.pythonEnvironment.starting')
                        : t('settings.pythonEnvironment.rebuild')}
                    </ActionButton>
                  }
                />
                <ActionRow
                  title={t('settings.pythonEnvironment.remove')}
                  description={t('settings.pythonEnvironment.removeDescription')}
                  button={
                    <ActionButton
                      disabled={busy || managementBlocked}
                      tone="danger"
                      onClick={() => void runAction('remove')}
                    >
                      <Trash2 size={14} />
                      {pendingAction === 'remove'
                        ? t('settings.pythonEnvironment.starting')
                        : t('settings.pythonEnvironment.remove')}
                    </ActionButton>
                  }
                />
              </div>
            ) : null}
          </>
        ) : null}

        {error ? (
          <div
            className="whitespace-pre-wrap break-words py-4 text-sm leading-5"
            style={{
              borderTop: `1px solid ${theme.border.subtle}`,
              color: theme.text.dangerStrong
            }}
            role="alert"
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
