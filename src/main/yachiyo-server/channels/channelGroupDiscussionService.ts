import { join } from 'node:path'

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type {
  ChannelGroupRecord,
  ChannelPlatform,
  GroupChannelConfig,
  GroupMessageEntry
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { YACHIYO_USER_FILE_NAME } from '../config/paths.ts'
import {
  compileGroupProbeContextLayers,
  requiresAssistantReasoningForGroupProbeReplay
} from '../runtime/groupProbeContextLayers.ts'
import { readChannelsConfig } from '../runtime/channelsConfig.ts'
import { EXTERNAL_GROUP_PROMPT } from '../runtime/prompt.ts'
import { readUserDocument } from '../runtime/user.ts'
import { createTool as createReadTool } from '../tools/agentTools/readTool.ts'
import { createTool as createUpdateProfileTool } from '../tools/agentTools/updateProfileTool.ts'
import { createTool as createWebReadTool } from '../tools/agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from '../tools/agentTools/webSearchTool.ts'
import type { ChannelPolicy } from './channelPolicy.ts'
import {
  buildGroupProbeBehaviorPrompt,
  buildGroupProbeContextPrompt,
  formatGroupProbeTurnDelta,
  isBareSymbolMessage
} from './groupContextBuilder.ts'
import { createGroupTurnSendGuard } from './groupTurnSendGuard.ts'
import { describeGroupImages } from './groupImageDescriptions.ts'
import { createGroupMonitorRegistry, type GroupMonitorPersistence } from './groupMonitorRegistry.ts'
import {
  loadGroupProbeHistory,
  persistSuccessfulGroupProbeTurn,
  resolveGroupProbeThread
} from './groupProbeThread.ts'
import { hasForbiddenGroupReplyPrefix, hasVisibleGroupReplyContent } from './groupReplyGuard.ts'
import { createSpeechThrottle } from './groupSpeechThrottle.ts'

export interface ChannelGroupDiscussionServiceOptions {
  platform: ChannelPlatform
  logLabel: string
  server: YachiyoServer
  policy: ChannelPolicy
  groupConfig?: GroupChannelConfig
  groupVerbosity?: number
  groupCheckIntervalMs?: number
  rejectMultilineMessages?: boolean
  sendMessage(group: ChannelGroupRecord, message: string): Promise<void>
}

export interface ChannelGroupDiscussionService {
  routeMessage(groupId: string, entry: GroupMessageEntry): void
  onGroupStatusChange(group: ChannelGroupRecord): void
  stop(): void
  clearGroupMessages(groupId: string): void
  describeImages(input: {
    text: string
    images: NonNullable<GroupMessageEntry['images']>
  }): Promise<void>
}

export function createChannelGroupDiscussionService(
  options: ChannelGroupDiscussionServiceOptions
): ChannelGroupDiscussionService {
  const {
    platform,
    logLabel,
    server,
    policy,
    groupConfig,
    groupVerbosity,
    groupCheckIntervalMs,
    rejectMultilineMessages,
    sendMessage
  } = options
  const speechThrottle = createSpeechThrottle(groupVerbosity ?? 0)

  const bufferPersistence: GroupMonitorPersistence = {
    save(groupId, phase, buffer) {
      server.getStorage().saveGroupMonitorBuffer({
        groupId,
        phase,
        buffer,
        savedAt: new Date().toISOString()
      })
    },
    load(groupId) {
      const data = server.getStorage().loadGroupMonitorBuffer(groupId)
      if (!data) return undefined
      return { phase: data.phase as 'dormant' | 'active' | 'engaged', buffer: data.buffer }
    },
    delete(groupId) {
      server.getStorage().deleteGroupMonitorBuffer(groupId)
    }
  }

  function buildKnownUsersMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const user of server.listChannelUsers()) {
      if (user.platform === platform) {
        map.set(user.externalUserId, user.role)
      }
    }
    return map
  }

  async function handleGroupTurn(
    group: ChannelGroupRecord,
    recentMessages: GroupMessageEntry[],
    freshCount: number
  ): Promise<boolean> {
    const auxService = server.getAuxiliaryGenerationService()
    let didSpeak = false
    const turnSendGuard = createGroupTurnSendGuard()

    const sendGroupMessageTool = tool({
      description:
        'Send a message to the group chat. Only call this when you genuinely want to speak. Your raw text output is private and never shown to anyone.',
      inputSchema: z.object({
        message: z
          .string()
          .describe(
            'The message to send to the group. Plain text only. Never start with a colon or }.'
          )
      }),
      execute: async ({ message }) => {
        turnSendGuard.beforeAttempt()

        if (rejectMultilineMessages && message.includes('\n')) {
          console.log(`[${logLabel}] rejected multi-line message for "${group.name}"`)
          return 'Rejected: message must be a single line. Do not include line breaks.'
        }

        if (!hasVisibleGroupReplyContent(message)) {
          console.log(`[${logLabel}] rejected empty message for "${group.name}"`)
          return 'Rejected: message must contain visible text.'
        }

        if (hasForbiddenGroupReplyPrefix(message)) {
          console.log(
            `[${logLabel}] rejected forbidden-prefix message for "${group.name}": ${message}`
          )
          throw new Error('Rejected: message must not start with a colon or }.')
        }

        if (isBareSymbolMessage(message)) {
          console.log(`[${logLabel}] rejected bare-symbol message for "${group.name}": ${message}`)
          return 'Rejected: message contains only punctuation. Write actual words or stay silent.'
        }

        if (speechThrottle.shouldDrop(group.id)) {
          const rate = speechThrottle.getDropRate(group.id)
          console.log(
            `[${logLabel}] throttled message for "${group.name}" (drop rate ${Math.round(rate * 100)}%): ${message.slice(0, 80)}`
          )
          return turnSendGuard.recordBlockedAttempt()
        }

        try {
          await sendMessage(group, message)
          turnSendGuard.recordSent()
          speechThrottle.recordSend(group.id)
          console.log(`[${logLabel}] sent reply to "${group.name}": ${message.slice(0, 100)}`)

          groupRegistry.routeMessage(group.id, {
            senderName: 'Yachiyo',
            senderExternalUserId: '__self__',
            isMention: false,
            text: message,
            timestamp: Date.now() / 1_000
          })

          didSpeak = true
          return 'Message sent.'
        } catch (err) {
          console.error(`[${logLabel}] failed to send message to "${group.name}"`, err)
          return 'Failed to send message.'
        }
      }
    })

    const userDocPath = join(group.workspacePath, YACHIYO_USER_FILE_NAME)
    const groupUserDoc = await readUserDocument({
      filePath: userDocPath,
      mode: 'group'
    })

    const toolContext = { workspacePath: group.workspacePath, sandboxed: true }
    const probeTools: ToolSet = {
      send_group_message: sendGroupMessageTool,
      read: createReadTool(toolContext),
      web_read: createWebReadTool(toolContext),
      web_search: createWebSearchTool(toolContext, {
        webSearchService: server.getWebSearchService()
      }),
      updateProfile: createUpdateProfileTool({
        userDocumentPath: userDocPath,
        userDocumentMode: 'group'
      })
    }

    const settingsOverride = server.resolveProviderSettings(groupConfig?.model)
    const currentTurnContent = formatGroupProbeTurnDelta(
      recentMessages,
      'Yachiyo',
      buildKnownUsersMap(),
      undefined,
      freshCount
    )
    const stableSystemPrompt = buildGroupProbeBehaviorPrompt()
    const dynamicSystemPrompt = buildGroupProbeContextPrompt({
      botName: 'Yachiyo',
      groupName: group.name,
      groupLabel: group.label || undefined,
      personaSummary: EXTERNAL_GROUP_PROMPT,
      ownerInstruction: readChannelsConfig().guestInstruction,
      groupUserDocument: groupUserDoc?.content
    })
    const { thread: probeThread } = await resolveGroupProbeThread({
      logLabel,
      server,
      group,
      groupThreadReuseWindowMs: policy.groupDefaults.groupThreadReuseWindowMs,
      modelOverride: groupConfig?.model
    })
    const messages = compileGroupProbeContextLayers({
      stableSystemPrompt,
      dynamicSystemPrompt,
      rollingSummary: probeThread.rollingSummary,
      history: loadGroupProbeHistory(server.getStorage(), probeThread),
      currentTurnContent,
      requireAssistantReasoningForReplay:
        requiresAssistantReasoningForGroupProbeReplay(settingsOverride)
    })

    console.log(
      `[${logLabel}] group="${group.name}" probing ${freshCount}/${recentMessages.length} fresh message(s) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${currentTurnContent}`
    )

    const result = await auxService.generateText({
      messages,
      tools: probeTools,
      onToolCallError: (event) =>
        event.toolCall.toolName === 'send_group_message' ? 'abort' : 'continue',
      settingsOverride,
      purpose: `${logLabel}-probe`
    })

    if (result.status === 'success') {
      persistSuccessfulGroupProbeTurn({
        storage: server.getStorage(),
        generateId: () => server.generateId(),
        thread: probeThread,
        requestContent: currentTurnContent,
        result
      })
      console.log(
        `[${logLabel}] group="${group.name}" monologue: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`
      )
      console.log(`[${logLabel}] group="${group.name}" didSpeak=${didSpeak}`)
    } else {
      console.warn(
        `[${logLabel}] auxiliary generation ${result.status}:`,
        result.status === 'failed' ? result.error : result.reason
      )
    }

    return didSpeak
  }

  const groupRegistry = createGroupMonitorRegistry(
    policy.groupDefaults,
    groupConfig,
    {
      async onTurn(group, recentMessages, freshCount) {
        return handleGroupTurn(group, recentMessages, freshCount)
      },
      onStateChange(group, newPhase) {
        console.log(`[${logLabel}] "${group.name}" phase → ${newPhase}`)
      }
    },
    groupCheckIntervalMs,
    bufferPersistence
  )

  for (const group of server.listChannelGroups()) {
    if (group.platform === platform && group.status === 'approved') {
      groupRegistry.startMonitor(group)
    }
  }

  return {
    routeMessage(groupId, entry) {
      groupRegistry.routeMessage(groupId, entry)
    },

    onGroupStatusChange(group) {
      if (group.platform !== platform) return

      groupRegistry.updateGroup(group)
      if (group.status === 'approved') {
        groupRegistry.startMonitor(group)
        console.log(`[${logLabel}] monitor started for "${group.name}" after approval`)
      } else {
        groupRegistry.stopMonitor(group.id)
        console.log(`[${logLabel}] monitor stopped for "${group.name}" (status=${group.status})`)
      }
    },

    stop() {
      groupRegistry.stopAll()
    },

    clearGroupMessages(groupId) {
      groupRegistry.clearGroupMessages(groupId)
    },

    describeImages(input) {
      return describeGroupImages({
        server,
        text: input.text,
        images: input.images,
        logLabel
      })
    }
  }
}
