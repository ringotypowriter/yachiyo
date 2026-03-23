import type React from 'react'
import { useEffect, useState } from 'react'
import { Hash, Sparkles, Zap } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

export interface SlashCommand {
  key: string
  label: string
  description: string
  type: 'action' | 'prompt' | 'skill' | 'skill-prefix'
}

const TYPE_ICONS = {
  action: Zap,
  prompt: Hash,
  skill: Sparkles,
  'skill-prefix': Sparkles
} satisfies Record<
  SlashCommand['type'],
  React.ComponentType<{ size: number; strokeWidth: number; color: string }>
>

function CommandKey({ command }: { command: SlashCommand }): React.ReactNode {
  const muted = { fontFamily: 'monospace', fontSize: 12, color: theme.text.muted }
  const accent = {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.accent
  }

  if (command.type === 'skill') {
    return (
      <>
        <span style={muted}>/skills:</span>
        <span style={accent}>{command.label}</span>
      </>
    )
  }

  if (command.type === 'skill-prefix') {
    return (
      <>
        <span style={muted}>/</span>
        <span style={accent}>skills</span>
        <span style={muted}>:…</span>
      </>
    )
  }

  return (
    <>
      <span style={muted}>/</span>
      <span style={accent}>{command.key}</span>
    </>
  )
}

export function SlashCommandPopup({
  commands,
  selectedIndex,
  onSelect,
  onClose
}: {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
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
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 280,
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
      {commands.map((command, index) => {
        const isSelected = index === selectedIndex
        const Icon = TYPE_ICONS[command.type]
        return (
          <button
            key={command.key}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(command)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 14px',
              background: isSelected ? theme.background.hoverStrong : 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
              transition: 'background 0.1s ease'
            }}
          >
            <Icon size={13} strokeWidth={1.7} color={theme.icon.muted} />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                <CommandKey command={command} />
              </div>
              <div
                style={{
                  marginTop: 1,
                  fontSize: 11,
                  color: theme.text.muted,
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '100%'
                }}
              >
                {command.description}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
