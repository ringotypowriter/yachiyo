import type React from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { ComposerReasoningSelection } from '@renderer/app/types'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'
import { useT } from '@yachiyo/i18n/react'
import { getReasoningSelectionCopy } from '../lib/composer/reasoningSelectionLabel'
import { SettingsShortcutButton } from './SettingsShortcutButton'

export function ReasoningSelectorPopup({
  options,
  selected,
  onSelect,
  onClose,
  triggerRef
}: {
  options: ComposerReasoningSelection[]
  selected: ComposerReasoningSelection
  onSelect: (selection: ComposerReasoningSelection) => void
  onClose: () => void
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
    width: 260,
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
      aria-label={t('chat.composer.reasoningEffort')}
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
            {t('chat.reasoning.title')}
          </div>
          <SettingsShortcutButton
            label={t('chat.modelPicker.openProviderSettings')}
            route="providers"
            onClose={onClose}
          />
        </div>
      </div>

      <div style={{ padding: '6px 0', minHeight: 0, overflowY: 'auto' }}>
        {options.map((option) => {
          const active = option === selected
          const copy = getReasoningSelectionCopy(option)

          return (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => {
                onSelect(option)
                onClose()
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                gap: 10,
                padding: '8px 14px',
                background: 'transparent',
                border: 'none',
                cursor: 'default',
                textAlign: 'left',
                transition: 'background 0.12s ease'
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = theme.background.hover
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent'
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: active ? theme.icon.accent : theme.icon.muted
                }}
              >
                {active ? <Check size={15} strokeWidth={2} /> : null}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, color: theme.text.primary }}>
                  {copy.label}
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 2,
                    fontSize: 11,
                    color: theme.text.muted,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {copy.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>,
    document.body
  )
}
