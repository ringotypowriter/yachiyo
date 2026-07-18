import type React from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Folder, Plus } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { theme } from '@renderer/theme/theme'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'
import { SettingsShortcutButton } from './SettingsShortcutButton'
import { getWorkspaceLabel } from './Composer/support.tsx'

function WorkspaceOption({
  description,
  icon,
  isSelected,
  label,
  onSelect
}: {
  description: string
  icon: React.ReactNode
  isSelected: boolean
  label: string
  onSelect: () => void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 10,
        padding: '9px 14px',
        textAlign: 'left',
        border: 'none',
        background: isSelected
          ? theme.background.accentMuted
          : hovered
            ? theme.background.hover
            : 'transparent',
        cursor: 'default',
        transition: 'background 0.12s ease'
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: isSelected ? theme.icon.accent : theme.icon.muted,
          flexShrink: 0
        }}
      >
        {isSelected ? <Check size={12} strokeWidth={2.4} /> : icon}
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            color: isSelected ? theme.text.accent : theme.text.primary,
            fontWeight: isSelected ? 600 : 500,
            lineHeight: 1.35
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 2,
            fontSize: 12,
            color: theme.text.muted,
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {description}
        </span>
      </span>
    </button>
  )
}

export function WorkspaceSelectorPopup({
  currentWorkspacePath,
  onChooseDirectory,
  onClose,
  onSelectWorkspace,
  savedPaths,
  triggerRef
}: {
  currentWorkspacePath: string | null
  onChooseDirectory: () => void
  onClose: () => void
  onSelectWorkspace: (workspacePath: string | null) => void
  savedPaths: string[]
  triggerRef: React.RefObject<HTMLElement | null>
}): React.ReactNode {
  const t = useT()
  const [visible, setVisible] = useState(false)
  const {
    floatingRef,
    layout,
    style: positionStyle
  } = useFloatingPanelLayout({
    open: true,
    referenceRef: triggerRef,
    width: 340,
    maxHeight: 360,
    preferredPlacement: 'top'
  })
  useRestoreFocusOnUnmount()

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isDismissEscapeKey(event)) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      ref={floatingRef}
      data-composer-floating-menu
      role="menu"
      aria-label={t('chat.workspacePicker.ariaLabel')}
      style={{
        ...positionStyle,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 16,
        boxShadow: theme.shadow.overlay,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 120,
        opacity: visible ? 1 : 0,
        transform: visible
          ? 'translateY(0)'
          : layout?.placement === 'bottom'
            ? 'translateY(-6px)'
            : 'translateY(6px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      <div
        style={{
          padding: '11px 14px 10px',
          borderBottom: `1px solid ${theme.border.panel}`
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontWeight: 600,
              color: theme.text.primary
            }}
          >
            {t('chat.workspacePicker.title')}
          </div>
          <SettingsShortcutButton
            label={t('chat.workspacePicker.openWorkspaceSettings')}
            route="capabilities/workspace"
            onClose={onClose}
          />
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12,
            color: theme.text.muted,
            lineHeight: 1.45
          }}
        >
          {t('chat.workspacePicker.tempNote')}
        </div>
      </div>

      <div
        style={{
          overflowY: 'auto',
          flex: 1,
          padding: '6px 0'
        }}
      >
        <WorkspaceOption
          icon={<Folder size={13} strokeWidth={1.8} />}
          label={t('chat.workspacePicker.tempWorkspace')}
          description={t('chat.workspacePicker.tempDescription')}
          isSelected={currentWorkspacePath === null}
          onSelect={() => {
            onSelectWorkspace(null)
            onClose()
          }}
        />

        {savedPaths.map((workspacePath) => (
          <WorkspaceOption
            key={workspacePath}
            icon={<Folder size={13} strokeWidth={1.8} />}
            label={getWorkspaceLabel(workspacePath)}
            description={workspacePath}
            isSelected={currentWorkspacePath === workspacePath}
            onSelect={() => {
              onSelectWorkspace(workspacePath)
              onClose()
            }}
          />
        ))}
      </div>

      <div
        style={{
          padding: '8px 10px 10px',
          borderTop: `1px solid ${theme.border.default}`
        }}
      >
        <button
          type="button"
          onClick={() => {
            onChooseDirectory()
            onClose()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '10px 12px',
            borderRadius: 12,
            border: `1px solid ${theme.border.input}`,
            background: theme.background.surface,
            color: theme.text.primary,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'default'
          }}
        >
          <Plus size={14} strokeWidth={2} />
          {t('chat.workspacePicker.selectDirectory')}
        </button>
      </div>
    </div>,
    document.body
  )
}
