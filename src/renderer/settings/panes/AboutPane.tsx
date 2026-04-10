import { useEffect, useState } from 'react'
import { theme, alpha } from '@renderer/theme/theme'
import type { SettingsConfig } from '../../../shared/yachiyo/protocol.ts'
import avatarUrl from '../../../../resources/branding.jpeg'
import { SettingSwitch } from '../components/primitives'

declare const __APP_VERSION__: string

interface ThirdPartyEntry {
  name: string
  license: string
  url: string
}

const thirdPartyDeps: ThirdPartyEntry[] = [
  {
    name: '@agentclientprotocol/sdk',
    license: 'Apache-2.0',
    url: 'https://github.com/acprotocol/agent-client-protocol'
  },
  { name: 'ai (Vercel AI SDK)', license: 'Apache-2.0', url: 'https://github.com/vercel/ai' },
  { name: 'better-sqlite3', license: 'MIT', url: 'https://github.com/WiseLibs/better-sqlite3' },
  { name: 'defuddle', license: 'MIT', url: 'https://github.com/kepano/defuddle' },
  { name: 'discord.js', license: 'Apache-2.0', url: 'https://github.com/discordjs/discord.js' },
  {
    name: 'drizzle-orm',
    license: 'Apache-2.0',
    url: 'https://github.com/drizzle-team/drizzle-orm'
  },
  {
    name: 'eventsource-parser',
    license: 'MIT',
    url: 'https://github.com/rexxars/eventsource-parser'
  },
  { name: 'fd', license: 'MIT', url: 'https://github.com/sharkdp/fd' },
  { name: 'framer-motion', license: 'MIT', url: 'https://github.com/framer/motion' },
  { name: 'htmlparser2', license: 'MIT', url: 'https://github.com/fb55/htmlparser2' },
  { name: 'ignore', license: 'MIT', url: 'https://github.com/kaelzhang/node-ignore' },
  { name: 'json-schema', license: 'AFL-2.1/BSD-3', url: 'https://github.com/kriszyp/json-schema' },
  { name: 'linkedom', license: 'ISC', url: 'https://github.com/WebReflection/linkedom' },
  { name: 'lucide-react', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
  { name: 'react', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'react-dom', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'ripgrep', license: 'MIT', url: 'https://github.com/BurntSushi/ripgrep' },
  { name: 'sharp', license: 'Apache-2.0', url: 'https://github.com/lovell/sharp' },
  { name: 'smol-toml', license: 'BSD-3-Clause', url: 'https://github.com/squirrelchat/smol-toml' },
  {
    name: 'streamdown',
    license: 'Apache-2.0',
    url: 'https://github.com/vercel/streamdown'
  },
  { name: '@tanstack/react-query', license: 'MIT', url: 'https://github.com/TanStack/query' },
  { name: 'telegraf', license: 'MIT', url: 'https://github.com/telegraf/telegraf' },
  { name: 'zod', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
  { name: 'zustand', license: 'MIT', url: 'https://github.com/pmndrs/zustand' }
]

interface AboutPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}

export function AboutPane({ draft, onChange }: AboutPaneProps): React.ReactNode {
  const isDevelopment = import.meta.env.DEV
  const [hovered, setHovered] = useState(false)
  const [showNotices, setShowNotices] = useState(false)
  const [updateState, setUpdateState] = useState<{
    state: string
    version?: string
    percent?: number
    error?: string
  }>({ state: 'idle' })

  useEffect(() => {
    window.api.appUpdate.getStatus().then(setUpdateState)
    return window.api.appUpdate.onStatus(setUpdateState)
  }, [])

  return (
    <div className="flex-1 relative overflow-hidden" style={{ userSelect: 'none' }}>
      {/* Hero — always centered, never moves */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0">
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
        <a
          href="https://github.com/ringotypowriter/yachiyo"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 text-2xl font-semibold"
          style={{
            fontFamily: theme.font.display,
            color: theme.text.primary,
            letterSpacing: '-0.4px',
            textDecoration: 'none',
            cursor: 'pointer'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = theme.text.accent
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = theme.text.primary
          }}
        >
          Yachiyo
        </a>

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

        {/* License badge */}
        <div className="mt-3 text-xs" style={{ color: theme.text.muted }}>
          Apache-2.0 License
        </div>

        {/* Update status */}
        <div
          className="mt-4 flex flex-col items-center justify-center gap-1"
          style={{ minHeight: 28, flexShrink: 0 }}
        >
          {(updateState.state === 'idle' || updateState.state === 'error') && (
            <>
              <button
                type="button"
                onClick={() => window.api.appUpdate.check()}
                className="text-xs font-medium px-3 py-1.5 rounded-full"
                style={{
                  background: alpha('ink', 0.05),
                  color: theme.text.secondary,
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                {updateState.state === 'error' ? 'Retry update check' : 'Check for updates'}
              </button>
              {updateState.state === 'error' && updateState.error && (
                <span
                  className="text-[11px] text-center px-4"
                  style={{ color: theme.text.muted, maxWidth: 260 }}
                  title={updateState.error}
                >
                  {updateState.error}
                </span>
              )}
            </>
          )}
          {updateState.state === 'checking' && (
            <span className="text-xs" style={{ color: theme.text.muted }}>
              Checking for updates...
            </span>
          )}
          {updateState.state === 'available' && (
            <>
              <button
                type="button"
                onClick={() => window.api.appUpdate.download()}
                className="text-xs font-medium px-3 py-1.5 rounded-full"
                style={{
                  background: alpha('accent', 0.12),
                  color: theme.text.accent,
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                v{updateState.version} available — download
              </button>
              <button
                type="button"
                onClick={() => window.api.appUpdate.check()}
                className="text-[11px]"
                style={{
                  color: theme.text.muted,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = theme.text.secondary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = theme.text.muted
                }}
              >
                Check again
              </button>
            </>
          )}
          {updateState.state === 'downloading' && (
            <span className="text-xs" style={{ color: theme.text.muted }}>
              Downloading{updateState.percent !== undefined ? ` ${updateState.percent}%` : '…'}
            </span>
          )}
          {updateState.state === 'ready' && (
            <button
              type="button"
              onClick={() => window.api.appUpdate.install()}
              className="text-xs font-medium px-3 py-1.5 rounded-full"
              style={{
                background: alpha('accent', 0.12),
                color: theme.text.accent,
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Restart to install v{updateState.version}
            </button>
          )}
        </div>
      </div>

      {/* Bottom overlay — notices + toggle, layered above hero */}
      <div
        className="absolute bottom-0 left-0 right-0 flex flex-col"
        style={{ zIndex: 10, pointerEvents: 'none' }}
      >
        {/* Notices panel — slides up from footer */}
        {showNotices && (
          <div
            className="overflow-y-auto px-7 pb-2"
            style={{
              maxHeight: 280,
              background: theme.background.surface,
              borderTop: `1px solid ${theme.border.subtle}`,
              pointerEvents: 'auto'
            }}
          >
            <div className="flex flex-col gap-0.5 pt-3">
              {thirdPartyDeps.map((dep) => (
                <div
                  key={dep.name}
                  className="flex items-center justify-between py-1.5"
                  style={{ borderBottom: `1px solid ${alpha('ink', 0.04)}` }}
                >
                  <a
                    href={dep.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs"
                    style={{
                      color: theme.text.primary,
                      textDecoration: 'none',
                      cursor: 'pointer',
                      userSelect: 'auto'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = theme.text.accent
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = theme.text.primary
                    }}
                  >
                    {dep.name}
                  </a>
                  <span
                    className="text-[10px] font-mono shrink-0 ml-3"
                    style={{ color: theme.text.muted }}
                  >
                    {dep.license}
                  </span>
                </div>
              ))}
            </div>
            <div
              className="mt-3 pb-1 text-[11px] leading-relaxed"
              style={{ color: theme.text.muted }}
            >
              Full license texts are available in the NOTICE file at the project root.
            </div>
          </div>
        )}

        {isDevelopment ? (
          <div
            className="shrink-0 flex items-center justify-between gap-4 px-7 py-3"
            style={{
              borderTop: `1px solid ${theme.border.subtle}`,
              background: theme.background.surface,
              pointerEvents: 'auto'
            }}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Demo mode
              </div>
              <div className="text-[11px] leading-relaxed" style={{ color: theme.text.muted }}>
                Use in-memory screenshot data instead of your normal development database after
                saving. Production never uses this mode.
              </div>
            </div>
            <SettingSwitch
              ariaLabel="Toggle demo mode"
              checked={draft.general?.demoMode === true}
              onChange={() =>
                onChange({
                  ...draft,
                  general: {
                    ...draft.general,
                    demoMode: draft.general?.demoMode !== true
                  }
                })
              }
            />
          </div>
        ) : null}

        <div
          className="shrink-0 flex items-center justify-center py-3"
          style={{
            borderTop: `1px solid ${theme.border.subtle}`,
            background: theme.background.surface,
            pointerEvents: 'auto'
          }}
        >
          <button
            type="button"
            onClick={() => setShowNotices((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderRadius: 6,
              color: theme.text.muted,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.02em'
            }}
          >
            <span>Third-Party Notices</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: showNotices ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 200ms ease'
              }}
            >
              <path d="M2 6.5L5 3.5L8 6.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
