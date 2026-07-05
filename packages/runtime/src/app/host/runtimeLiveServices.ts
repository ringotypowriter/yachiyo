import type {
  ChannelGroupRecord,
  ChannelsConfig,
  ShowNotificationInput,
  UpdateChannelGroupInput
} from '@yachiyo/shared/protocol'

import {
  createDiscordService,
  type DiscordService
} from '../../channels/platforms/discord/discordService.ts'
import { createQQService, type QQService } from '../../channels/platforms/qq/qqService.ts'
import {
  createQQBotService,
  type QQBotService
} from '../../channels/platforms/qqbot/qqbotService.ts'
import {
  createTelegramService,
  type TelegramService
} from '../../channels/platforms/telegram/telegramService.ts'
import {
  applyChannelsConfigToPolicy,
  discordPolicy,
  qqbotPolicy,
  qqPolicy,
  telegramPolicy
} from '../../channels/shared/channelPolicy.ts'
import {
  createChannelServiceSupervisor,
  type ChannelServicePlatform,
  type ChannelServiceSupervisor
} from '../../channels/shared/channelServiceLifecycle.ts'
import {
  createAutoSyncScheduler,
  type AutoSyncScheduler
} from '../../services/autoSyncScheduler.ts'
import { getPerfMonitor } from '../../services/perfMonitor.ts'
import { createScheduleService, type ScheduleService } from '../../services/scheduleService.ts'
import type { YachiyoServer } from './YachiyoServer.ts'

const CHANNEL_HEALTH_INTERVAL_MS = 60_000

export interface SendChannelMessageInput {
  id: string
  message: string
}

export interface RuntimeLiveServicesOptions {
  server: YachiyoServer
  /** Notification display; Electron-backed in main, reverse-RPC from a utility host. */
  showNotification: (input: ShowNotificationInput) => void
  tempWorkspaceDir: string
  enableSchedules: boolean
  enableChannels: boolean
}

export interface RuntimeLiveServices {
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Host-level operations served over RPC next to the server's own methods
   * (via mergeRpcTargets), so gateway handlers stay identical whether the
   * runtime runs in-process or in a utility process.
   */
  rpcOps: Record<string, (input: never) => unknown>
}

/**
 * Owns the runtime's live services — schedules, auto-sync, and channel
 * services — next to the server they drive. Runs in whichever process hosts
 * YachiyoServer: the Electron main process today, the utility runtime host
 * under YACHIYO_RUNTIME_UTILITY=1.
 */
export function createRuntimeLiveServices(
  options: RuntimeLiveServicesOptions
): RuntimeLiveServices {
  const { server } = options
  let telegramService: TelegramService | null = null
  let qqService: QQService | null = null
  let discordService: DiscordService | null = null
  let qqbotService: QQBotService | null = null
  let channelsConfigForSupervisor: ChannelsConfig | null = null
  let channelSupervisor: ChannelServiceSupervisor | null = null
  let channelHealthTimer: ReturnType<typeof setInterval> | null = null
  let scheduleService: ScheduleService | null = null
  let autoSyncScheduler: AutoSyncScheduler | null = null

  function buildChannelServiceConfigKey(
    cfg: ChannelsConfig,
    platform: ChannelServicePlatform
  ): string {
    return JSON.stringify({
      platform: cfg[platform],
      groupVerbosity: cfg.groupVerbosity,
      groupCheckIntervalMs: cfg.groupCheckIntervalMs,
      dmCompactTokenThresholdK: cfg.dmCompactTokenThresholdK,
      groupContextWindowK: cfg.groupContextWindowK,
      groupHandoffThresholdK: cfg.groupHandoffThresholdK
    })
  }

  function getChannelSupervisor(): ChannelServiceSupervisor {
    if (channelSupervisor) return channelSupervisor

    channelSupervisor = createChannelServiceSupervisor({
      telegram: {
        label: 'telegram',
        enabled: () => {
          const token = channelsConfigForSupervisor?.telegram?.botToken?.trim()
          return Boolean(channelsConfigForSupervisor?.telegram?.enabled && token)
        },
        configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'telegram'),
        create: () => {
          const cfg = channelsConfigForSupervisor!
          const token = cfg.telegram!.botToken!.trim()
          return createTelegramService({
            botToken: token,
            model: cfg.telegram?.model,
            server,
            groupConfig: cfg.telegram?.group,
            botUsername: undefined,
            groupVerbosity: cfg.groupVerbosity,
            groupCheckIntervalMs: cfg.groupCheckIntervalMs,
            policy: applyChannelsConfigToPolicy(telegramPolicy, cfg)
          })
        },
        onServiceChange: (service) => {
          telegramService = service as TelegramService | null
        }
      },
      qq: {
        label: 'qq',
        enabled: () => {
          const wsUrl = channelsConfigForSupervisor?.qq?.wsUrl?.trim()
          return Boolean(channelsConfigForSupervisor?.qq?.enabled && wsUrl)
        },
        configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'qq'),
        create: () => {
          const cfg = channelsConfigForSupervisor!
          const wsUrl = cfg.qq!.wsUrl!.trim()
          return createQQService({
            wsUrl,
            token: cfg.qq?.token,
            model: cfg.qq?.model,
            server,
            groupConfig: cfg.qq?.group,
            botQQId: undefined,
            groupVerbosity: cfg.groupVerbosity,
            groupCheckIntervalMs: cfg.groupCheckIntervalMs,
            policy: applyChannelsConfigToPolicy(qqPolicy, cfg)
          })
        },
        onServiceChange: (service) => {
          qqService = service as QQService | null
        }
      },
      discord: {
        label: 'discord',
        enabled: () => {
          const token = channelsConfigForSupervisor?.discord?.botToken?.trim()
          return Boolean(channelsConfigForSupervisor?.discord?.enabled && token)
        },
        configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'discord'),
        create: () => {
          const cfg = channelsConfigForSupervisor!
          const token = cfg.discord!.botToken!.trim()
          return createDiscordService({
            botToken: token,
            model: cfg.discord?.model,
            server,
            groupConfig: cfg.discord?.group,
            groupVerbosity: cfg.groupVerbosity,
            groupCheckIntervalMs: cfg.groupCheckIntervalMs,
            policy: applyChannelsConfigToPolicy(discordPolicy, cfg)
          })
        },
        onServiceChange: (service) => {
          discordService = service as DiscordService | null
        }
      },
      qqbot: {
        label: 'qqbot',
        enabled: () => {
          const appId = channelsConfigForSupervisor?.qqbot?.appId?.trim()
          const clientSecret = channelsConfigForSupervisor?.qqbot?.clientSecret?.trim()
          return Boolean(channelsConfigForSupervisor?.qqbot?.enabled && appId && clientSecret)
        },
        configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'qqbot'),
        create: () => {
          const cfg = channelsConfigForSupervisor!
          return createQQBotService({
            appId: cfg.qqbot!.appId!.trim(),
            clientSecret: cfg.qqbot!.clientSecret!.trim(),
            model: cfg.qqbot?.model,
            server,
            policy: applyChannelsConfigToPolicy(qqbotPolicy, cfg)
          })
        },
        onServiceChange: (service) => {
          qqbotService = service as QQBotService | null
        }
      }
    })

    return channelSupervisor
  }

  function notifyGroupStatusChange(updated: ChannelGroupRecord): void {
    telegramService?.onGroupStatusChange(updated)
    qqService?.onGroupStatusChange(updated)
    discordService?.onGroupStatusChange(updated)
  }

  async function sendChannelMessage(input: SendChannelMessageInput): Promise<void> {
    const storage = server.getStorage()
    const channelUser = storage.getChannelUser(input.id)
    const channelGroup = channelUser ? undefined : storage.getChannelGroup(input.id)

    if (!channelUser && !channelGroup) {
      throw new Error(`Unknown channel user or group: ${input.id}`)
    }

    const platform = channelUser?.platform ?? channelGroup!.platform
    const externalId = channelUser?.externalUserId ?? channelGroup!.externalGroupId

    if (platform === 'telegram') {
      if (!telegramService) throw new Error('Telegram service is not running')
      await telegramService.sendMessage(externalId, input.message)
    } else if (platform === 'qq') {
      if (!qqService) throw new Error('QQ service is not running')
      const numericId = Number(externalId)
      if (channelUser) {
        await qqService.sendPrivateMessage(numericId, input.message)
      } else {
        await qqService.sendGroupMessage(numericId, input.message)
      }
    } else if (platform === 'discord') {
      if (!discordService) throw new Error('Discord service is not running')
      await discordService.sendMessage(externalId, input.message)
    } else if (platform === 'qqbot') {
      if (!qqbotService) throw new Error('QQBot service is not running')
      await qqbotService.sendMessage(externalId, input.message)
    } else {
      throw new Error(`Unsupported platform: ${platform}`)
    }
    console.log(`[send-channel] sent to ${platform}:${externalId}`)
  }

  async function start(): Promise<void> {
    scheduleService = createScheduleService({
      server: {
        createThread: (input) => server.createThread(input),
        setThreadModelOverride: (input) => server.setThreadModelOverride(input),
        setThreadIcon: (input) => server.setThreadIcon(input),
        sendChat: (input) => server.sendChat(input),
        archiveThread: (input) => server.archiveThread(input),
        showNotification: (input) => options.showNotification(input),
        subscribe: (listener) => server.subscribe(listener)
      },
      storage: server.getStorage(),
      createId: () => server.generateId(),
      timestamp: () => new Date().toISOString(),
      tempWorkspaceDir: options.tempWorkspaceDir
    })
    if (options.enableSchedules) {
      scheduleService.start()
    }

    // Keep iCloud sync flowing automatically. The scheduler no-ops until the
    // user has enabled sync (runAutoSyncCycle gates on readiness).
    autoSyncScheduler = createAutoSyncScheduler({
      runSync: () => server.runAutoSyncCycle(),
      subscribe: (listener) => server.subscribe(listener),
      onError: (error) =>
        console.warn('[auto-sync]', error instanceof Error ? error.message : error)
    })
    autoSyncScheduler.start()

    if (options.enableChannels) {
      channelsConfigForSupervisor = server.getChannelsConfig()
      await getChannelSupervisor().reconcileAll('initial startup')
    }

    channelHealthTimer = setInterval(() => {
      void channelSupervisor?.poke('periodic health check')
    }, CHANNEL_HEALTH_INTERVAL_MS)
  }

  async function stop(): Promise<void> {
    if (channelHealthTimer) {
      clearInterval(channelHealthTimer)
      channelHealthTimer = null
    }
    autoSyncScheduler?.stop()
    autoSyncScheduler = null
    scheduleService?.stop()
    scheduleService = null

    await channelSupervisor?.stopAll('live services stopping')
    telegramService = null
    qqService = null
    discordService = null
    qqbotService = null
  }

  const rpcOps = {
    'host.updateChannelGroupAndNotify': (input: UpdateChannelGroupInput): ChannelGroupRecord => {
      const updated = server.updateChannelGroup(input)
      notifyGroupStatusChange(updated)
      return updated
    },
    'host.clearChannelGroupHistory': (input: { groupId: string }): void => {
      server.startClearChannelGroupHistory(input)
      telegramService?.clearGroupMessages(input.groupId)
      qqService?.clearGroupMessages(input.groupId)
      discordService?.clearGroupMessages(input.groupId)
    },
    'host.saveChannelsConfigAndReconcile': async (
      input: ChannelsConfig
    ): Promise<ChannelsConfig> => {
      const saved = server.saveChannelsConfig(input)
      channelsConfigForSupervisor = saved
      await getChannelSupervisor().reconcileAll('config changed')
      return saved
    },
    'host.restartChannelServices': async (input: {
      platform: ChannelServicePlatform | 'all'
    }): Promise<void> => {
      channelsConfigForSupervisor = server.getChannelsConfig()
      if (input.platform === 'all') {
        await getChannelSupervisor().restartAll('manual restart')
        return
      }
      await getChannelSupervisor().restart(input.platform, 'manual restart')
    },
    'host.reloadSchedules': (): void => {
      scheduleService?.reload()
    },
    'host.triggerScheduleNow': async (input: { scheduleId: string }): Promise<void> => {
      await scheduleService?.triggerScheduleNow(input.scheduleId)
    },
    'host.sendChannelMessage': (input: SendChannelMessageInput): Promise<void> =>
      sendChannelMessage(input),
    'host.pokeChannels': (input: { reason: string }): void => {
      void channelSupervisor?.poke(input.reason)
    },
    // Run perf records live in the process that runs the pipeline; the
    // gateway merges them with main-side IPC stats for the Settings panel.
    'host.getPerfStats': () => getPerfMonitor().getStats(),
    'host.stopLiveServices': (): Promise<void> => stop()
  }

  return { start, stop, rpcOps: rpcOps as RuntimeLiveServices['rpcOps'] }
}
