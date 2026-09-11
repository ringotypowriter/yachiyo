import { join } from 'node:path'

import { tool } from 'ai'
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
import type { ModelMessage } from '../../runtime/models/types.ts'
import { readUserDocument } from '../../runtime/profiles/user.ts'
import { createTool as createReadTool } from '../../tools/agentTools/readTool.ts'
import { createTool as createUpdateProfileTool } from '../../tools/agentTools/updateProfileTool.ts'
import { createTool as createWebReadTool } from '../../tools/agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from '../../tools/agentTools/webSearchTool.ts'
import type { ChannelPolicy } from '../shared/channelPolicy.ts'
import { ChannelMessageTooLongError } from '../shared/sendWithUpdateReceipt.ts'
import {
  buildGroupProbeBehaviorPrompt,
  buildGroupProbeContextPrompt,
  formatGroupProbeTurnDelta
} from './groupContextBuilder.ts'
import { GROUP_PERSONA_PROMPT } from './groupPrompts.ts'
import { prepareGroupReplyForDelivery } from './groupReplyContent.ts'
import {
  extractFinalGroupReply,
  runGroupReplyTurn,
  type GroupReplyGeneration,
  type GroupReplyDelivery
} from './groupReplyTurn.ts'
import { describeGroupImages } from './groupImageDescriptions.ts'
import { hasGroupProbeVisibleContent, hasPendingGroupContent } from './groupMessageReadiness.ts'
import { createGroupMonitorRegistry, type GroupMonitorPersistence } from './groupMonitorRegistry.ts'
import {
  loadGroupProbeHistory,
  persistSuccessfulGroupProbeTurn,
  resolveGroupProbeThread
} from './groupProbeThread.ts'
import { runClaudeCodeGroupProbe } from './groupProbeClaudeCode.ts'
import { rewriteGroupReply } from './groupReplyRewrite.ts'
import { summarizeGroupProbeContext } from './groupProbeHandoff.ts'

export interface ChannelGroupDiscussionServiceOptions {
  platform: ChannelPlatform
  logLabel: string
  server: YachiyoServer
  policy: ChannelPolicy
  groupConfig?: GroupChannelConfig
  groupCheckIntervalMs?: number
  sendMessage(group: ChannelGroupRecord, message: string): Promise<void>
}

export interface ChannelGroupDiscussionService {
  setPreferences(config: Pick<GroupChannelConfig, 'mode' | 'reasoningEffort'>): void
  routeMessage(
    groupId: string,
    entry: GroupMessageEntry,
    enrich?: () => Promise<Pick<GroupMessageEntry, 'text' | 'images'>>
  ): void
  onGroupStatusChange(group: ChannelGroupRecord): void
  stop(): void
  clearGroupMessages(groupId: string): void
}

export async function runGroupProbeHeadlessAdapter(input: {
  adapter: GroupProbeHeadlessAdapterConfig
  group: ChannelGroupRecord
  messages: ModelMessage[]
  runClaudeCodeProbe?: typeof runClaudeCodeGroupProbe
}): Promise<GroupReplyGeneration> {
  const probe = await (input.runClaudeCodeProbe ?? runClaudeCodeGroupProbe)({
    messages: input.messages,
    workspacePath: input.group.workspacePath,
    providerName: input.adapter.providerName,
    model: input.adapter.model
  })
  return {
    result: probe.auxiliaryResult,
    reply:
      probe.status === 'success' && probe.decision.action === 'send' ? probe.decision.message : null
  }
}

export async function sendGroupReplyWithRewriteFallback(input: {
  original: string
  rewritten: string
  send: (message: string) => Promise<void>
}): Promise<string> {
  try {
    await input.send(input.rewritten)
    return input.rewritten
  } catch (error) {
    if (input.rewritten === input.original || !(error instanceof ChannelMessageTooLongError)) {
      throw error
    }

    await input.send(input.original)
    return input.original
  }
}

export function createChannelGroupDiscussionService(
  options: ChannelGroupDiscussionServiceOptions
): ChannelGroupDiscussionService {
  const { platform, logLabel, server, policy, groupConfig, groupCheckIntervalMs, sendMessage } =
    options
  let mode = groupConfig?.mode ?? 'probe'
  let reasoningEffort = groupConfig?.reasoningEffort

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
    const turnEffort = reasoningEffort
    const freshMessages = recentMessages.slice(-freshCount)
    await Promise.all(
      recentMessages.map(async (entry) => {
        if (!entry.imageDescriptionDeferred) return
        if (entry.images?.length) {
          await describeGroupImages({ server, text: entry.text, images: entry.images, logLabel })
        }
        entry.imageDescriptionDeferred = false
      })
    )
    freshCount = freshMessages.filter(hasGroupProbeVisibleContent).length
    if (!freshCount) return false
    const auxService = server.getAuxiliaryGenerationService()
    let didSpeak = false

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

    async function attemptSendGroupMessage(message: string): Promise<GroupReplyDelivery> {
      const preparedMessage = prepareGroupReplyForDelivery(message)
      if (preparedMessage === null) {
        console.log(`[${logLabel}] rejected empty message for "${group.name}"`)
        return {}
      }

      let outgoing = preparedMessage
      if (rewriteSettings) {
        const rewritten = await rewriteGroupReply({
          auxService,
          message: preparedMessage,
          settingsOverride: rewriteSettings
        })
        if (rewritten && rewritten !== preparedMessage) {
          console.log(
            `[${logLabel}] voice pass for "${group.name}": ${preparedMessage.slice(0, 80)} -> ${rewritten.slice(0, 80)}`
          )
          outgoing = rewritten
        }
      }

      try {
        outgoing = await sendGroupReplyWithRewriteFallback({
          original: preparedMessage,
          rewritten: outgoing,
          send: (message) => sendMessage(group, message)
        })
      } catch (err) {
        if (err instanceof ChannelMessageTooLongError) {
          console.log(
            `[${logLabel}] rejected over-limit message for "${group.name}": ${err.actualLength} > ${err.maxLength}`
          )
          return {
            retry: `Message not sent. After required delivery text, your reply can use at most ${err.availableTextLength} characters in this ${platform} group message. Return one complete final reply within that limit.`
          }
        }

        console.error(`[${logLabel}] failed to send message to "${group.name}"`, err)
        return {}
      }

      console.log(`[${logLabel}] sent reply to "${group.name}": ${outgoing.slice(0, 100)}`)
      groupRegistry.routeMessage(group.id, {
        senderName: 'Yachiyo',
        senderExternalUserId: '__self__',
        isMention: false,
        text: outgoing,
        timestamp: Date.now() / 1_000
      })

      didSpeak = true
      return { sentText: outgoing }
    }

    const userDocPath = join(group.workspacePath, YACHIYO_USER_FILE_NAME)
    const groupUserDoc = await readUserDocument({
      filePath: userDocPath,
      mode: 'group'
    })

    const toolContext = { workspacePath: group.workspacePath, sandboxed: true }
    const probeTools = {
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
    const contextTimeZone = server.getContextTimeZone()
    const headlessAdapter = resolveGroupProbeHeadlessAdapter(
      channelsConfig.groupProbeAdapter,
      groupConfig?.model
    )
    const stableSystemPrompt = buildGroupProbeBehaviorPrompt()
    const dynamicSystemPrompt = buildGroupProbeContextPrompt({
      botName: 'Yachiyo',
      groupName: group.name,
      groupLabel: group.label || undefined,
      personaPrompt: GROUP_PERSONA_PROMPT,
      ownerInstruction: channelsConfig.guestInstruction,
      contextTimeZone
    })
    const turnSystemPrompt =
      mode === 'mention'
        ? `${dynamicSystemPrompt}\n\n这次有人直接 @ 你，是把话递给你，而不是让你寻找插话机会。以当前新消息中叫到你的话为回应对象，其他群聊记录用于理解背景。通常自然接住这句话：问候可以简短回应，问题直接回答，意思不清楚时可以问一句，不必等到有新信息或完整答案才开口。明确让你不用回复、同一请求已经回应过，或上下文确实表明不宜继续时，也可以安静。`
        : dynamicSystemPrompt
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
      probeThreadCreated ? undefined : freshCount,
      contextTimeZone
    )
    const messages = compileGroupProbeContextLayers({
      stableSystemPrompt,
      dynamicSystemPrompt: turnSystemPrompt,
      groupProfile: groupUserDoc?.content,
      contextHandoffSummary: probeThread.contextHandoffSummary,
      history: loadGroupProbeHistory(server.getStorage(), probeThread),
      currentTurnContent,
      historyTokenBudget: policy.groupContextTokenLimit,
      anthropicCacheBreakpoints: !headlessAdapter
    })

    let handoffSettingsOverride: ProviderSettings | undefined
    console.log(
      `[${logLabel}] group="${group.name}" probing ${freshCount}/${recentMessages.length} fresh message(s):\n${currentTurnContent}`
    )
    const { result, previousResult, sentText } = await runGroupReplyTurn({
      messages,
      send: attemptSendGroupMessage,
      generate: async (turnMessages, staySilent) => {
        if (headlessAdapter) {
          return runGroupProbeHeadlessAdapter({
            adapter: headlessAdapter,
            group,
            messages: turnMessages
          })
        }
        const settingsOverride = server.resolveProviderSettings(groupConfig?.model)
        handoffSettingsOverride = settingsOverride
        const result = await auxService.generateText({
          reasoningEffort: turnEffort,
          messages: turnMessages,
          promptCacheKey: probeThread.id,
          tools: {
            ...probeTools,
            staySilent: tool({
              description:
                '选择这一轮不向群里发消息。适合让当前对话自然继续，或对方明确不需要回复的场合。',
              inputSchema: z.object({}),
              execute: async () => {
                staySilent()
                return 'No group message will be sent this turn.'
              }
            })
          },
          settingsOverride,
          purpose: `${logLabel}-probe`
        })
        return { result, reply: extractFinalGroupReply(result) }
      }
    })

    // A failed correction must not erase the completed first generation's usage.
    const completedResult = result.status === 'success' ? result : previousResult
    if (completedResult) {
      persistSuccessfulGroupProbeTurn({
        storage: server.getStorage(),
        generateId: () => server.generateId(),
        thread: probeThread,
        requestContent: currentTurnContent,
        result: completedResult,
        sentText
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
          promptTokens: completedResult.usage?.initialPromptTokens,
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
    }
    if (result.status === 'success') {
      console.log(
        `[${logLabel}] group="${group.name}" generation: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`
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
    setPreferences(config) {
      mode = config.mode ?? 'probe'
      reasoningEffort = config.reasoningEffort
      groupRegistry.setMode(mode)
    },
    routeMessage(groupId, entry, enrich) {
      if (!groupRegistry.hasMonitor(groupId)) return
      if (enrich) entry.enrichmentPending = true
      if (entry.enrichmentPending || entry.images?.some((image) => !image.altText?.trim())) {
        entry.imageDescriptionDeferred = true
      }
      if (!hasPendingGroupContent(entry) && !hasGroupProbeVisibleContent(entry)) {
        return
      }
      groupRegistry.routeMessage(groupId, entry)
      if (enrich) {
        void enrich()
          .then(async (content) => {
            Object.assign(entry, content)
            if (mode === 'probe' && entry.images?.length) {
              await describeGroupImages({
                server,
                text: entry.text,
                images: entry.images,
                logLabel
              })
            }
          })
          .catch((error) => console.warn(`[${logLabel}] message enrichment failed:`, error))
          .finally(() => {
            entry.enrichmentPending = false
          })
      }
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
    }
  }
}
