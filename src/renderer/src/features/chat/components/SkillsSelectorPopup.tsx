import type React from 'react'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import type { SkillCatalogEntry } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

const SKILL_LIST_MAX_HEIGHT = 320

function formatSkillDescription(description?: string): string {
  const normalized = description?.replace(/\s+/g, ' ').trim()
  return normalized && normalized.length > 0 ? normalized : 'No summary available.'
}

export function SkillsSelectorPopup({
  availableSkills,
  effectiveEnabledSkillNames,
  hasCustomOverride,
  onReset,
  onToggle,
  onClose
}: {
  availableSkills: SkillCatalogEntry[]
  effectiveEnabledSkillNames: string[]
  hasCustomOverride: boolean
  onReset: () => void
  onToggle: (skillName: string) => void
  onClose: () => void
}): React.ReactNode {
  const [visible, setVisible] = useState(false)
  const enabledSkillSet = new Set(effectiveEnabledSkillNames)

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
      aria-label="Skill selection"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        width: 320,
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
          Skills for this run
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12,
            color: theme.text.muted,
            lineHeight: 1.45
          }}
        >
          Composer choices override Settings for the next send.
        </div>
      </div>

      <div
        style={{
          padding: '8px 14px',
          borderBottom: `1px solid ${theme.border.default}`
        }}
      >
        <button
          type="button"
          onClick={onReset}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: theme.text.primary,
            textAlign: 'left'
          }}
        >
          <span>
            <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>
              Use Settings defaults
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
              {hasCustomOverride ? 'Reset this composer override.' : 'Currently active.'}
            </span>
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: hasCustomOverride ? theme.text.placeholder : theme.text.success,
              textTransform: 'uppercase',
              letterSpacing: '0.06em'
            }}
          >
            {hasCustomOverride ? 'Reset' : 'Using'}
          </span>
        </button>
      </div>

      <div
        style={{
          padding: '6px 0',
          maxHeight: SKILL_LIST_MAX_HEIGHT,
          overflowY: 'auto',
          overscrollBehavior: 'contain'
        }}
      >
        {availableSkills.length === 0 ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: theme.text.muted }}>
            No Skills are available in this workspace right now.
          </div>
        ) : (
          availableSkills.map((skill) => {
            const enabled = enabledSkillSet.has(skill.name)

            return (
              <button
                key={skill.name}
                type="button"
                role="menuitemcheckbox"
                aria-checked={enabled}
                onClick={() => onToggle(skill.name)}
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
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 5,
                    border: enabled
                      ? `1px solid ${theme.border.accent}`
                      : `1px solid ${theme.border.input}`,
                    background: enabled ? theme.background.accentSurface : 'transparent',
                    color: enabled ? theme.text.accent : theme.text.placeholder,
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
                      color: theme.text.primary,
                      letterSpacing: '-0.05px'
                    }}
                  >
                    {skill.name}
                  </span>
                  <span
                    style={{
                      marginTop: 2,
                      fontSize: 12,
                      color: theme.text.muted,
                      lineHeight: 1.4,
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: 2,
                      overflow: 'hidden'
                    }}
                  >
                    {formatSkillDescription(skill.description)}
                  </span>
                </span>

                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    fontWeight: 600,
                    color: enabled ? theme.text.success : theme.text.placeholder,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em'
                  }}
                >
                  {enabled ? 'On' : 'Off'}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
