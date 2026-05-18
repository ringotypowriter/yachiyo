import type React from 'react'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import type { RunModeId, SelectableRunModeId } from '../../../../../shared/yachiyo/protocol.ts'
import {
  RUN_MODE_DEFINITIONS,
  SELECTABLE_RUN_MODE_IDS
} from '../../../../../shared/yachiyo/toolModes.ts'

const MODE_LIST_MAX_HEIGHT = 320

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
          padding: '11px 14px 10px',
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
        <div
          style={{
            marginTop: 3,
            fontSize: 12,
            color: theme.text.muted,
            lineHeight: 1.45
          }}
        >
          Choose how Yachiyo should use tools and context for the next turn.
        </div>
      </div>

      <div
        style={{
          padding: '6px 0',
          maxHeight: MODE_LIST_MAX_HEIGHT,
          overflowY: 'auto',
          overscrollBehavior: 'contain'
        }}
      >
        {SELECTABLE_RUN_MODE_IDS.map((modeId) => {
          const selected = runMode === modeId
          const mode = RUN_MODE_DEFINITIONS[modeId]

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
                alignItems: 'center',
                width: '100%',
                gap: 10,
                padding: '9px 14px',
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
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  border: selected
                    ? `1px solid ${theme.border.accent}`
                    : `1px solid ${theme.border.input}`,
                  background: selected ? theme.background.accentSurface : 'transparent',
                  color: selected ? theme.text.accent : theme.text.placeholder,
                  flexShrink: 0
                }}
              >
                {selected ? <Check size={11} strokeWidth={2.5} /> : null}
              </span>

              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: theme.text.primary,
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
            </button>
          )
        })}

        {runMode === 'custom' ? (
          <div
            style={{
              margin: '6px 14px 2px',
              padding: '9px 10px',
              borderRadius: 10,
              background: theme.background.surfaceMuted,
              color: theme.text.muted,
              fontSize: 12,
              lineHeight: 1.45
            }}
          >
            Custom legacy tool set is active. Choose a mode to replace it.
          </div>
        ) : null}
      </div>

      <div
        style={{
          padding: '10px 14px 12px',
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
