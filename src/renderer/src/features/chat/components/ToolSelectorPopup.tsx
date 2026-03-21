import type React from 'react'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { ToolCallName } from '@renderer/app/types'
import { CORE_TOOL_NAMES } from '../../../../../shared/yachiyo/protocol.ts'

const TOOL_COPY: Record<
  ToolCallName,
  {
    description: string
    label: string
  }
> = {
  read: {
    label: 'read',
    description: 'Open files from the workspace'
  },
  write: {
    label: 'write',
    description: 'Create or replace files directly'
  },
  edit: {
    label: 'edit',
    description: 'Make targeted text replacements'
  },
  bash: {
    label: 'bash',
    description: 'Run shell commands in the workspace'
  },
  webRead: {
    label: 'webRead',
    description: 'Read static web pages as clean content'
  },
  webSearch: {
    label: 'webSearch',
    description: 'Search the web and return normalized results'
  }
}

export function ToolSelectorPopup({
  enabledTools,
  hasActiveRun,
  onToggle,
  onClose
}: {
  enabledTools: ToolCallName[]
  hasActiveRun: boolean
  onToggle: (toolName: ToolCallName) => void
  onClose: () => void
}): React.ReactNode {
  const [visible, setVisible] = useState(false)
  const enabledToolSet = new Set(enabledTools)

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
      aria-label="Tool availability"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 280,
        background: 'rgba(248,247,245,0.97)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(0,0,0,0.1)',
        borderRadius: 16,
        boxShadow: '0 8px 40px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.07)',
        overflow: 'hidden',
        zIndex: 50,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      <div
        style={{
          padding: '11px 14px 10px',
          borderBottom: '1px solid rgba(0,0,0,0.07)'
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#2D2D2B',
            letterSpacing: '-0.1px'
          }}
        >
          Tools for future sends
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12,
            color: '#8e8e93',
            lineHeight: 1.45
          }}
        >
          This changes tool availability, not your message content.
        </div>
      </div>

      <div style={{ padding: '6px 0' }}>
        {CORE_TOOL_NAMES.map((toolName) => {
          const enabled = enabledToolSet.has(toolName)
          const copy = TOOL_COPY[toolName]

          return (
            <button
              key={toolName}
              type="button"
              role="menuitemcheckbox"
              aria-checked={enabled}
              onClick={() => onToggle(toolName)}
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
                event.currentTarget.style.background = 'rgba(0,0,0,0.04)'
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
                  borderRadius: 5,
                  border: enabled
                    ? '1px solid rgba(204,125,94,0.28)'
                    : '1px solid rgba(0,0,0,0.12)',
                  background: enabled ? 'rgba(204,125,94,0.12)' : 'transparent',
                  color: enabled ? '#CC7D5E' : '#c2c1bc',
                  flexShrink: 0
                }}
              >
                {enabled ? <Check size={11} strokeWidth={2.5} /> : null}
              </span>

              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontFamily: '"SF Mono", "Monaco", monospace',
                    fontSize: 12,
                    color: '#2D2D2B',
                    letterSpacing: '-0.05px'
                  }}
                >
                  {copy.label}
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 2,
                    fontSize: 12,
                    color: '#8e8e93',
                    lineHeight: 1.4
                  }}
                >
                  {copy.description}
                </span>
              </span>

              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  color: enabled ? '#5CAD8A' : '#aaa9a4',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em'
                }}
              >
                {enabled ? 'On' : 'Off'}
              </span>
            </button>
          )
        })}
      </div>

      <div
        style={{
          padding: '10px 14px 12px',
          borderTop: '1px solid rgba(0,0,0,0.06)',
          fontSize: 11.5,
          color: '#8e8e93',
          lineHeight: 1.45
        }}
      >
        {hasActiveRun
          ? 'The current run keeps its existing tool set. Your changes apply to the next send.'
          : 'Your next send uses exactly the tools enabled here.'}
      </div>
    </div>
  )
}
