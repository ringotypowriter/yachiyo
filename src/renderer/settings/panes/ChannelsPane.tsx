import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { inputStyle } from '../components/styles'

import type {
  ChannelGroupRecord,
  ChannelGroupStatus,
  ChannelsConfig,
  ChannelUserRecord,
  ChannelUserRole,
  ChannelUserStatus,
  SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'
import {
  SettingLabel,
  SettingRow,
  SettingSection,
  SettingSwitch,
  SimpleSelect
} from '../components/primitives'
import { imeSafeEnter } from '../components/imeUtils'

export function ChannelsPane({ activeSubTab }: { activeSubTab: string }): React.ReactNode {
  const [config, setConfig] = useState<ChannelsConfig>({})
  const [loadingConfig, setLoadingConfig] = useState(true)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedRef = useRef(false)
  const [showTelegramToken, setShowTelegramToken] = useState(false)
  const [showQQToken, setShowQQToken] = useState(false)
  const [showDiscordToken, setShowDiscordToken] = useState(false)
  const configRef = useRef(config)

  const [users, setUsers] = useState<ChannelUserRecord[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [updatingUser, setUpdatingUser] = useState<string | null>(null)
  const [groups, setGroups] = useState<ChannelGroupRecord[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [updatingGroup, setUpdatingGroup] = useState<string | null>(null)
  const [settingsConfig, setSettingsConfig] = useState<SettingsConfig | null>(null)

  useEffect(() => {
    let cancelled = false

    void Promise.all([
      window.api.yachiyo.getChannelsConfig(),
      window.api.yachiyo.listChannelUsers(),
      window.api.yachiyo.listChannelGroups(),
      window.api.yachiyo.getConfig()
    ])
      .then(([cfg, usrs, grps, settings]) => {
        if (cancelled) return
        setConfig(cfg)
        configRef.current = cfg
        initializedRef.current = true
        setUsers(usrs)
        setGroups(grps)
        setSettingsConfig(settings)
        setLoadingConfig(false)
        setLoadingUsers(false)
        setLoadingGroups(false)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadingConfig(false)
          setLoadingUsers(false)
          setLoadingGroups(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const telegram = config.telegram
  const telegramEnabled = telegram?.enabled ?? false
  const botToken = telegram?.botToken ?? ''

  const qq = config.qq
  const qqEnabled = qq?.enabled ?? false
  const qqWsUrl = qq?.wsUrl ?? ''
  const qqToken = qq?.token ?? ''

  const discord = config.discord
  const discordEnabled = discord?.enabled ?? false
  const discordBotToken = discord?.botToken ?? ''

  function patchTelegram(patch: Partial<NonNullable<ChannelsConfig['telegram']>>): void {
    setConfig((c) => {
      const next = {
        ...c,
        telegram: { enabled: telegramEnabled, botToken, ...c.telegram, ...patch }
      }
      configRef.current = next
      scheduleSave(next)
      return next
    })
  }

  function patchQQ(patch: Partial<NonNullable<ChannelsConfig['qq']>>): void {
    setConfig((c) => {
      const next = {
        ...c,
        qq: { enabled: qqEnabled, wsUrl: qqWsUrl, ...c.qq, ...patch }
      }
      configRef.current = next
      scheduleSave(next)
      return next
    })
  }

  function patchDiscord(patch: Partial<NonNullable<ChannelsConfig['discord']>>): void {
    setConfig((c) => {
      const next = {
        ...c,
        discord: { enabled: discordEnabled, botToken: discordBotToken, ...c.discord, ...patch }
      }
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

  async function handleRoleChange(userId: string, role: ChannelUserRole): Promise<void> {
    setUpdatingUser(userId)
    try {
      const updated = await window.api.yachiyo.updateChannelUser({ id: userId, role })
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

  async function handleGroupStatusChange(
    groupId: string,
    status: ChannelGroupStatus
  ): Promise<void> {
    setUpdatingGroup(groupId)
    try {
      const updated = await window.api.yachiyo.updateChannelGroup({ id: groupId, status })
      setGroups((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
    } finally {
      setUpdatingGroup(null)
    }
  }

  async function handleClearGroupMessages(groupId: string): Promise<void> {
    await window.api.yachiyo.clearGroupMonitorBuffer(groupId)
  }

  if (loadingConfig) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin" style={{ color: theme.text.muted }} />
      </div>
    )
  }

  const modelSelector = settingsConfig && settingsConfig.providers.length > 0

  if (activeSubTab === 'telegram') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
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
              checked={telegramEnabled}
              onChange={() => patchTelegram({ enabled: !telegramEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                Bot token
              </span>
              <input
                type={showTelegramToken ? 'text' : 'password'}
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
                onClick={() => setShowTelegramToken((v) => !v)}
                className="text-xs shrink-0 transition-opacity opacity-50 hover:opacity-100"
                style={{
                  color: theme.text.secondary,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                {showTelegramToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </SettingRow>

          {modelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  Model
                </span>
                <ModelSelect
                  value={
                    telegram?.model ? `${telegram.model.providerName}::${telegram.model.model}` : ''
                  }
                  providers={settingsConfig!.providers}
                  onChange={(val) => {
                    if (!val) {
                      patchTelegram({ model: undefined })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchTelegram({ model: { providerName, model } })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}

          {modelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  Group Model
                </span>
                <ModelSelect
                  value={
                    telegram?.group?.model
                      ? `${telegram.group.model.providerName}::${telegram.group.model.model}`
                      : ''
                  }
                  providers={settingsConfig!.providers}
                  onChange={(val) => {
                    if (!val) {
                      patchTelegram({
                        group: {
                          ...telegram?.group,
                          enabled: telegram?.group?.enabled ?? false,
                          model: undefined
                        }
                      })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchTelegram({
                        group: {
                          ...telegram?.group,
                          enabled: telegram?.group?.enabled ?? false,
                          model: { providerName, model }
                        }
                      })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}
        </SettingSection>
      </div>
    )
  }

  if (activeSubTab === 'qq') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Enable bot
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                Connect to a NapCatQQ instance via OneBot v11
              </div>
            </div>
            <SettingSwitch
              ariaLabel="Enable QQ bot"
              checked={qqEnabled}
              onChange={() => patchQQ({ enabled: !qqEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                WebSocket URL
              </span>
              <input
                type="text"
                value={qqWsUrl}
                onChange={(e) => patchQQ({ wsUrl: e.target.value })}
                placeholder="ws://localhost:3001"
                spellCheck={false}
                className="flex-1 text-sm min-w-0"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: alpha('ink', 0.04),
                  color: theme.text.primary,
                  outline: 'none',
                  fontFamily: qqWsUrl ? 'monospace' : 'inherit'
                }}
              />
            </div>
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                Token
              </span>
              <input
                type={showQQToken ? 'text' : 'password'}
                value={qqToken}
                onChange={(e) => patchQQ({ token: e.target.value })}
                placeholder="Optional"
                spellCheck={false}
                className="flex-1 text-sm min-w-0"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: alpha('ink', 0.04),
                  color: theme.text.primary,
                  outline: 'none',
                  fontFamily: qqToken ? 'monospace' : 'inherit'
                }}
              />
              <button
                type="button"
                onClick={() => setShowQQToken((v) => !v)}
                className="text-xs shrink-0 transition-opacity opacity-50 hover:opacity-100"
                style={{
                  color: theme.text.secondary,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                {showQQToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </SettingRow>

          {modelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  Model
                </span>
                <ModelSelect
                  value={qq?.model ? `${qq.model.providerName}::${qq.model.model}` : ''}
                  providers={settingsConfig!.providers}
                  onChange={(val) => {
                    if (!val) {
                      patchQQ({ model: undefined })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchQQ({ model: { providerName, model } })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}

          {modelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  Group Model
                </span>
                <ModelSelect
                  value={
                    qq?.group?.model
                      ? `${qq.group.model.providerName}::${qq.group.model.model}`
                      : ''
                  }
                  providers={settingsConfig!.providers}
                  onChange={(val) => {
                    if (!val) {
                      patchQQ({
                        group: {
                          ...qq?.group,
                          enabled: qq?.group?.enabled ?? true,
                          model: undefined
                        }
                      })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchQQ({
                        group: {
                          ...qq?.group,
                          enabled: qq?.group?.enabled ?? true,
                          model: { providerName, model }
                        }
                      })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}
        </SettingSection>
      </div>
    )
  }

  if (activeSubTab === 'discord') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Enable bot
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                Connect a Discord bot to your server channels and DMs
              </div>
            </div>
            <SettingSwitch
              ariaLabel="Enable Discord bot"
              checked={discordEnabled}
              onChange={() => patchDiscord({ enabled: !discordEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                Bot token
              </span>
              <input
                type={showDiscordToken ? 'text' : 'password'}
                value={discordBotToken}
                onChange={(e) => patchDiscord({ botToken: e.target.value })}
                placeholder="MTIzNDU2Nzg5..."
                spellCheck={false}
                className="flex-1 text-sm min-w-0"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: alpha('ink', 0.04),
                  color: theme.text.primary,
                  outline: 'none',
                  fontFamily: discordBotToken ? 'monospace' : 'inherit'
                }}
              />
              <button
                type="button"
                onClick={() => setShowDiscordToken((v) => !v)}
                className="text-xs shrink-0 transition-opacity opacity-50 hover:opacity-100"
                style={{
                  color: theme.text.secondary,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                {showDiscordToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </SettingRow>

          {modelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  Model
                </span>
                <ModelSelect
                  value={
                    discord?.model ? `${discord.model.providerName}::${discord.model.model}` : ''
                  }
                  providers={settingsConfig!.providers}
                  onChange={(val) => {
                    if (!val) {
                      patchDiscord({ model: undefined })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchDiscord({ model: { providerName, model } })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}

          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                Group Discussion
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                Monitor approved server channels and participate in conversations
              </div>
            </div>
            <SettingSwitch
              ariaLabel="Enable Discord group discussion"
              checked={discord?.group?.enabled ?? false}
              onChange={() =>
                patchDiscord({
                  group: {
                    ...discord?.group,
                    enabled: !(discord?.group?.enabled ?? false)
                  }
                })
              }
            />
          </SettingRow>

          {modelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  Group Model
                </span>
                <ModelSelect
                  value={
                    discord?.group?.model
                      ? `${discord.group.model.providerName}::${discord.group.model.model}`
                      : ''
                  }
                  providers={settingsConfig!.providers}
                  onChange={(val) => {
                    if (!val) {
                      patchDiscord({
                        group: {
                          ...discord?.group,
                          enabled: discord?.group?.enabled ?? false,
                          model: undefined
                        }
                      })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchDiscord({
                        group: {
                          ...discord?.group,
                          enabled: discord?.group?.enabled ?? false,
                          model: { providerName, model }
                        }
                      })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}
        </SettingSection>
      </div>
    )
  }

  // General tab (default)
  const verbosity = config.groupVerbosity ?? 0
  const checkIntervalSec = Math.round((config.groupCheckIntervalMs ?? 30_000) / 1_000)
  const dmCompactTokenThresholdK = config.dmCompactTokenThresholdK ?? 64
  const groupContextWindowK = config.groupContextWindowK ?? 64

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>Token Limits</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              DM compact threshold
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Compact DM thread history above this token count.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              min={1}
              step={1}
              value={dmCompactTokenThresholdK}
              onChange={(e) => {
                const raw = parseInt(e.target.value, 10)
                if (!isNaN(raw) && raw > 0) {
                  setConfig((c) => {
                    const next = { ...c, dmCompactTokenThresholdK: raw }
                    configRef.current = next
                    scheduleSave(next)
                    return next
                  })
                }
              }}
              className="w-16 rounded-lg px-2 py-1 text-sm text-right outline-none"
              style={inputStyle()}
            />
            <span className="text-sm" style={{ color: theme.text.secondary }}>
              K
            </span>
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Group context window
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              Sliding window budget for group probe messages.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              min={1}
              step={1}
              value={groupContextWindowK}
              onChange={(e) => {
                const raw = parseInt(e.target.value, 10)
                if (!isNaN(raw) && raw > 0) {
                  setConfig((c) => {
                    const next = { ...c, groupContextWindowK: raw }
                    configRef.current = next
                    scheduleSave(next)
                    return next
                  })
                }
              }}
              className="w-16 rounded-lg px-2 py-1 text-sm text-right outline-none"
              style={inputStyle()}
            />
            <span className="text-sm" style={{ color: theme.text.secondary }}>
              K
            </span>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Group Discussion</SettingLabel>

        <SettingRow>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Verbosity
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <SettingSlider
              min={0}
              max={1}
              step={0.05}
              value={verbosity}
              onChange={(v) => {
                setConfig((c) => {
                  const next = { ...c, groupVerbosity: v }
                  configRef.current = next
                  scheduleSave(next)
                  return next
                })
              }}
              aria-label="Verbosity"
            />
            <span
              className="text-sm font-medium tabular-nums"
              style={{ minWidth: 36, textAlign: 'right', color: theme.text.primary }}
            >
              {Math.round(verbosity * 100)}%
            </span>
          </div>
        </SettingRow>

        <SettingRow>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Check interval
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <SettingSlider
              min={5}
              max={120}
              step={5}
              value={checkIntervalSec}
              onChange={(v) => {
                setConfig((c) => {
                  const next = { ...c, groupCheckIntervalMs: v * 1_000 }
                  configRef.current = next
                  scheduleSave(next)
                  return next
                })
              }}
              aria-label="Check interval"
            />
            <span
              className="text-sm font-medium tabular-nums"
              style={{ minWidth: 36, textAlign: 'right', color: theme.text.primary }}
            >
              {checkIntervalSec}s
            </span>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>Image to Text</SettingLabel>

        <SettingRow>
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Enable
            </div>
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              Pre-describe images in group messages as alt text
            </div>
          </div>
          <SettingSwitch
            ariaLabel="Enable image to text"
            checked={config.imageToText?.enabled ?? false}
            onChange={() => {
              setConfig((c) => {
                const next = {
                  ...c,
                  imageToText: {
                    ...c.imageToText,
                    enabled: !(c.imageToText?.enabled ?? false)
                  }
                }
                configRef.current = next
                scheduleSave(next)
                return next
              })
            }}
          />
        </SettingRow>

        {modelSelector && (
          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                Model
              </span>
              <ModelSelect
                value={
                  config.imageToText?.model
                    ? `${config.imageToText.model.providerName}::${config.imageToText.model.model}`
                    : ''
                }
                providers={settingsConfig!.providers}
                onChange={(val) => {
                  setConfig((c) => {
                    const next = {
                      ...c,
                      imageToText: {
                        ...c.imageToText,
                        enabled: c.imageToText?.enabled ?? false,
                        model: val
                          ? {
                              providerName: val.split('::')[0],
                              model: val.split('::')[1]
                            }
                          : undefined
                      }
                    }
                    configRef.current = next
                    scheduleSave(next)
                    return next
                  })
                }}
              />
            </div>
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection>
        <SettingLabel>Guest Instruction</SettingLabel>

        <SettingRow>
          <div className="flex-1 min-w-0">
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              Custom context injected into the system prompt for guest conversations
            </div>
          </div>
        </SettingRow>

        <div className="px-7 pb-3">
          <textarea
            value={config.guestInstruction ?? ''}
            onChange={(e) => {
              setConfig((c) => {
                const next = { ...c, guestInstruction: e.target.value }
                configRef.current = next
                scheduleSave(next)
                return next
              })
            }}
            placeholder="Tell the model what guests should know about you, and any rules for guest conversations..."
            spellCheck={false}
            rows={4}
            className="w-full text-sm resize-y"
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              border: 'none',
              background: alpha('ink', 0.04),
              color: theme.text.primary,
              outline: 'none',
              lineHeight: 1.5
            }}
          />
        </div>
      </SettingSection>

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
              onRoleChange={(r) => void handleRoleChange(user.id, r)}
              onLimitChange={(v) => void handleLimitChange(user.id, v)}
            />
          ))
        )}
      </SettingSection>

      <SettingSection>
        <SettingLabel>Groups</SettingLabel>

        {loadingGroups ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin" style={{ color: theme.text.muted }} />
          </div>
        ) : groups.length === 0 ? (
          <div
            className="px-7 py-5 text-sm"
            style={{ color: theme.text.muted, borderTop: `1px solid ${theme.border.subtle}` }}
          >
            No groups yet — they appear here when the bot is added to a group.
          </div>
        ) : (
          groups.map((group) => (
            <ChannelGroupRow
              key={group.id}
              group={group}
              busy={updatingGroup === group.id}
              onStatusChange={(s) => void handleGroupStatusChange(group.id, s)}
              onClearMessages={() => void handleClearGroupMessages(group.id)}
            />
          ))
        )}
      </SettingSection>

      <SettingSection>
        <SettingLabel>Memory Privacy</SettingLabel>

        <SettingRow>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Filter keywords
            </div>
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              Memory search results containing these keywords are hidden from guests
            </div>
          </div>
        </SettingRow>

        <MemoryFilterKeywords
          keywords={config.memoryFilterKeywords ?? []}
          onChange={(keywords) => {
            setConfig((c) => {
              const next = { ...c, memoryFilterKeywords: keywords }
              configRef.current = next
              scheduleSave(next)
              return next
            })
          }}
        />
      </SettingSection>
    </div>
  )
}

// ─── memory filter keywords ──────────────────────────────────────────────────

function MemoryFilterKeywords({
  keywords,
  onChange
}: {
  keywords: string[]
  onChange: (keywords: string[]) => void
}): React.ReactNode {
  const [draft, setDraft] = useState('')

  function addKeyword(): void {
    const trimmed = draft.trim()
    if (!trimmed || keywords.includes(trimmed)) return
    onChange([...keywords, trimmed])
    setDraft('')
  }

  return (
    <div className="px-7 pb-2" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
      <div className="flex items-center gap-2 py-2.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={imeSafeEnter(() => addKeyword())}
          placeholder="Add keyword..."
          className="flex-1 text-sm min-w-0"
          style={{
            padding: '5px 10px',
            borderRadius: 8,
            border: 'none',
            background: alpha('ink', 0.04),
            color: theme.text.primary,
            outline: 'none'
          }}
        />
        <button
          type="button"
          onClick={addKeyword}
          className="text-xs font-medium px-2.5 py-1 rounded-md transition-opacity opacity-60 hover:opacity-100"
          style={{
            color: theme.text.accent,
            background: `${theme.text.accent}14`,
            border: 'none',
            cursor: 'pointer'
          }}
        >
          Add
        </button>
      </div>

      {keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {keywords.map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md"
              style={{ background: alpha('ink', 0.06), color: theme.text.secondary }}
            >
              {kw}
              <button
                type="button"
                onClick={() => onChange(keywords.filter((k) => k !== kw))}
                className="opacity-50 hover:opacity-100 transition-opacity"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: 0,
                  lineHeight: 1
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── shared model selector ───────────────────────────────────────────────────

function ModelSelect({
  value,
  providers,
  onChange
}: {
  value: string
  providers: SettingsConfig['providers']
  onChange: (value: string) => void
}): React.ReactNode {
  const options: { value: string; label: string }[] = [
    { value: '', label: 'Default (same as chat)' },
    ...providers.flatMap((p) =>
      p.modelList.enabled.map((m) => ({
        value: `${p.name}::${m}`,
        label: `${p.name}: ${m}`
      }))
    )
  ]

  return <SimpleSelect value={value} options={options} onChange={onChange} width="100%" />
}

// ─── status colors ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<ChannelUserStatus, string> = {
  allowed: '#34c759',
  pending: '#ff9500',
  blocked: '#ff3b30'
}

const GROUP_STATUS_COLORS: Record<ChannelGroupStatus, string> = {
  approved: '#34c759',
  pending: '#ff9500',
  blocked: '#ff3b30'
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  qq: 'QQ',
  discord: 'Discord'
}

// ─── user row ────────────────────────────────────────────────────────────────

function ChannelUserRow({
  user,
  busy,
  onStatusChange,
  onRoleChange,
  onLimitChange
}: {
  user: ChannelUserRecord
  busy: boolean
  onStatusChange: (status: ChannelUserStatus) => void
  onRoleChange: (role: ChannelUserRole) => void
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

      <SimpleSelect
        value={user.role}
        options={[
          { value: 'guest', label: 'Guest' },
          { value: 'owner', label: 'Owner' }
        ]}
        onChange={(v) => onRoleChange(v as ChannelUserRole)}
        width={80}
      />

      <div className="flex items-center gap-1 shrink-0">
        <input
          type="text"
          inputMode="numeric"
          placeholder="∞"
          value={limitDraft}
          onChange={(e) => setLimitDraft(e.target.value)}
          onBlur={() => onLimitChange(limitDraft)}
          onKeyDown={imeSafeEnter(() => onLimitChange(limitDraft))}
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

function ChannelGroupRow({
  group,
  busy,
  onStatusChange,
  onClearMessages
}: {
  group: ChannelGroupRecord
  busy: boolean
  onStatusChange: (status: ChannelGroupStatus) => void
  onClearMessages: () => void
}): React.ReactNode {
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
            background: GROUP_STATUS_COLORS[group.status],
            flexShrink: 0
          }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: theme.text.primary }}>
            {group.name}
          </div>
        </div>
      </div>

      <span
        className="text-xs px-2 py-0.5 rounded shrink-0"
        style={{ background: alpha('ink', 0.06), color: theme.text.tertiary }}
      >
        {PLATFORM_LABELS[group.platform] ?? group.platform}
      </span>

      <div className="flex items-center gap-1 shrink-0">
        <ActionButton
          label="Clear Messages"
          color={theme.text.tertiary}
          onClick={onClearMessages}
        />
        {group.status === 'pending' && (
          <>
            <ActionButton
              label="Approve"
              color="#34c759"
              onClick={() => onStatusChange('approved')}
            />
            <ActionButton label="Block" color="#ff3b30" onClick={() => onStatusChange('blocked')} />
          </>
        )}
        {group.status === 'approved' && (
          <>
            <ActionButton
              label="Disable"
              color="#ff9500"
              onClick={() => onStatusChange('pending')}
            />
            <ActionButton label="Block" color="#ff3b30" onClick={() => onStatusChange('blocked')} />
          </>
        )}
        {group.status === 'blocked' && (
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

// ─── styled slider ────────────────────────────────────────────────────────────

function SettingSlider({
  min,
  max,
  step,
  value,
  onChange,
  'aria-label': ariaLabel
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  'aria-label': string
}): React.ReactNode {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ position: 'relative', width: 112, height: 20 }}>
      {/* track */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: 3,
          transform: 'translateY(-50%)',
          borderRadius: 99,
          background: alpha('ink', 0.08),
          pointerEvents: 'none'
        }}
      />
      {/* fill */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          width: `${pct}%`,
          height: 3,
          transform: 'translateY(-50%)',
          borderRadius: 99,
          background: theme.text.accent,
          pointerEvents: 'none'
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={ariaLabel}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: 'pointer',
          margin: 0
        }}
      />
    </div>
  )
}
