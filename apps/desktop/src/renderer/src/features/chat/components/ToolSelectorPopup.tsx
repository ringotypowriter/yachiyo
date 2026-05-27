import type React from 'react'
import { useEffect, useState } from 'react'
import * as Icons from 'lucide-react'
import { Check } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import type { RunModeId, SelectableRunModeId } from '@yachiyo/shared/protocol'
import { RUN_MODE_DEFINITIONS, SELECTABLE_RUN_MODE_IDS } from '@yachiyo/shared/toolModes'

const MODE_LIST_MAX_HEIGHT = 320

function getModeIcon(iconName: string): React.ElementType {
  return (Icons as unknown as Record<string, React.ElementType>)[iconName] ?? Icons.Wrench
}

export function ToolSelectorPopup({
  runMode,
  hasActiveRun,
  onSelectMode,
  onClose
}: {
  runMode: RunModeId
  hasActiveRun: boolean
  onSelectMode: (runMode: SelectableRunModeId) => void
  onClose: () => void
}): React.ReactNode {
  const [visible, setVisible] = useState(false)
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

  return (
    <div
      role="menu"
      aria-label="Run mode"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 300,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 16,
        boxShadow: theme.shadow.overlay,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 50,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      <div
        style={{
          padding: '10px 14px 8px',
          borderBottom: `1px solid ${theme.border.panel}`
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: theme.text.primary,
            letterSpacing: '-0.1px'
          }}
        >
          Mode
        </div>
      </div>

      <div
        style={{
          padding: '4px 0',
          maxHeight: MODE_LIST_MAX_HEIGHT,
          overflowY: 'auto',
          overscrollBehavior: 'contain'
        }}
      >
        {SELECTABLE_RUN_MODE_IDS.map((modeId) => {
          const selected = runMode === modeId
          const mode = RUN_MODE_DEFINITIONS[modeId]
          const ModeIcon = getModeIcon(mode.iconName)

          return (
            <button
              key={modeId}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => {
                onSelectMode(modeId)
                onClose()
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                width: '100%',
                gap: 8,
                padding: '8px 12px',
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
              <ModeIcon
                size={14}
                strokeWidth={1.5}
                color={selected ? theme.text.accent : theme.text.muted}
                style={{ flexShrink: 0, marginTop: 2 }}
              />

              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: selected ? theme.text.accent : theme.text.primary,
                    letterSpacing: '-0.05px'
                  }}
                >
                  {mode.label}
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 2,
                    fontSize: 12,
                    color: theme.text.muted,
                    lineHeight: 1.4
                  }}
                >
                  {mode.description}
                </span>
              </span>

              {selected ? (
                <Check
                  size={14}
                  strokeWidth={2.5}
                  color={theme.text.accent}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
              ) : null}
            </button>
          )
        })}
      </div>

      <div
        style={{
          padding: '8px 14px 10px',
          borderTop: `1px solid ${theme.border.default}`,
          fontSize: 11.5,
          color: theme.text.muted,
          lineHeight: 1.45
        }}
      >
        {hasActiveRun
          ? 'The current run keeps its existing mode. Your change applies to the next send.'
          : 'Your next send uses this mode.'}
      </div>
    </div>
  )
}
