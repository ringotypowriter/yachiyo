import { useState } from 'react'
import { theme } from '@renderer/theme/theme'
import avatarUrl from '../../../../resources/branding.jpeg'

declare const __APP_VERSION__: string

export function AboutPane(): React.ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-0"
      style={{ userSelect: 'none' }}
    >
      {/* Avatar */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: 96,
          height: 96,
          borderRadius: '50%',
          overflow: 'hidden',
          cursor: 'default',
          boxShadow: hovered
            ? `0 0 0 1.5px ${theme.border.accentStrong},
               0 0 16px 4px rgba(100,160,210,0.28),
               0 0 40px 10px rgba(100,160,210,0.12)`
            : `0 0 0 1px ${theme.border.subtle},
               0 4px 16px rgba(0,0,0,0.08)`,
          transition: 'box-shadow 600ms ease'
        }}
      >
        <img
          src={avatarUrl}
          alt="Yachiyo"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center 15%',
            filter: hovered ? 'brightness(1.06)' : 'brightness(1)',
            transition: 'filter 600ms ease'
          }}
        />
      </div>

      {/* App name */}
      <div
        className="mt-5 text-2xl font-semibold"
        style={{ color: theme.text.primary, letterSpacing: '-0.4px' }}
      >
        Yachiyo
      </div>

      {/* Version */}
      <div className="mt-1.5 text-xs font-mono" style={{ color: theme.text.muted }}>
        v{__APP_VERSION__}
      </div>

      {/* Divider */}
      <div
        className="mt-6 mb-5"
        style={{ width: 32, height: 1, background: theme.border.subtle }}
      />

      {/* Author */}
      <div className="text-sm" style={{ color: theme.text.tertiary }}>
        Made by <span style={{ color: theme.text.secondary, fontWeight: 500 }}>Ringo</span>
      </div>
    </div>
  )
}
