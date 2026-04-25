import type {
  ChannelsConfig,
  DiscordChannelConfig,
  GroupChannelConfig,
  QQBotChannelConfig,
  QQChannelConfig,
  TelegramChannelConfig,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol.ts'
import type { TomlConfigSlice, TomlDoc } from '../config/tomlSlices.ts'
import { readTomlTable } from '../config/tomlSlices.ts'

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

function readModel(section: Record<string, unknown>): ThreadModelOverride | undefined {
  const providerName = readString(section['model_provider'])
  const model = readString(section['model_name'])
  return providerName && model ? { providerName, model } : undefined
}

function readGroupConfig(section: Record<string, unknown>): GroupChannelConfig | undefined {
  const group = readTomlTable(section['group'])
  if (!group) {
    return undefined
  }

  const model = readModel(group)
  const vision = typeof group['vision'] === 'boolean' ? group['vision'] : undefined
  const activeCheckIntervalMs = readInteger(group['active_check_interval_ms'])
  const engagedCheckIntervalMs = readInteger(group['engaged_check_interval_ms'])
  const wakeBufferMs = readInteger(group['wake_buffer_ms'])
  const dormancyMissCount = readInteger(group['dormancy_miss_count'])
  const disengageMissCount = readInteger(group['disengage_miss_count'])

  return {
    enabled: readBoolean(group['enabled']),
    ...(model ? { model } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(activeCheckIntervalMs !== undefined ? { activeCheckIntervalMs } : {}),
    ...(engagedCheckIntervalMs !== undefined ? { engagedCheckIntervalMs } : {}),
    ...(wakeBufferMs !== undefined ? { wakeBufferMs } : {}),
    ...(dormancyMissCount !== undefined ? { dormancyMissCount } : {}),
    ...(disengageMissCount !== undefined ? { disengageMissCount } : {})
  }
}

function buildSection(
  entries: Array<[string, string | boolean | number | string[] | undefined]>
): Record<string, unknown> {
  const section: Record<string, unknown> = {}

  for (const [key, value] of entries) {
    if (value !== undefined) {
      section[key] = value
    }
  }

  return section
}

function buildModelEntries(model?: ThreadModelOverride): Array<[string, string | undefined]> {
  return [
    ['model_provider', model?.providerName],
    ['model_name', model?.model]
  ]
}

function buildGroupSection(group: GroupChannelConfig): Record<string, unknown> {
  const section: Record<string, unknown> = { enabled: group.enabled }

  for (const [key, value] of buildModelEntries(group.model)) {
    if (value !== undefined) {
      section[key] = value
    }
  }

  if (group.vision !== undefined) {
    section['vision'] = group.vision
  }
  if (group.activeCheckIntervalMs !== undefined) {
    section['active_check_interval_ms'] = group.activeCheckIntervalMs
  }
  if (group.engagedCheckIntervalMs !== undefined) {
    section['engaged_check_interval_ms'] = group.engagedCheckIntervalMs
  }
  if (group.wakeBufferMs !== undefined) {
    section['wake_buffer_ms'] = group.wakeBufferMs
  }
  if (group.dormancyMissCount !== undefined) {
    section['dormancy_miss_count'] = group.dormancyMissCount
  }
  if (group.disengageMissCount !== undefined) {
    section['disengage_miss_count'] = group.disengageMissCount
  }

  return section
}

function readTelegram(section: Record<string, unknown>): TelegramChannelConfig {
  const model = readModel(section)
  const group = readGroupConfig(section)

  return {
    enabled: readBoolean(section['enabled']),
    botToken: readString(section['bot_token']),
    ...(model ? { model } : {}),
    ...(group ? { group } : {})
  }
}

function writeTelegram(config?: TelegramChannelConfig): Record<string, unknown> | undefined {
  if (!config) {
    return undefined
  }

  const section = buildSection([
    ['enabled', config.enabled],
    ['bot_token', config.botToken],
    ...buildModelEntries(config.model)
  ])

  if (config.group) {
    section['group'] = buildGroupSection(config.group)
  }

  return section
}

function readQQ(section: Record<string, unknown>): QQChannelConfig {
  const model = readModel(section)
  const group = readGroupConfig(section)
  const token = readString(section['token'])

  return {
    enabled: readBoolean(section['enabled']),
    wsUrl: readString(section['ws_url']),
    ...(token ? { token } : {}),
    ...(model ? { model } : {}),
    ...(group ? { group } : {})
  }
}

function writeQQ(config?: QQChannelConfig): Record<string, unknown> | undefined {
  if (!config) {
    return undefined
  }

  const section = buildSection([
    ['enabled', config.enabled],
    ['ws_url', config.wsUrl],
    ['token', config.token],
    ...buildModelEntries(config.model)
  ])

  if (config.group) {
    section['group'] = buildGroupSection(config.group)
  }

  return section
}

function readQQBot(section: Record<string, unknown>): QQBotChannelConfig {
  const model = readModel(section)

  return {
    enabled: readBoolean(section['enabled']),
    appId: readString(section['app_id']),
    clientSecret: readString(section['client_secret']),
    ...(model ? { model } : {})
  }
}

function writeQQBot(config?: QQBotChannelConfig): Record<string, unknown> | undefined {
  if (!config) {
    return undefined
  }

  return buildSection([
    ['enabled', config.enabled],
    ['app_id', config.appId],
    ['client_secret', config.clientSecret],
    ...buildModelEntries(config.model)
  ])
}

function readDiscord(section: Record<string, unknown>): DiscordChannelConfig {
  const model = readModel(section)
  const group = readGroupConfig(section)

  return {
    enabled: readBoolean(section['enabled']),
    botToken: readString(section['bot_token']),
    ...(model ? { model } : {}),
    ...(group ? { group } : {})
  }
}

function writeDiscord(config?: DiscordChannelConfig): Record<string, unknown> | undefined {
  if (!config) {
    return undefined
  }

  const section = buildSection([
    ['enabled', config.enabled],
    ['bot_token', config.botToken],
    ...buildModelEntries(config.model)
  ])

  if (config.group) {
    section['group'] = buildGroupSection(config.group)
  }

  return section
}

export const channelsTomlSlices: readonly TomlConfigSlice<ChannelsConfig, TomlDoc>[] = [
  {
    key: 'telegram',
    read(doc) {
      const section = readTomlTable(doc['telegram'])
      return section ? { telegram: readTelegram(section) } : {}
    },
    write(config) {
      const telegram = writeTelegram(config.telegram)
      return telegram ? { telegram } : {}
    }
  },
  {
    key: 'qq',
    read(doc) {
      const section = readTomlTable(doc['qq'])
      return section ? { qq: readQQ(section) } : {}
    },
    write(config) {
      const qq = writeQQ(config.qq)
      return qq ? { qq } : {}
    }
  },
  {
    key: 'discord',
    read(doc) {
      const section = readTomlTable(doc['discord'])
      return section ? { discord: readDiscord(section) } : {}
    },
    write(config) {
      const discord = writeDiscord(config.discord)
      return discord ? { discord } : {}
    }
  },
  {
    key: 'qqbot',
    read(doc) {
      const section = readTomlTable(doc['qqbot'])
      return section ? { qqbot: readQQBot(section) } : {}
    },
    write(config) {
      const qqbot = writeQQBot(config.qqbot)
      return qqbot ? { qqbot } : {}
    }
  },
  {
    key: 'privacy',
    read(doc) {
      const privacy = readTomlTable(doc['privacy'])
      if (!privacy) {
        return {}
      }

      const guestInstruction = privacy['guest_instruction']
      const memoryFilterKeywords = Array.isArray(privacy['memory_filter_keywords'])
        ? privacy['memory_filter_keywords'].filter(
            (value): value is string => typeof value === 'string'
          )
        : undefined

      return {
        ...(typeof guestInstruction === 'string' && guestInstruction.trim()
          ? { guestInstruction }
          : {}),
        ...(memoryFilterKeywords ? { memoryFilterKeywords } : {})
      }
    },
    write(config) {
      const hasPrivacy =
        config.guestInstruction?.trim() ||
        (config.memoryFilterKeywords && config.memoryFilterKeywords.length > 0)

      if (!hasPrivacy) {
        return {}
      }

      return {
        privacy: buildSection([
          ['guest_instruction', config.guestInstruction?.trim() || undefined],
          [
            'memory_filter_keywords',
            config.memoryFilterKeywords?.length ? config.memoryFilterKeywords : undefined
          ]
        ])
      }
    }
  },
  {
    key: 'image_to_text',
    read(doc) {
      const section = readTomlTable(doc['image_to_text'])
      if (!section) {
        return {}
      }

      const model = readModel(section)
      return {
        imageToText: {
          enabled: readBoolean(section['enabled']),
          ...(model ? { model } : {})
        } as ChannelsConfig['imageToText'] & { model?: ThreadModelOverride }
      }
    },
    write(config) {
      if (!config.imageToText) {
        return {}
      }

      return {
        image_to_text: buildSection([['enabled', config.imageToText.enabled === true]])
      }
    }
  },
  {
    key: 'group',
    read(doc) {
      const section = readTomlTable(doc['group'])
      if (!section) {
        return {}
      }

      const groupVerbosity =
        typeof section['verbosity'] === 'number' && Number.isFinite(section['verbosity'])
          ? Math.max(0, Math.min(1, section['verbosity']))
          : undefined
      const groupCheckIntervalMs = readInteger(section['check_interval_ms'])
      const dmCompactTokenThresholdK = readInteger(section['dm_compact_token_threshold_k'])
      const groupContextWindowK = readInteger(section['group_context_window_k'])

      return {
        ...(groupVerbosity !== undefined ? { groupVerbosity } : {}),
        ...(groupCheckIntervalMs !== undefined ? { groupCheckIntervalMs } : {}),
        ...(dmCompactTokenThresholdK !== undefined ? { dmCompactTokenThresholdK } : {}),
        ...(groupContextWindowK !== undefined ? { groupContextWindowK } : {})
      }
    },
    write(config) {
      const hasGroup =
        config.groupVerbosity !== undefined ||
        config.groupCheckIntervalMs !== undefined ||
        config.dmCompactTokenThresholdK !== undefined ||
        config.groupContextWindowK !== undefined

      if (!hasGroup) {
        return {}
      }

      return {
        group: buildSection([
          ['verbosity', config.groupVerbosity],
          ['check_interval_ms', config.groupCheckIntervalMs],
          ['dm_compact_token_threshold_k', config.dmCompactTokenThresholdK],
          ['group_context_window_k', config.groupContextWindowK]
        ])
      }
    }
  }
]
