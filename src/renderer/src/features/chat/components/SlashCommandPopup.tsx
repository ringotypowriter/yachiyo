import type React from 'react'
import { useEffect, useState } from 'react'
import { Folder, Hash, Sparkles, Zap } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

export interface SlashCommand {
  key: string
  label: string
  description: string
  type: 'action' | 'prompt' | 'skill' | 'skill-prefix' | 'file'
}

const TYPE_ICONS = {
  action: Zap,
  prompt: Hash,
  skill: Sparkles,
  'skill-prefix': Sparkles,
  file: Folder
} satisfies Record<
  SlashCommand['type'],
  React.ComponentType<{ size: number; strokeWidth: number; color: string }>
>

const FILE_LABEL_MAX_CHARS = 56

function trimFileLabelFromStart(label: string): string {
  if (label.length <= FILE_LABEL_MAX_CHARS) {
    return label
  }

  return `...${label.slice(-(FILE_LABEL_MAX_CHARS - 3))}`
}

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

  if (command.type === 'file') {
    return (
      <span
        style={{
          ...accent,
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          overflow: 'hidden',
          lineHeight: 1.45,
          wordBreak: 'break-all',
          whiteSpace: 'normal'
        }}
      >
        {trimFileLabelFromStart(command.label)}
      </span>
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
  onClose,
  emptyState,
  leftOffset = 0
}: {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
  onClose: () => void
  emptyState?: string
  leftOffset?: number
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
        left: leftOffset,
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
      {commands.length === 0 ? (
        <div
          style={{
            padding: '11px 14px',
            fontSize: 12,
            lineHeight: 1.5,
            color: theme.text.muted
          }}
        >
          {emptyState ?? 'No results'}
        </div>
      ) : null}
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
            <div
              style={{
                width: 16,
                minWidth: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <Icon size={13} strokeWidth={1.7} color={theme.icon.muted} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: command.type === 'file' ? 'flex-start' : 'baseline',
                  gap: 1,
                  minWidth: 0
                }}
              >
                <CommandKey command={command} />
              </div>
              {command.type === 'file' ? null : (
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
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
