import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder, Hash, NotebookPen, Sparkles, Zap } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

export interface SlashCommand {
  key: string
  label: string
  description: string
  type: 'action' | 'prompt' | 'skill' | 'skill-prefix' | 'file' | 'jotdown'
}

const TYPE_ICONS = {
  action: Zap,
  prompt: Hash,
  skill: Sparkles,
  'skill-prefix': Sparkles,
  file: Folder,
  jotdown: NotebookPen
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

  if (command.type === 'file' || command.type === 'jotdown') {
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
  onReachEnd,
  emptyState,
  leftOffset = 0,
  anchorRect,
  portal = false
}: {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: SlashCommand) => void
  onClose: () => void
  onReachEnd?: () => void
  emptyState?: string
  leftOffset?: number
  anchorRect?: DOMRect | null
  portal?: boolean
}): React.ReactNode {
  const [visible, setVisible] = useState(false)
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null)

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

  useEffect(() => {
    selectedOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleCommandListScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    if (!onReachEnd) return

    const target = event.currentTarget
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distanceFromBottom <= 48) {
      onReachEnd()
    }
  }

  const popupWidth = 280
  const margin = 8
  const popupMaxHeight = Math.max(180, Math.min(420, window.innerHeight - 96))
  const popupLeft = anchorRect
    ? Math.max(margin, Math.min(anchorRect.left, window.innerWidth - popupWidth - margin))
    : leftOffset

  const popupStyle: React.CSSProperties =
    portal && anchorRect
      ? {
          position: 'fixed',
          bottom: window.innerHeight - anchorRect.top + 8,
          left: popupLeft,
          width: popupWidth
        }
      : {
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: popupLeft,
          width: popupWidth
        }

  const popup = (
    <div
      role="listbox"
      aria-label="Slash commands"
      style={{
        ...popupStyle,
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
      {commands.length > 0 ? (
        <div
          onScroll={handleCommandListScroll}
          style={{
            maxHeight: popupMaxHeight - 35,
            overflowY: 'auto',
            overscrollBehavior: 'contain'
          }}
        >
          {commands.map((command, index) => {
            const isSelected = index === selectedIndex
            const Icon = TYPE_ICONS[command.type]
            return (
              <button
                key={command.key}
                ref={isSelected ? selectedOptionRef : undefined}
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
      ) : null}
      {commands.length > 0 ? (
        <div
          style={{
            padding: '6px 14px',
            fontSize: 10,
            lineHeight: 1.4,
            color: theme.text.muted,
            borderTop: `1px solid rgba(0,0,0,0.06)`,
            fontFamily: 'monospace',
            display: 'flex',
            gap: 10
          }}
        >
          <span>Tab complete</span>
          <span>Enter select</span>
          <span>Esc close</span>
        </div>
      ) : null}
    </div>
  )

  if (portal && anchorRect) {
    return createPortal(popup, document.body)
  }

  return popup
}
