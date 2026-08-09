import { useState } from 'react'
import { Download, Eye, EyeOff, LoaderCircle, Upload } from 'lucide-react'

import { useT } from '@yachiyo/i18n/react'
import { PROVIDER_BACKUP_MIN_PASSWORD_LENGTH } from '@yachiyo/shared/providerBackup'
import type { ProviderConfig } from '@yachiyo/shared/protocol'
import { AppDialog } from '@renderer/components/AppDialog'
import { theme } from '@renderer/theme/theme'
import { inputStyle } from '../components/styles'

export type ProviderBackupMode = 'export' | 'import'

interface ProviderBackupDialogProps {
  mode: ProviderBackupMode
  providers: ProviderConfig[]
  onClose: () => void
  onExported: (filePath: string) => void
  onImported: (providers: ProviderConfig[], importedCount: number) => void
}

function errorMessage(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason)
  return raw.match(/Error invoking remote method '[^']+': (.+)$/s)?.[1] ?? raw
}

function PasswordField({
  autoComplete,
  label,
  shown,
  value,
  onChange,
  onToggleVisibility
}: {
  autoComplete: string
  label: string
  shown: boolean
  value: string
  onChange: (value: string) => void
  onToggleVisibility: () => void
}): React.JSX.Element {
  const t = useT()

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium" style={{ color: theme.text.primary }}>
        {label}
      </span>
      <div className="relative">
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-xl px-3 py-2.5 pr-10 text-sm outline-none"
          style={inputStyle()}
        />
        <button
          type="button"
          onClick={onToggleVisibility}
          className="absolute inset-y-0 right-2 flex items-center justify-center px-1 opacity-50 transition-opacity hover:opacity-100"
          style={{ color: theme.icon.default }}
          aria-label={shown ? t('settings.providers.hideKey') : t('settings.providers.showKey')}
        >
          {shown ? <EyeOff size={14} strokeWidth={2} /> : <Eye size={14} strokeWidth={2} />}
        </button>
      </div>
    </label>
  )
}

export function ProviderBackupDialog({
  mode,
  providers,
  onClose,
  onExported,
  onImported
}: ProviderBackupDialogProps): React.JSX.Element {
  const t = useT()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordsMatch = mode === 'import' || password === confirmation
  const canSubmit =
    password.length >= PROVIDER_BACKUP_MIN_PASSWORD_LENGTH && passwordsMatch && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    try {
      if (mode === 'export') {
        const result = await window.api.yachiyo.exportProviderBackup({ password, providers })
        setBusy(false)
        if (!result.canceled) onExported(result.filePath)
        return
      }

      const result = await window.api.yachiyo.importProviderBackup({
        password,
        existingProviders: providers
      })
      setBusy(false)
      if (!result.canceled) onImported(result.providers, result.importedCount)
    } catch (reason) {
      setBusy(false)
      setError(errorMessage(reason))
    }
  }

  const isExport = mode === 'export'
  const title = t(
    isExport ? 'settings.providers.exportBackupTitle' : 'settings.providers.importBackupTitle'
  )

  return (
    <AppDialog
      title={title}
      description={t(
        isExport
          ? 'settings.providers.exportBackupDescription'
          : 'settings.providers.importBackupDescription'
      )}
      width={400}
      initialFocus="first"
      closeOnBackdrop={!busy}
      actionsLayout="horizontal"
      actions={[
        {
          key: 'submit',
          label: busy
            ? t(
                isExport
                  ? 'settings.providers.exportingBackup'
                  : 'settings.providers.importingBackup'
              )
            : t(isExport ? 'settings.providers.exportBackup' : 'settings.providers.importBackup'),
          icon: busy ? (
            <LoaderCircle className="animate-spin" size={13} strokeWidth={2} />
          ) : isExport ? (
            <Download size={13} strokeWidth={2} />
          ) : (
            <Upload size={13} strokeWidth={2} />
          ),
          tone: 'accent',
          disabled: !canSubmit
        },
        {
          key: 'cancel',
          label: t('common.cancel'),
          disabled: busy
        }
      ]}
      onAction={(key) => {
        if (key === 'submit') void submit()
        else onClose()
      }}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="space-y-3.5">
        <PasswordField
          autoComplete={isExport ? 'new-password' : 'current-password'}
          label={t('settings.providers.backupPasswordLabel')}
          shown={shown}
          value={password}
          onChange={setPassword}
          onToggleVisibility={() => setShown((current) => !current)}
        />
        <div className="text-xs" style={{ color: theme.text.muted }}>
          {t('settings.providers.backupPasswordHint', {
            count: PROVIDER_BACKUP_MIN_PASSWORD_LENGTH
          })}
        </div>

        {isExport ? (
          <PasswordField
            autoComplete="new-password"
            label={t('settings.providers.backupPasswordConfirmLabel')}
            shown={shown}
            value={confirmation}
            onChange={setConfirmation}
            onToggleVisibility={() => setShown((current) => !current)}
          />
        ) : null}

        {isExport && confirmation.length > 0 && !passwordsMatch ? (
          <div className="text-xs" style={{ color: theme.text.danger }} role="alert">
            {t('settings.providers.backupPasswordMismatch')}
          </div>
        ) : null}

        {error ? (
          <div className="text-xs leading-5" style={{ color: theme.text.danger }} role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </AppDialog>
  )
}
