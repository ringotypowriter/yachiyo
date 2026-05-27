import { AppDialog, type AppDialogActionTone } from './AppDialog'

export interface ConfirmDialogAction {
  key: string
  label: string
  tone?: AppDialogActionTone
  autoFocus?: boolean
  disabled?: boolean
}

export interface ConfirmDialogProps {
  title: string
  description?: string
  actions: ConfirmDialogAction[]
  onSelect: (key: string) => void
  onClose: () => void
}

export function ConfirmDialog({
  title,
  description,
  actions,
  onSelect,
  onClose
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <AppDialog
      title={title}
      description={description}
      actions={actions}
      onAction={onSelect}
      onClose={onClose}
      width={300}
    />
  )
}
