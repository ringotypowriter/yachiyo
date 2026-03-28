import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'

import type {
  ChannelsConfig,
  ChannelUserRecord,
  ChannelUserStatus,
  SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'
import { SettingLabel, SettingRow, SettingSection, SettingSwitch } from '../components/primitives'

export function ChannelsPane(): React.ReactNode {
  const [config, setConfig] = useState<ChannelsConfig>({})
  const [loadingConfig, setLoadingConfig] = useState(true)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef(false)
  const [showToken, setShowToken] = useState(false)
  const configRef = useRef(config)

  const [users, setUsers] = useState<ChannelUserRecord[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [updatingUser, setUpdatingUser] = useState<string | null>(null)
  const [settingsConfig, setSettingsConfig] = useState<SettingsConfig | null>(null)

  useEffect(() => {
    let cancelled = false

    void Promise.all([
      window.api.yachiyo.getChannelsConfig(),
      window.api.yachiyo.listChannelUsers(),
      window.api.yachiyo.getConfig()
    ])
      .then(([cfg, usrs, settings]) => {
        if (cancelled) return
        setConfig(cfg)
        configRef.current = cfg
        initializedRef.current = true
        setUsers(usrs)
        setSettingsConfig(settings)
        setLoadingConfig(false)
        setLoadingUsers(false)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadingConfig(false)
          setLoadingUsers(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const telegram = config.telegram
  const enabled = telegram?.enabled ?? false
  const botToken = telegram?.botToken ?? ''

  function patchTelegram(patch: Partial<typeof telegram>): void {
    setConfig((c) => {
      const next = { ...c, telegram: { enabled, botToken, ...c.telegram, ...patch } }
      configRef.current = next
      scheduleSave(next)
      return next
    })
  }

  function scheduleSave(next: ChannelsConfig): void {
    if (!initializedRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void window.api.yachiyo.saveChannelsConfig(next)
    }, 600)
  }

  async function handleStatusChange(userId: string, status: ChannelUserStatus): Promise<void> {
    setUpdatingUser(userId)
    try {
      const updated = await window.api.yachiyo.updateChannelUser({ id: userId, status })
      setUsers((us) => us.map((u) => (u.id === updated.id ? updated : u)))
    } finally {
      setUpdatingUser(null)
    }
  }

  async function handleLimitChange(userId: string, value: string): Promise<void> {
    const parsed = value.trim() === '' ? null : parseInt(value, 10)
    if (parsed !== null && (isNaN(parsed) || parsed < 0)) return
    setUpdatingUser(userId)
    try {
      const updated = await window.api.yachiyo.updateChannelUser({
        id: userId,
        usageLimitKTokens: parsed
      })
      setUsers((us) => us.map((u) => (u.id === updated.id ? updated : u)))
    } finally {
      setUpdatingUser(null)
    }
  }

  if (loadingConfig) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin" style={{ color: theme.text.muted }} />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      {/* ── Telegram ── */}
      <SettingSection>
        <SettingLabel>Telegram</SettingLabel>

        <SettingRow>
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Enable bot
            </div>
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              Let external users chat with your AI over Telegram
            </div>
          </div>
          <SettingSwitch
            ariaLabel="Enable Telegram bot"
            checked={enabled}
            onChange={() => patchTelegram({ enabled: !enabled })}
          />
        </SettingRow>

        <SettingRow>
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
              Bot token
            </span>
            <input
              type={showToken ? 'text' : 'password'}
              value={botToken}
              onChange={(e) => patchTelegram({ botToken: e.target.value })}
              placeholder="123456:ABC-DEF..."
              spellCheck={false}
              className="flex-1 text-sm min-w-0"
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: 'none',
                background: alpha('ink', 0.04),
                color: theme.text.primary,
                outline: 'none',
                fontFamily: botToken ? 'monospace' : 'inherit'
              }}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="text-xs shrink-0 transition-opacity opacity-50 hover:opacity-100"
              style={{
                color: theme.text.secondary,
                background: 'none',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
        </SettingRow>

        {settingsConfig && settingsConfig.providers.length > 0 && (
          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                Model
              </span>
              <select
                value={
                  telegram?.model ? `${telegram.model.providerName}::${telegram.model.model}` : ''
                }
                onChange={(e) => {
                  const val = e.target.value
                  if (!val) {
                    patchTelegram({ model: undefined })
                  } else {
                    const [providerName, model] = val.split('::')
                    patchTelegram({ model: { providerName, model } })
                  }
                }}
                className="flex-1 text-sm min-w-0"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: alpha('ink', 0.04),
                  color: theme.text.primary,
                  outline: 'none'
                }}
              >
                <option value="">Default (same as chat)</option>
                {settingsConfig.providers.flatMap((p) =>
                  p.modelList.enabled.map((m) => (
                    <option key={`${p.name}::${m}`} value={`${p.name}::${m}`}>
                      {p.name}: {m}
                    </option>
                  ))
                )}
              </select>
            </div>
          </SettingRow>
        )}
      </SettingSection>

      {/* ── Users ── */}
      <SettingSection>
        <SettingLabel>Users</SettingLabel>

        {loadingUsers ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin" style={{ color: theme.text.muted }} />
          </div>
        ) : users.length === 0 ? (
          <div
            className="px-7 py-5 text-sm"
            style={{ color: theme.text.muted, borderTop: `1px solid ${theme.border.subtle}` }}
          >
            No users yet — they appear here when they first message your bot.
          </div>
        ) : (
          users.map((user) => (
            <ChannelUserRow
              key={user.id}
              user={user}
              busy={updatingUser === user.id}
              onStatusChange={(s) => void handleStatusChange(user.id, s)}
              onLimitChange={(v) => void handleLimitChange(user.id, v)}
            />
          ))
        )}
      </SettingSection>
    </div>
  )
}

// ─── status colors ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<ChannelUserStatus, string> = {
  allowed: '#34c759',
  pending: '#ff9500',
  blocked: '#ff3b30'
}

// ─── user row ─────────────────────────────────────────────────────────────────

function ChannelUserRow({
  user,
  busy,
  onStatusChange,
  onLimitChange
}: {
  user: ChannelUserRecord
  busy: boolean
  onStatusChange: (status: ChannelUserStatus) => void
  onLimitChange: (value: string) => void
}): React.ReactNode {
  const [limitDraft, setLimitDraft] = useState(
    user.usageLimitKTokens !== null ? String(user.usageLimitKTokens) : ''
  )

  return (
    <div
      className="flex items-center gap-4 px-7 py-3 transition-opacity"
      style={{ borderTop: `1px solid ${theme.border.subtle}`, opacity: busy ? 0.5 : 1 }}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_COLORS[user.status],
            flexShrink: 0
          }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: theme.text.primary }}>
            @{user.username}
          </div>
          <div className="text-xs" style={{ color: theme.text.tertiary }}>
            {user.usedKTokens}k used
            {user.usageLimitKTokens !== null ? ` / ${user.usageLimitKTokens}k limit` : ''}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <input
          type="text"
          inputMode="numeric"
          placeholder="∞"
          value={limitDraft}
          onChange={(e) => setLimitDraft(e.target.value)}
          onBlur={() => onLimitChange(limitDraft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onLimitChange(limitDraft)
          }}
          className="text-sm text-right"
          style={{
            width: 52,
            padding: '4px 6px',
            borderRadius: 6,
            border: 'none',
            background: alpha('ink', 0.04),
            color: theme.text.primary,
            outline: 'none'
          }}
        />
        <span className="text-xs" style={{ color: theme.text.tertiary }}>
          kT
        </span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {user.status !== 'allowed' && (
          <ActionButton label="Approve" color="#34c759" onClick={() => onStatusChange('allowed')} />
        )}
        {user.status === 'allowed' && (
          <ActionButton label="Block" color="#ff3b30" onClick={() => onStatusChange('blocked')} />
        )}
        {user.status === 'blocked' && (
          <ActionButton label="Unblock" color="#ff9500" onClick={() => onStatusChange('pending')} />
        )}
      </div>
    </div>
  )
}

function ActionButton({
  label,
  color,
  onClick
}: {
  label: string
  color: string
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium px-2.5 py-1 rounded-md transition-opacity opacity-75 hover:opacity-100"
      style={{ color, background: `${color}14`, border: 'none', cursor: 'pointer' }}
    >
      {label}
    </button>
  )
}
