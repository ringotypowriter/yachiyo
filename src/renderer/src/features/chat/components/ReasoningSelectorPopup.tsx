import type React from 'react'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { ComposerReasoningSelection } from '@renderer/app/types'
import { REASONING_SELECTION_COPY } from '../lib/reasoningSelectionLabel'

export function ReasoningSelectorPopup({
  options,
  selected,
  onSelect,
  onClose
}: {
  options: ComposerReasoningSelection[]
  selected: ComposerReasoningSelection
  onSelect: (selection: ComposerReasoningSelection) => void
  onClose: () => void
}): React.ReactNode {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      role="menu"
      aria-label="Reasoning effort"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 260,
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
        <div style={{ fontSize: 12, fontWeight: 600, color: theme.text.primary }}>Reasoning</div>
      </div>

      <div style={{ padding: '6px 0' }}>
        {options.map((option) => {
          const active = option === selected
          const copy = REASONING_SELECTION_COPY[option]

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
                cursor: 'pointer',
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
    </div>
  )
}
