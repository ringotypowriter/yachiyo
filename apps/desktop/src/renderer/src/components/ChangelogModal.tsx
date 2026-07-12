import { useCallback, useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { useT } from '@yachiyo/i18n/react'
import { theme } from '@renderer/theme/theme'
import { AppDialog } from './AppDialog'

interface ChangelogModalProps {
  version: string
  onClose: () => void
}

export function ChangelogModal({ version, onClose }: ChangelogModalProps): React.JSX.Element {
  const t = useT()
  const [notes, setNotes] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    window.api.appUpdate
      .getReleaseNotes(version)
      .then((body) => setNotes(body ?? ''))
      .catch(() => setError(true))
  }, [version])

  const handleAction = useCallback(() => onClose(), [onClose])

  return (
    <AppDialog
      title={t('shell.whatsNew', { version })}
      showCloseButton
      width={480}
      maxHeight="min(560px, 80vh)"
      bodyPadding="16px 20px"
      actions={[{ key: 'close', label: t('common.close'), autoFocus: true }]}
      actionsLayout="horizontal"
      onAction={handleAction}
      onClose={onClose}
    >
      {error ? (
        <p className="text-xs" style={{ color: theme.text.muted }}>
          {t('shell.releaseNotesFailed')}
        </p>
      ) : notes === null ? (
        <p className="text-xs" style={{ color: theme.text.muted }}>
          {t('common.loading')}
        </p>
      ) : notes === '' ? (
        <p className="text-xs" style={{ color: theme.text.muted }}>
          {t('shell.noReleaseNotes')}
        </p>
      ) : (
        <div
          className="changelog-body content-selectable text-[13px]"
          style={{ color: theme.text.primary, lineHeight: 1.6 }}
        >
          <Streamdown mode="static">{notes}</Streamdown>
        </div>
      )}
    </AppDialog>
  )
}
