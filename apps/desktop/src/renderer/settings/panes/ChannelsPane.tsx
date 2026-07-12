import { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { theme, alpha } from '@renderer/theme/theme'
import { inputStyle } from '../components/styles'

import type {
  ChannelGroupRecord,
  ChannelGroupStatus,
  ChannelsConfig,
  ChannelUserRecord,
  ChannelUserRole,
  ChannelUserStatus,
  ProviderConfig
} from '@yachiyo/shared/protocol'
import { SettingLabel, SettingRow, SettingSection, SettingSwitch } from '../components/primitives'
import {
  ChannelGroupRow,
  ChannelUserRow,
  MemoryFilterKeywords,
  ModelSelect,
  SettingSlider
} from './ChannelsPaneRows'
import { buildGroupProbeModelProviders } from './channelsPaneModel'

function RestartServiceButton({
  platform,
  enabled,
  label
}: {
  platform: 'telegram' | 'qq' | 'discord' | 'qqbot' | 'all'
  enabled: boolean
  label?: string
}): React.ReactNode {
  const t = useT()
  const [restarting, setRestarting] = useState(false)

  async function handleRestart(): Promise<void> {
    setRestarting(true)
    try {
      await window.api.yachiyo.restartChannelService(platform)
    } finally {
      setRestarting(false)
    }
  }

  const text = label ?? t('settings.channels.restartService')

  return (
    <SettingRow>
      <button
        type="button"
        disabled={!enabled || restarting}
        onClick={handleRestart}
        className="flex items-center gap-1.5 text-sm transition-opacity"
        style={{
          color: enabled ? theme.text.accent : theme.text.tertiary,
          background: 'none',
          border: 'none',
          opacity: enabled ? 1 : 0.5,
          padding: 0
        }}
      >
        <RefreshCw size={14} className={restarting ? 'animate-spin' : ''} />
        {restarting ? t('settings.channels.restarting') : text}
      </button>
    </SettingRow>
  )
}

export function ChannelsPane({
  activeTab,
  config,
  onConfigChange,
  users,
  groups,
  isLoadingRecords,
  channelRecordsError,
  onUsersChange,
  onGroupsChange,
  providers
}: {
  activeTab: string
  config: ChannelsConfig
  onConfigChange: (next: ChannelsConfig) => void
  users: ChannelUserRecord[] | null
  groups: ChannelGroupRecord[] | null
  isLoadingRecords: boolean
  channelRecordsError: string | null
  onUsersChange: (next: ChannelUserRecord[] | null) => void
  onGroupsChange: (next: ChannelGroupRecord[] | null) => void
  providers: ProviderConfig[]
}): React.ReactNode {
  const t = useT()
  const [showTelegramToken, setShowTelegramToken] = useState(false)
  const [showQQToken, setShowQQToken] = useState(false)
  const [showDiscordToken, setShowDiscordToken] = useState(false)
  const [showQQBotSecret, setShowQQBotSecret] = useState(false)
  const [clearingGroupIds, setClearingGroupIds] = useState<string[]>([])
  const [clearErrorsByGroupId, setClearErrorsByGroupId] = useState<Record<string, string>>({})

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

  const qqbot = config.qqbot
  const qqbotEnabled = qqbot?.enabled ?? false
  const qqbotAppId = qqbot?.appId ?? ''
  const qqbotClientSecret = qqbot?.clientSecret ?? ''

  function patchTelegram(patch: Partial<NonNullable<ChannelsConfig['telegram']>>): void {
    onConfigChange({
      ...config,
      telegram: { enabled: telegramEnabled, botToken, ...config.telegram, ...patch }
    })
  }

  function patchQQ(patch: Partial<NonNullable<ChannelsConfig['qq']>>): void {
    onConfigChange({
      ...config,
      qq: { enabled: qqEnabled, wsUrl: qqWsUrl, ...config.qq, ...patch }
    })
  }

  function patchQQBot(patch: Partial<NonNullable<ChannelsConfig['qqbot']>>): void {
    onConfigChange({
      ...config,
      qqbot: {
        enabled: qqbotEnabled,
        appId: qqbotAppId,
        clientSecret: qqbotClientSecret,
        ...config.qqbot,
        ...patch
      }
    })
  }

  function patchDiscord(patch: Partial<NonNullable<ChannelsConfig['discord']>>): void {
    onConfigChange({
      ...config,
      discord: { enabled: discordEnabled, botToken: discordBotToken, ...config.discord, ...patch }
    })
  }

  function patchUser(userId: string, patch: Partial<ChannelUserRecord>): void {
    if (!users) {
      return
    }

    onUsersChange(users.map((user) => (user.id === userId ? { ...user, ...patch } : user)))
  }

  function patchGroup(groupId: string, patch: Partial<ChannelGroupRecord>): void {
    if (!groups) {
      return
    }

    onGroupsChange(groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group)))
  }

  function handleStatusChange(userId: string, status: ChannelUserStatus): void {
    patchUser(userId, { status })
  }

  function handleRoleChange(userId: string, role: ChannelUserRole): void {
    patchUser(userId, { role })
  }

  function handleLimitChange(userId: string, value: string): void {
    const parsed = value.trim() === '' ? null : parseInt(value, 10)
    if (parsed !== null && (isNaN(parsed) || parsed < 0)) {
      return
    }

    patchUser(userId, { usageLimitKTokens: parsed })
  }

  function handleUserLabelChange(userId: string, label: string): void {
    patchUser(userId, { label })
  }

  function handleGroupStatusChange(groupId: string, status: ChannelGroupStatus): void {
    patchGroup(groupId, { status })
  }

  function handleGroupLabelChange(groupId: string, label: string): void {
    patchGroup(groupId, { label })
  }

  async function handleClearGroupMessages(groupId: string): Promise<void> {
    if (clearingGroupIds.includes(groupId)) {
      return
    }

    setClearingGroupIds((current) => (current.includes(groupId) ? current : [...current, groupId]))
    setClearErrorsByGroupId((current) => {
      const next = { ...current }
      delete next[groupId]
      return next
    })

    try {
      await window.api.yachiyo.clearGroupMonitorBuffer(groupId)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('settings.channels.clearStartFailed')
      setClearingGroupIds((current) => current.filter((id) => id !== groupId))
      setClearErrorsByGroupId((current) => ({ ...current, [groupId]: message }))
      throw error
    }
  }

  useEffect(() => {
    return window.api.yachiyo.subscribe((event) => {
      if (event.type === 'channel-group-history-clear.started') {
        setClearingGroupIds((current) =>
          current.includes(event.groupId) ? current : [...current, event.groupId]
        )
        setClearErrorsByGroupId((current) => {
          const next = { ...current }
          delete next[event.groupId]
          return next
        })
        return
      }

      if (event.type === 'channel-group-history-clear.completed') {
        setClearingGroupIds((current) => current.filter((id) => id !== event.groupId))
        setClearErrorsByGroupId((current) => {
          const next = { ...current }
          delete next[event.groupId]
          return next
        })
        return
      }

      if (event.type === 'channel-group-history-clear.failed') {
        setClearingGroupIds((current) => current.filter((id) => id !== event.groupId))
        setClearErrorsByGroupId((current) => ({ ...current, [event.groupId]: event.error }))
      }
    })
  }, [])

  const modelSelector = providers.length > 0
  const groupModelProviders = buildGroupProbeModelProviders(providers, config.groupProbeAdapter)
  const groupModelSelector = groupModelProviders.length > 0

  if (activeTab === 'telegram') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('settings.channels.enableBot')}
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                {t('settings.channels.telegramDescription')}
              </div>
            </div>
            <SettingSwitch
              ariaLabel={t('settings.channels.enableTelegramBot')}
              checked={telegramEnabled}
              onChange={() => patchTelegram({ enabled: !telegramEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                {t('settings.channels.botToken')}
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
                  cursor: 'default'
                }}
              >
                {showTelegramToken ? t('settings.channels.hide') : t('settings.channels.show')}
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
                  {t('settings.channels.model')}
                </span>
                <ModelSelect
                  value={
                    telegram?.model ? `${telegram.model.providerName}::${telegram.model.model}` : ''
                  }
                  providers={providers}
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

          {groupModelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  {t('settings.channels.groupModel')}
                </span>
                <ModelSelect
                  value={
                    telegram?.group?.model
                      ? `${telegram.group.model.providerName}::${telegram.group.model.model}`
                      : ''
                  }
                  providers={groupModelProviders}
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

          <RestartServiceButton platform="telegram" enabled={telegramEnabled} />
        </SettingSection>
      </div>
    )
  }

  if (activeTab === 'qq') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('settings.channels.enableBot')}
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                {t('settings.channels.qqDescription')}
              </div>
            </div>
            <SettingSwitch
              ariaLabel={t('settings.channels.enableQqBot')}
              checked={qqEnabled}
              onChange={() => patchQQ({ enabled: !qqEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                {t('settings.channels.webSocketUrl')}
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
                {t('settings.channels.token')}
              </span>
              <input
                type={showQQToken ? 'text' : 'password'}
                value={qqToken}
                onChange={(e) => patchQQ({ token: e.target.value })}
                placeholder={t('settings.channels.optionalPlaceholder')}
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
                  cursor: 'default'
                }}
              >
                {showQQToken ? t('settings.channels.hide') : t('settings.channels.show')}
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
                  {t('settings.channels.model')}
                </span>
                <ModelSelect
                  value={qq?.model ? `${qq.model.providerName}::${qq.model.model}` : ''}
                  providers={providers}
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

          {groupModelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  {t('settings.channels.groupModel')}
                </span>
                <ModelSelect
                  value={
                    qq?.group?.model
                      ? `${qq.group.model.providerName}::${qq.group.model.model}`
                      : ''
                  }
                  providers={groupModelProviders}
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

          <RestartServiceButton platform="qq" enabled={qqEnabled} />
        </SettingSection>
      </div>
    )
  }

  if (activeTab === 'qqbot') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('settings.channels.enableBot')}
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                {t('settings.channels.qqbotDescription')}
              </div>
            </div>
            <SettingSwitch
              ariaLabel={t('settings.channels.enableQqOfficialBot')}
              checked={qqbotEnabled}
              onChange={() => patchQQBot({ enabled: !qqbotEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                {t('settings.channels.appId')}
              </span>
              <input
                type="text"
                value={qqbotAppId}
                onChange={(e) => patchQQBot({ appId: e.target.value })}
                placeholder="102000000"
                spellCheck={false}
                className="flex-1 text-sm min-w-0"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: alpha('ink', 0.04),
                  color: theme.text.primary,
                  outline: 'none',
                  fontFamily: qqbotAppId ? 'monospace' : 'inherit'
                }}
              />
            </div>
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                {t('settings.channels.secret')}
              </span>
              <input
                type={showQQBotSecret ? 'text' : 'password'}
                value={qqbotClientSecret}
                onChange={(e) => patchQQBot({ clientSecret: e.target.value })}
                placeholder={t('settings.channels.secretPlaceholder')}
                spellCheck={false}
                className="flex-1 text-sm min-w-0"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: alpha('ink', 0.04),
                  color: theme.text.primary,
                  outline: 'none',
                  fontFamily: qqbotClientSecret ? 'monospace' : 'inherit'
                }}
              />
              <button
                type="button"
                onClick={() => setShowQQBotSecret((v) => !v)}
                className="text-xs shrink-0 transition-opacity opacity-50 hover:opacity-100"
                style={{
                  color: theme.text.secondary,
                  background: 'none',
                  border: 'none',
                  cursor: 'default'
                }}
              >
                {showQQBotSecret ? t('settings.channels.hide') : t('settings.channels.show')}
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
                  {t('settings.channels.model')}
                </span>
                <ModelSelect
                  value={qqbot?.model ? `${qqbot.model.providerName}::${qqbot.model.model}` : ''}
                  providers={providers}
                  onChange={(val) => {
                    if (!val) {
                      patchQQBot({ model: undefined })
                    } else {
                      const [providerName, model] = val.split('::')
                      patchQQBot({ model: { providerName, model } })
                    }
                  }}
                />
              </div>
            </SettingRow>
          )}

          <RestartServiceButton platform="qqbot" enabled={qqbotEnabled} />
        </SettingSection>
      </div>
    )
  }

  if (activeTab === 'discord') {
    return (
      <div className="flex-1 overflow-y-auto pb-6">
        <SettingSection>
          <SettingRow>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('settings.channels.enableBot')}
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                {t('settings.channels.discordDescription')}
              </div>
            </div>
            <SettingSwitch
              ariaLabel={t('settings.channels.enableDiscordBot')}
              checked={discordEnabled}
              onChange={() => patchDiscord({ enabled: !discordEnabled })}
            />
          </SettingRow>

          <SettingRow>
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span className="text-sm font-medium shrink-0" style={{ color: theme.text.primary }}>
                {t('settings.channels.botToken')}
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
                  cursor: 'default'
                }}
              >
                {showDiscordToken ? t('settings.channels.hide') : t('settings.channels.show')}
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
                  {t('settings.channels.model')}
                </span>
                <ModelSelect
                  value={
                    discord?.model ? `${discord.model.providerName}::${discord.model.model}` : ''
                  }
                  providers={providers}
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
                {t('settings.channels.groupDiscussion')}
              </div>
              <div className="text-sm" style={{ color: theme.text.tertiary }}>
                {t('settings.channels.discordGroupDescription')}
              </div>
            </div>
            <SettingSwitch
              ariaLabel={t('settings.channels.enableDiscordGroupDiscussion')}
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

          {groupModelSelector && (
            <SettingRow>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <span
                  className="text-sm font-medium shrink-0"
                  style={{ color: theme.text.primary }}
                >
                  {t('settings.channels.groupModel')}
                </span>
                <ModelSelect
                  value={
                    discord?.group?.model
                      ? `${discord.group.model.providerName}::${discord.group.model.model}`
                      : ''
                  }
                  providers={groupModelProviders}
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

          <RestartServiceButton platform="discord" enabled={discordEnabled} />
        </SettingSection>
      </div>
    )
  }

  // General tab (default)
  const verbosity = config.groupVerbosity ?? 0
  const checkIntervalSec = Math.round((config.groupCheckIntervalMs ?? 30_000) / 1_000)
  const dmCompactTokenThresholdK = config.dmCompactTokenThresholdK ?? 64
  const groupContextWindowK = config.groupContextWindowK ?? 64

  const anyChannelEnabled = telegramEnabled || qqEnabled || discordEnabled || qqbotEnabled

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <SettingSection>
        <SettingLabel>{t('settings.channels.tokenLimits')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.channels.dmCompactThreshold')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.channels.dmCompactThresholdDescription')}
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
                  onConfigChange({ ...config, dmCompactTokenThresholdK: raw })
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
              {t('settings.channels.groupContextWindow')}
            </div>
            <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
              {t('settings.channels.groupContextWindowDescription')}
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
                  onConfigChange({ ...config, groupContextWindowK: raw })
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
        <SettingLabel>{t('settings.channels.groupDiscussion')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.channels.verbosity')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <SettingSlider
              min={0}
              max={1}
              step={0.05}
              value={verbosity}
              onChange={(v) => {
                onConfigChange({ ...config, groupVerbosity: v })
              }}
              aria-label={t('settings.channels.verbosity')}
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
              {t('settings.channels.checkInterval')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <SettingSlider
              min={5}
              max={120}
              step={5}
              value={checkIntervalSec}
              onChange={(v) => {
                onConfigChange({ ...config, groupCheckIntervalMs: v * 1_000 })
              }}
              aria-label={t('settings.channels.checkInterval')}
            />
            <span
              className="text-sm font-medium tabular-nums"
              style={{ minWidth: 36, textAlign: 'right', color: theme.text.primary }}
            >
              {t('settings.channels.intervalSeconds', { seconds: checkIntervalSec })}
            </span>
          </div>
        </SettingRow>

        {modelSelector && (
          <SettingRow>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('settings.channels.rewriteModel')}
              </div>
              <div className="text-sm leading-5" style={{ color: theme.text.tertiary }}>
                {t('settings.channels.rewriteModelDescription')}
              </div>
            </div>
            <div className="shrink-0">
              <ModelSelect
                value={
                  config.groupRewriteModel
                    ? `${config.groupRewriteModel.providerName}::${config.groupRewriteModel.model}`
                    : ''
                }
                providers={providers}
                onChange={(val) => {
                  if (!val) {
                    onConfigChange({ ...config, groupRewriteModel: undefined })
                  } else {
                    const [providerName, model] = val.split('::')
                    onConfigChange({ ...config, groupRewriteModel: { providerName, model } })
                  }
                }}
              />
            </div>
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.channels.imageToText')}</SettingLabel>

        <SettingRow>
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.channels.enable')}
            </div>
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              {t('settings.channels.imageToTextDescription')}
            </div>
          </div>
          <SettingSwitch
            ariaLabel={t('settings.channels.enableImageToText')}
            checked={config.imageToText?.enabled ?? false}
            onChange={() => {
              onConfigChange({
                ...config,
                imageToText: {
                  ...config.imageToText,
                  enabled: !(config.imageToText?.enabled ?? false)
                }
              })
            }}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.channels.guestInstruction')}</SettingLabel>

        <SettingRow>
          <div className="flex-1 min-w-0">
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              {t('settings.channels.guestInstructionDescription')}
            </div>
          </div>
        </SettingRow>

        <div className="px-7 pb-3">
          <textarea
            value={config.guestInstruction ?? ''}
            onChange={(e) => {
              onConfigChange({ ...config, guestInstruction: e.target.value })
            }}
            placeholder={t('settings.channels.guestInstructionPlaceholder')}
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
        <SettingLabel>{t('settings.channels.users')}</SettingLabel>

        {isLoadingRecords ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin" style={{ color: theme.text.muted }} />
          </div>
        ) : channelRecordsError ? (
          <div
            className="px-7 py-5 text-sm"
            style={{
              color: theme.text.dangerStrong,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            {channelRecordsError}
          </div>
        ) : !users || users.length === 0 ? (
          <div
            className="px-7 py-5 text-sm"
            style={{ color: theme.text.muted, borderTop: `1px solid ${theme.border.subtle}` }}
          >
            {t('settings.channels.noUsersYet')}
          </div>
        ) : (
          users.map((user) => (
            <ChannelUserRow
              key={`${user.id}:${user.label}:${user.usageLimitKTokens ?? ''}`}
              user={user}
              busy={false}
              onStatusChange={(s) => handleStatusChange(user.id, s)}
              onRoleChange={(r) => handleRoleChange(user.id, r)}
              onLimitChange={(v) => handleLimitChange(user.id, v)}
              onLabelChange={(l) => handleUserLabelChange(user.id, l)}
            />
          ))
        )}
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.channels.groups')}</SettingLabel>

        {isLoadingRecords ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin" style={{ color: theme.text.muted }} />
          </div>
        ) : channelRecordsError ? (
          <div
            className="px-7 py-5 text-sm"
            style={{
              color: theme.text.dangerStrong,
              borderTop: `1px solid ${theme.border.subtle}`
            }}
          >
            {channelRecordsError}
          </div>
        ) : !groups || groups.length === 0 ? (
          <div
            className="px-7 py-5 text-sm"
            style={{ color: theme.text.muted, borderTop: `1px solid ${theme.border.subtle}` }}
          >
            {t('settings.channels.noGroupsYet')}
          </div>
        ) : (
          groups.map((group) => (
            <ChannelGroupRow
              key={`${group.id}:${group.label}`}
              group={group}
              busy={clearingGroupIds.includes(group.id)}
              clearError={clearErrorsByGroupId[group.id] ?? null}
              onStatusChange={(s) => handleGroupStatusChange(group.id, s)}
              onLabelChange={(l) => handleGroupLabelChange(group.id, l)}
              onClearMessages={() => void handleClearGroupMessages(group.id)}
            />
          ))
        )}
      </SettingSection>

      <SettingSection>
        <SettingLabel>{t('settings.channels.memoryPrivacy')}</SettingLabel>

        <SettingRow>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium" style={{ color: theme.text.primary }}>
              {t('settings.channels.filterKeywords')}
            </div>
            <div className="text-sm" style={{ color: theme.text.tertiary }}>
              {t('settings.channels.filterKeywordsDescription')}
            </div>
          </div>
        </SettingRow>

        <MemoryFilterKeywords
          keywords={config.memoryFilterKeywords ?? []}
          onChange={(keywords) => {
            onConfigChange({ ...config, memoryFilterKeywords: keywords })
          }}
        />
      </SettingSection>

      <SettingSection>
        <RestartServiceButton
          platform="all"
          enabled={anyChannelEnabled}
          label={t('settings.channels.restartAllServices')}
        />
      </SettingSection>
    </div>
  )
}
