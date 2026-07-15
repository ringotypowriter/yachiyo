import { join } from 'node:path'

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type {
  ChannelGroupRecord,
  ChannelPlatform,
  GroupProbeHeadlessAdapterConfig,
  GroupChannelConfig,
  GroupMessageEntry,
  ProviderSettings
} from '@yachiyo/shared/protocol'
import { resolveGroupProbeHeadlessAdapter } from '@yachiyo/shared/protocol'
import type { YachiyoServer } from '../../app/host/YachiyoServer.ts'
import { YACHIYO_USER_FILE_NAME } from '../../config/paths.ts'
import { compileGroupProbeContextLayers } from '../../runtime/context/groupProbeContextLayers.ts'
import { readChannelsConfig } from '../../runtime/config/channelsConfig.ts'
import { EXTERNAL_GROUP_PROMPT, GROUP_STYLE_REMINDER } from '../../runtime/context/prompt.ts'
import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelMessage } from '../../runtime/models/types.ts'
import { readUserDocument } from '../../runtime/profiles/user.ts'
import { createTool as createReadTool } from '../../tools/agentTools/readTool.ts'
import { createTool as createUpdateProfileTool } from '../../tools/agentTools/updateProfileTool.ts'
import { createTool as createWebReadTool } from '../../tools/agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from '../../tools/agentTools/webSearchTool.ts'
import type { ChannelPolicy } from '../shared/channelPolicy.ts'
import {
  buildGroupProbeBehaviorPrompt,
  buildGroupProbeContextPrompt,
  formatGroupProbeTurnDelta,
  isBareSymbolMessage
} from './groupContextBuilder.ts'
import { createGroupTurnSendGuard } from './groupTurnSendGuard.ts'
import { describeGroupImages } from './groupImageDescriptions.ts'
import { hasGroupProbeVisibleContent, hasPendingImageDescription } from './groupMessageReadiness.ts'
import { createGroupMonitorRegistry, type GroupMonitorPersistence } from './groupMonitorRegistry.ts'
import {
  loadGroupProbeHistory,
  persistSuccessfulGroupProbeTurn,
  resolveGroupProbeThread
} from './groupProbeThread.ts'
import {
  GROUP_REPLY_MAX_CHARS,
  findGroupReplyStyleIssue,
  hasForbiddenGroupReplyPrefix,
  hasVisibleGroupReplyContent,
  isOverlongGroupReply
} from './groupReplyGuard.ts'
import {
  CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID,
  runClaudeCodeGroupProbe
} from './groupProbeClaudeCode.ts'
import { rewriteGroupReply } from './groupReplyRewrite.ts'
import { summarizeGroupProbeContext } from './groupProbeHandoff.ts'
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

function dropHeadlessReplayMessages(
  result: Extract<AuxiliaryTextGenerationResult, { status: 'success' }>
): Extract<AuxiliaryTextGenerationResult, { status: 'success' }> {
  if (!result.usage) {
    return { ...result, responseMessages: undefined }
  }
  return {
    ...result,
    responseMessages: undefined,
    usage: { ...result.usage, responseMessages: undefined }
  }
}

export async function runGroupProbeHeadlessAdapter(input: {
  adapter: GroupProbeHeadlessAdapterConfig
  group: ChannelGroupRecord
  logLabel: string
  messages: ModelMessage[]
  sendGroupMessage: (message: string, toolCallId: string) => Promise<string>
  runClaudeCodeProbe?: typeof runClaudeCodeGroupProbe
}): Promise<AuxiliaryTextGenerationResult> {
  switch (input.adapter.adapter) {
    case 'claude-code':
      return (input.runClaudeCodeProbe ?? runClaudeCodeGroupProbe)({
        messages: input.messages,
        workspacePath: input.group.workspacePath,
        providerName: input.adapter.providerName,
        model: input.adapter.model
      }).then(async (probeResult) => {
        if (probeResult.status === 'failed') {
          return probeResult.auxiliaryResult
        }
        if (probeResult.decision.action !== 'send') {
          return probeResult.auxiliaryResult
        }

        try {
          const sendResult = await input.sendGroupMessage(
            probeResult.decision.message,
            CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID
          )
          return sendResult === 'Message sent.'
            ? probeResult.auxiliaryResult
            : dropHeadlessReplayMessages(probeResult.auxiliaryResult)
        } catch (error) {
          console.warn(`[${input.logLabel}] Claude Code group probe send rejected:`, error)
          return dropHeadlessReplayMessages(probeResult.auxiliaryResult)
        }
      })
  }
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

  // Probe threads whose context handoff summarization is currently running, so a
  // second turn does not kick off a duplicate summarization for the same thread.
  const handoffInFlight = new Set<string>()

  async function handleGroupTurn(
    group: ChannelGroupRecord,
    recentMessages: GroupMessageEntry[],
    freshCount: number
  ): Promise<boolean> {
    const auxService = server.getAuxiliaryGenerationService()
    let didSpeak = false
    const turnSendGuard = createGroupTurnSendGuard()

    // Voice pass: optional channel-global rewrite model that restates outgoing
    // replies in the persona's chat voice. Unset = replies go out as generated.
    const groupRewriteModel = readChannelsConfig().groupRewriteModel
    let rewriteSettings: ProviderSettings | undefined
    if (groupRewriteModel) {
      try {
        rewriteSettings = server.resolveProviderSettings(groupRewriteModel)
      } catch (err) {
        console.warn(`[${logLabel}] rewrite model unresolvable, sending replies as generated:`, err)
      }
    }
    const sentTextByToolCallId = new Map<string, string>()

    async function attemptSendGroupMessage(message: string, toolCallId?: string): Promise<string> {
      turnSendGuard.beforeAttempt()

      if (rejectMultilineMessages && message.includes('\n')) {
        console.log(`[${logLabel}] rejected multi-line message for "${group.name}"`)
        return 'Rejected: message must be a single line. Do not include line breaks.'
      }

      if (!hasVisibleGroupReplyContent(message)) {
        console.log(`[${logLabel}] rejected empty message for "${group.name}"`)
        return 'Rejected: message must contain visible text.'
      }

      if (isOverlongGroupReply(message)) {
        console.log(
          `[${logLabel}] rejected over-length message (${[...message.trim()].length} chars) for "${group.name}": ${message.slice(0, 80)}`
        )
        return `Rejected: too long for a group chat message. Resend the same point in at most two short sentences (hard limit ${GROUP_REPLY_MAX_CHARS} characters), or stay silent if it is not worth that little space.`
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

      const styleIssue = findGroupReplyStyleIssue(message)
      if (styleIssue) {
        console.log(
          `[${logLabel}] rejected style issue for "${group.name}" (${styleIssue.split('.')[0]}): ${message.slice(0, 80)}`
        )
        return `Rejected: the message ${styleIssue} Resend it the way you would actually type it in chat, or stay silent.`
      }

      if (speechThrottle.shouldDrop(group.id)) {
        const rate = speechThrottle.getDropRate(group.id)
        console.log(
          `[${logLabel}] throttled message for "${group.name}" (drop rate ${Math.round(rate * 100)}%): ${message.slice(0, 80)}`
        )
        return turnSendGuard.recordBlockedAttempt()
      }

      let outgoing = message
      if (rewriteSettings) {
        const rewritten = await rewriteGroupReply({
          auxService,
          message,
          settingsOverride: rewriteSettings
        })
        if (rewritten && rewritten !== message) {
          console.log(
            `[${logLabel}] voice pass for "${group.name}": ${message.slice(0, 80)} -> ${rewritten.slice(0, 80)}`
          )
          outgoing = rewritten
        }
      }

      try {
        await sendMessage(group, outgoing)
        turnSendGuard.recordSent()
        speechThrottle.recordSend(group.id)
        console.log(`[${logLabel}] sent reply to "${group.name}": ${outgoing.slice(0, 100)}`)
        if (toolCallId && outgoing !== message) {
          sentTextByToolCallId.set(toolCallId, outgoing)
        }

        groupRegistry.routeMessage(group.id, {
          senderName: 'Yachiyo',
          senderExternalUserId: '__self__',
          isMention: false,
          text: outgoing,
          timestamp: Date.now() / 1_000
        })

        didSpeak = true
        return 'Message sent.'
      } catch (err) {
        console.error(`[${logLabel}] failed to send message to "${group.name}"`, err)
        return 'Failed to send message.'
      }
    }

    const sendGroupMessageTool = tool({
      description:
        'Send a message to the group chat. Only call this when you genuinely want to speak. Your raw text output is private and never shown to anyone.',
      inputSchema: z.object({
        message: z
          .string()
          .describe(
            `The message to send to the group. Plain text only, one or two short chat sentences — hard limit ${GROUP_REPLY_MAX_CHARS} characters. Never start with a colon or }.`
          )
      }),
      execute: async ({ message }, { toolCallId }) => attemptSendGroupMessage(message, toolCallId)
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

    const channelsConfig = readChannelsConfig()
    const headlessAdapter = resolveGroupProbeHeadlessAdapter(
      channelsConfig.groupProbeAdapter,
      groupConfig?.model
    )
    const stableSystemPrompt = buildGroupProbeBehaviorPrompt()
    const dynamicSystemPrompt = buildGroupProbeContextPrompt({
      botName: 'Yachiyo',
      groupName: group.name,
      groupLabel: group.label || undefined,
      personaSummary: EXTERNAL_GROUP_PROMPT,
      ownerInstruction: channelsConfig.guestInstruction,
      groupUserDocument: groupUserDoc?.content
    })
    const { thread: probeThread, created: probeThreadCreated } = await resolveGroupProbeThread({
      logLabel,
      server,
      group,
      groupThreadReuseWindowMs: policy.groupDefaults.groupThreadReuseWindowMs,
      modelOverride: groupConfig?.model
    })
    // A freshly created thread has no persisted history to replay, so its
    // first turn renders the WHOLE buffered window (freshCount omitted) —
    // otherwise a thread rotation would amnesia away everything before it,
    // including Yachiyo's own recent lines (#55). Reused threads render only
    // the fresh delta; older context comes from persisted history.
    const currentTurnContent = formatGroupProbeTurnDelta(
      recentMessages,
      'Yachiyo',
      buildKnownUsersMap(),
      undefined,
      probeThreadCreated ? undefined : freshCount
    )
    const messages = compileGroupProbeContextLayers({
      stableSystemPrompt,
      dynamicSystemPrompt,
      contextHandoffSummary: probeThread.contextHandoffSummary,
      history: loadGroupProbeHistory(server.getStorage(), probeThread),
      currentTurnContent,
      historyTokenBudget: policy.groupContextTokenLimit,
      styleReminder: GROUP_STYLE_REMINDER,
      anthropicCacheBreakpoints: !headlessAdapter
    })

    let result: AuxiliaryTextGenerationResult
    let handoffSettingsOverride: ProviderSettings | undefined
    if (headlessAdapter) {
      console.log(
        `[${logLabel}] group="${group.name}" probing ${freshCount}/${recentMessages.length} fresh message(s) with ${headlessAdapter.providerName}/${headlessAdapter.model}:\n${currentTurnContent}`
      )
      result = await runGroupProbeHeadlessAdapter({
        adapter: headlessAdapter,
        group,
        logLabel,
        messages,
        sendGroupMessage: attemptSendGroupMessage
      })
    } else {
      const settingsOverride = server.resolveProviderSettings(groupConfig?.model)
      handoffSettingsOverride = settingsOverride
      console.log(
        `[${logLabel}] group="${group.name}" probing ${freshCount}/${recentMessages.length} fresh message(s) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${currentTurnContent}`
      )
      result = await auxService.generateText({
        messages,
        promptCacheKey: probeThread.id,
        tools: probeTools,
        onToolCallError: (event) =>
          event.toolCall.toolName === 'send_group_message' ? 'abort' : 'continue',
        settingsOverride,
        purpose: `${logLabel}-probe`
      })
    }

    if (result.status === 'success') {
      persistSuccessfulGroupProbeTurn({
        storage: server.getStorage(),
        generateId: () => server.generateId(),
        thread: probeThread,
        requestContent: currentTurnContent,
        result,
        sentTextByToolCallId
      })
      // Compress the older transcript into a rolling summary + advance the
      // watermark once the probe's prompt has grown enough, in the background so
      // the reply path stays fast. Gating uses the provider-reported prompt size
      // from this turn rather than a transcript-length guess.
      if (policy.groupHandoffTokenThreshold > 0 && !handoffInFlight.has(probeThread.id)) {
        handoffInFlight.add(probeThread.id)
        void summarizeGroupProbeContext({
          storage: server.getStorage(),
          auxService,
          threadId: probeThread.id,
          promptTokens: result.usage?.initialPromptTokens,
          handoffThresholdTokens: policy.groupHandoffTokenThreshold,
          groupName: group.name,
          settingsOverride: handoffSettingsOverride
        })
          .then((outcome) => {
            if (outcome.status === 'summarized') {
              console.log(
                `[${logLabel}] group="${group.name}" compressed old context into a handoff summary`
              )
            }
          })
          .catch((error) => {
            console.warn(`[${logLabel}] group="${group.name}" context handoff failed:`, error)
          })
          .finally(() => {
            handoffInFlight.delete(probeThread.id)
          })
      }
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
      if (!hasPendingImageDescription(entry) && !hasGroupProbeVisibleContent(entry)) {
        return
      }
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
