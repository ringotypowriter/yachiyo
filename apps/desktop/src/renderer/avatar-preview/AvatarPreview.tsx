import { useEffect, useState } from 'react'
import { YachiyoAvatar } from '@renderer/components/avatar/YachiyoAvatar'
import type { AvatarPhase } from '@renderer/components/avatar/avatarTypes'
import { theme, THEME_OPTIONS, type ThemeId } from '@renderer/theme/theme'
import { applyThemeAttributes } from '@renderer/theme/themeRuntime'
import { SimpleSelect } from '../settings/components/primitives'

const phases: AvatarPhase[] = [
  'loading',
  'thinking',
  'speaking',
  'working',
  'waiting',
  'idle',
  'success'
]

export function AvatarPreview(): React.JSX.Element {
  const [phase, setPhase] = useState<AvatarPhase>('loading')
  const [themeId, setThemeId] = useState<ThemeId>('mizu')
  const [variant, setVariant] = useState<'light' | 'dark'>('light')
  const [wink, setWink] = useState(0)
  const [cycling, setCycling] = useState(false)
  useEffect(() => {
    applyThemeAttributes({ themeId, variant, appearance: variant })
  }, [themeId, variant])
  useEffect(() => {
    if (!cycling) return
    const timer = setInterval(
      () => setPhase((current) => phases[(phases.indexOf(current) + 1) % phases.length]),
      2400
    )
    return () => clearInterval(timer)
  }, [cycling])
  const buttonStyle = {
    border: `1px solid ${theme.border.strong}`,
    borderRadius: 8,
    padding: '7px 12px',
    cursor: 'pointer'
  }
  return (
    <main
      style={{
        height: '100%',
        overflow: 'auto',
        background: theme.background.canvas,
        padding: '40px max(24px, calc((100vw - 960px) / 2))',
        color: theme.text.primary
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-5">
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 600 }}>Yachiyo, in motion.</h1>
          <p style={{ color: theme.text.secondary, marginTop: 6 }}>
            One little body. Every state of mind.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a href="./conversation.html" style={{ ...buttonStyle, fontSize: 12 }}>
            Layout study
          </a>
          <SimpleSelect
            value={themeId}
            onChange={setThemeId}
            options={THEME_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            width={150}
          />
          <button
            style={buttonStyle}
            onClick={() => setVariant(variant === 'light' ? 'dark' : 'light')}
          >
            {variant === 'light' ? 'Dark' : 'Light'}
          </button>
        </div>
      </header>
      <section
        className="flex flex-col items-center justify-center gap-6"
        style={{ minHeight: 310 }}
      >
        <div data-testid="hero-avatar">
          <YachiyoAvatar phase={phase} size="display" wink={wink} label={`Yachiyo: ${phase}`} />
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {phases.map((value) => (
            <button
              key={value}
              data-phase-button={value}
              onClick={() => setPhase(value)}
              style={{
                ...buttonStyle,
                background: phase === value ? theme.text.accent : 'transparent',
                color: phase === value ? theme.text.onAccent : theme.text.primary
              }}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="flex gap-3">
          <button
            style={buttonStyle}
            onClick={() => {
              if (phase === 'loading') setPhase('idle')
              setWink((value) => value + 1)
            }}
          >
            Wink
          </button>
          <button style={buttonStyle} onClick={() => setCycling(!cycling)}>
            {cycling ? 'Pause cycle' : 'Cycle states'}
          </button>
          <button
            style={buttonStyle}
            onClick={() => setPhase(phase === 'loading' ? 'thinking' : 'loading')}
          >
            Merge / split
          </button>
        </div>
      </section>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))',
          gap: 20,
          borderTop: `1px solid ${theme.border.strong}`,
          paddingTop: 30
        }}
      >
        {phases.map((value) => (
          <div key={value} className="flex flex-col items-center gap-4">
            <YachiyoAvatar phase={value} size="display" />
            <span style={{ fontSize: 12, color: theme.text.secondary }}>{value}</span>
          </div>
        ))}
      </section>
      <section style={{ display: 'flex', justifyContent: 'center', gap: 50, marginTop: 60 }}>
        {(['compact', 'inline', 'display'] as const).map((size) => (
          <div key={size} className="flex flex-col items-center justify-end gap-4">
            <YachiyoAvatar phase={phase} size={size} />
            <span style={{ fontSize: 12, color: theme.text.secondary }}>{size}</span>
          </div>
        ))}
      </section>
      <p style={{ color: theme.text.muted, fontSize: 12, marginTop: 48 }}>
        Switch states rapidly to interrupt a morph. System reduced-motion preferences are respected.
      </p>
    </main>
  )
}
