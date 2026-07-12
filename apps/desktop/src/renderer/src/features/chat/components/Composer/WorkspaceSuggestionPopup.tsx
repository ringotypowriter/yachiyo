import { Folder } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { theme } from '@renderer/theme/theme'
import { getWorkspaceLabel } from './support.tsx'

export interface WorkspaceSuggestionPopupProps {
  workspacePath: string
  onSwitch: () => void
  onDismiss: () => void
}

export function WorkspaceSuggestionPopup({
  workspacePath,
  onSwitch,
  onDismiss
}: WorkspaceSuggestionPopupProps): React.JSX.Element {
  const t = useT()
  const folderName = getWorkspaceLabel(workspacePath)

  return (
    <div
      className="workspace-suggestion-popup"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 280,
        padding: '10px 12px',
        borderRadius: 12,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: `1px solid ${theme.border.strong}`,
        boxShadow: theme.shadow.overlay,
        zIndex: 45,
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Folder size={14} strokeWidth={1.5} color={theme.icon.accent} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: theme.text.primary,
            lineHeight: 1.35
          }}
        >
          {t('chat.workspacePicker.suggestionTitle', { name: folderName })}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="workspace-suggestion-popup__dismiss"
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${theme.border.subtle}`,
            background: 'transparent',
            color: theme.text.muted,
            cursor: 'pointer',
            lineHeight: 1.4
          }}
        >
          {t('chat.dismiss')}
        </button>
        <button
          type="button"
          className="workspace-suggestion-popup__switch"
          onClick={(e) => {
            e.stopPropagation()
            onSwitch()
          }}
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: 6,
            border: 'none',
            background: theme.background.accentPanel,
            color: theme.text.accent,
            cursor: 'pointer',
            lineHeight: 1.4
          }}
        >
          {t('chat.workspacePicker.switch')}
        </button>
      </div>
    </div>
  )
}
