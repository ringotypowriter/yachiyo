import { access, constants, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import type {
  ComposerReasoningSelection,
  MessageRecord,
  MessageTurnContext,
  RecallDecisionSnapshot,
  RunContextCompiledEvent,
  RunModeId,
  RunMemoryRecalledEvent,
  SendChatRunTrigger,
  SettingsConfig,
  SkillCatalogEntry,
  SkillSummary,
  SubagentProfile,
  ThreadRecord,
  ToolCallName
} from '../../../../../../shared/yachiyo/protocol.ts'
import { getActivityTracker } from '../../../../activity/ActivityTracker.ts'
import { resolveYachiyoUserPath } from '../../../../config/paths.ts'
import {
  buildExternalAgentInstructions,
  compileExternalContextLayers
} from '../../../../runtime/context/externalContextLayers.ts'
import {
  buildHiddenReferenceBlock,
  resolveFileMentionsForUserQuery
} from '../../../../runtime/files/fileMentions.ts'
import { prepareModelMessages } from '../../../../runtime/messages/messagePrepare.ts'
import { EXTERNAL_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../../../runtime/context/prompt.ts'
import {
  buildCurrentTimeSection,
  buildDisabledToolsReminderSection,
  buildRunModeChangedReminderSection,
  buildWorkspaceChangedReminderSection,
  buildToolAvailabilityReminderSection,
  buildSteerReminderSection,
  formatDateLine,
  formatQueryReminder
} from '../../../../runtime/context/queryReminder.ts'
import { readChannelsConfig } from '../../../../runtime/config/channelsConfig.ts'
import { buildPlanModeReminderSection, ensurePlanDocument } from '../plan/planModeContext.ts'
import { preprocessImagesForNonVisionModel } from '../../../../runtime/context/contextLayers.ts'
import { applyStripCompact } from '../../../../runtime/context/contextStripCompact.ts'
import type { ModelMessage } from '../../../../runtime/models/types.ts'
import { readSoulDocument, type SoulDocument } from '../../../../runtime/profiles/soul.ts'
import { readUserDocument, type UserDocument } from '../../../../runtime/profiles/user.ts'
import { rewriteRelativeMarkdownLinks } from '../../../../services/skills/skillContent.ts'
import { resolveActiveSkills } from '../../../../services/skills/skillResolver.ts'
import { resolveEnabledTools } from '../../config/configDomain.ts'
import { buildRecoveryHistory } from '../runRecovery.ts'
import {
  buildAgentInstructions,
  buildSubagentContextBlock,
  resolveModelEnabledTools
} from './agentInstructions.ts'
import { buildContextSources } from './contextSources.ts'
import { detectGitContext, type GitContext } from './gitContext.ts'
import { loadRunHistory, toRunHistoryMessages, type RunHistoryMessage } from './runHistory.ts'
import { DEFAULT_MAX_TOOL_STEPS } from '../execution/runExecutionConstants.ts'
import { getPreviousRunActualPromptTokens } from '../execution/runUsage.ts'
import type { ExecuteRunInput, RunExecutionDeps } from '../execution/runExecutionTypes.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'

const MEMORY_RECALL_TIMEOUT_MS = 15_000
const EXTERNAL_CHANNEL_MAX_TOOL_STEPS = 10

async function ensureResolvedWorkspacePath(
  thread: ThreadRecord,
  ensureThreadWorkspace: (threadId: string) => Promise<string>
): Promise<string> {
  try {
    if (!thread.workspacePath?.trim()) {
      return await ensureThreadWorkspace(thread.id)
    }

    const workspacePath = resolve(thread.workspacePath)
    await mkdir(workspacePath, { recursive: true })
    return workspacePath
  } catch (cause) {
    // Fatal by type - any error that is not a RetryableRunError is treated
    // as non-retryable by runExecution's catch block. No ad-hoc tagging.
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : ''
    throw new Error(`Workspace initialization failed${detail}`, { cause })
  }
}

const SKILL_MENTION_RE = /^@skills:([a-zA-Z0-9_-]+)(\s|$)/

async function expandSkillMention(
  content: string,
  listSkills: RunExecutionDeps['listSkills'],
  workspacePaths: string[]
): Promise<string> {
  const match = SKILL_MENTION_RE.exec(content)
  if (!match) return content

  const skillName = match[1]
  const skills = await listSkills(workspacePaths)
  const skill = skills.find((s) => s.name === skillName)
  if (!skill) return content

  const rawSkillContent = await readFile(skill.skillFilePath, 'utf8').catch(() => '')
  const skillContent = rewriteRelativeMarkdownLinks(rawSkillContent, skill.directoryPath)
  const lines: string[] = [
    `Skill: ${skill.name}`,
    ...(skill.description ? [`Description: ${skill.description}`] : []),
    '',
    skillContent.trim()
  ]
  const replacement = lines.join('\n').trim()
  const remainder = content.slice(match[0].length)
  return remainder ? `${replacement}\n\n${remainder}` : replacement
}

export interface PreparedServerRunContext {
  workspacePath: string
  config: SettingsConfig
  messages: ModelMessage[]
  modelEnabledTools: ToolCallName[]
  maxToolSteps: number
  planModeDocument?: {
    planRelativePath: string
    planAbsolutePath: string
    fallbackAbsolutePaths: string[]
  }
  availableSkills: SkillCatalogEntry[]
  activeSkills: SkillSummary[]
  soulDocument: SoulDocument | null
  userDocument: UserDocument | null
  isExternalChannel: boolean
  isGuest: boolean
  isOwnerDm: boolean
  isLocalRunTrigger: boolean
  hiddenQueryReminder?: string
  memoryEntries: string[]
  recallDecision?: RecallDecisionSnapshot
  fileMentionCount: number
  inlinedFileCount: number
  enabledSubagentProfiles: SubagentProfile[]
  gitCtx: GitContext
  gitValidatedWorkspaces: string[]
  runMode: RunModeId
}

export interface PrepareServerRunContextInput {
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  channelHint?: string
  abortController: AbortController
  recoveryCheckpoint?: RunRecoveryCheckpoint
  isSteerLeg?: boolean
  previousEnabledTools?: ToolCallName[] | null
  previousRunMode?: RunModeId | null
  runMode: RunModeId
  priorUsage?: ExecuteRunInput['priorUsage']
  maxToolStepsOverride?: number
  requestMessage?: MessageRecord
  historyMessages?: MessageRecord[]
  persistTurnContext?: boolean
  emitContextEvents?: boolean
  includeMemoryRecall?: boolean
  applyStripCompact?: boolean
  persistImageReplayMarkers?: boolean
}

export async function prepareServerRunContext(
  deps: RunExecutionDeps,
  input: PrepareServerRunContextInput
): Promise<PreparedServerRunContext> {
  const settings = deps.readSettings()
  const workspacePath = await ensureResolvedWorkspacePath(input.thread, deps.ensureThreadWorkspace)
  const availableSkills = await deps.listSkills([workspacePath])
  const activeSkills = resolveActiveSkills({
    availableSkills,
    config: deps.readConfig(),
    ...(input.enabledSkillNames !== undefined ? { enabledSkillNames: input.enabledSkillNames } : {})
  })
  const soulDocument = deps.readSoulDocument
    ? await deps.readSoulDocument()
    : await readSoulDocument()
  const isExternalChannel = input.thread.source != null && input.thread.source !== 'local'
  const channelUser = input.thread.channelUserId
    ? deps.storage.getChannelUser(input.thread.channelUserId)
    : undefined
  const isGuest = isExternalChannel && (channelUser?.role ?? 'guest') !== 'owner'
  const isOwnerDm = channelUser?.role === 'owner' && !input.thread.channelGroupId
  const isLocalRunTrigger = input.runTrigger === 'local'
  if (isExternalChannel || isOwnerDm) {
    console.log(
      `[yachiyo] external channel run: user=${channelUser?.username ?? 'unknown'}, role=${channelUser?.role ?? 'guest'}, isGuest=${isGuest}, isOwnerDm=${isOwnerDm}`
    )
  }
  const maxToolSteps =
    input.maxToolStepsOverride ??
    (isExternalChannel && !isOwnerDm ? EXTERNAL_CHANNEL_MAX_TOOL_STEPS : DEFAULT_MAX_TOOL_STEPS)
  const modelEnabledTools = resolveModelEnabledTools({
    activeSkills,
    enabledTools: isOwnerDm
      ? resolveEnabledTools(undefined, deps.readConfig().enabledTools)
      : input.enabledTools
  })
  const guestUserPath = resolveYachiyoUserPath(workspacePath)
  const userDocument = isGuest
    ? await readUserDocument({ filePath: guestUserPath, guest: true })
    : deps.readUserDocument
      ? await deps.readUserDocument()
      : await readUserDocument()
  const isLocalOrOwnerDm = !isExternalChannel || isOwnerDm
  const requestMessage =
    input.requestMessage ??
    deps
      .loadThreadMessages(input.thread.id)
      .find((message) => message.id === input.requestMessageId && message.role === 'user')
  const requestIsHidden = requestMessage?.hidden === true

  const planModeDocument =
    input.runMode === 'plan' && requestMessage
      ? await ensurePlanDocument({
          workspacePath,
          threadId: input.thread.id,
          goal: requestMessage.content
        })
      : null

  const now = new Date()
  // Freeze the hint-layer timestamp to the request message's creation time so
  // retries and multi-step continuations produce byte-identical reminder text,
  // keeping the cached prefix stable within a turn.
  const hintTime = requestMessage?.createdAt ? new Date(requestMessage.createdAt) : now
  const isSteerLeg = input.isSteerLeg === true || input.priorUsage != null
  const isVisibleSteerLeg = isSteerLeg && !requestIsHidden
  const previousWorkspacePath = deps.storage
    .listThreadRuns(input.thread.id)
    .filter((run) => run.id !== input.runId && run.workspacePath)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.workspacePath
  const hiddenQueryReminder = formatQueryReminder(
    [
      input.previousEnabledTools
        ? buildToolAvailabilityReminderSection({
            previousEnabledTools: input.previousEnabledTools,
            enabledTools: modelEnabledTools
          })
        : null,
      input.previousRunMode
        ? buildRunModeChangedReminderSection({
            previousRunMode: input.previousRunMode,
            runMode: input.runMode
          })
        : null,
      previousWorkspacePath
        ? buildWorkspaceChangedReminderSection({
            previousWorkspacePath,
            workspacePath
          })
        : null,
      buildDisabledToolsReminderSection({ enabledTools: modelEnabledTools }),
      buildCurrentTimeSection(hintTime, { includeDate: !isLocalOrOwnerDm }),
      planModeDocument ? buildPlanModeReminderSection(planModeDocument) : null,
      isVisibleSteerLeg ? buildSteerReminderSection() : null
    ].flatMap((section) => (section ? [section] : []))
  )
  const sessionHint = input.thread.lastDelegatedSession
    ? `Hint: The most recent delegated coding task (Agent: ${input.thread.lastDelegatedSession.agentName}) used session_id ${input.thread.lastDelegatedSession.sessionId} in workspace ${input.thread.lastDelegatedSession.workspacePath}. If the user asks to resume or continue that task, you must provide this exact session_id and set workspace to ${input.thread.lastDelegatedSession.workspacePath} in the delegateCodingTask tool.`
    : undefined
  const effectiveReminder =
    [hiddenQueryReminder, sessionHint].filter(Boolean).join('\n\n') || undefined
  const fileMentionResolution = await resolveFileMentionsForUserQuery({
    content: requestMessage?.content ?? '',
    workspacePath,
    searchService: deps.searchService
  })

  let hasInlinedJotdown = false
  const jotdownMentions = fileMentionResolution.mentions.filter(
    (m) => m.query.toLowerCase() === 'jotdown'
  )
  if (jotdownMentions.length > 0 && deps.jotdownStore) {
    const latest = await deps.jotdownStore.getLatest()
    if (latest) {
      hasInlinedJotdown = true
      for (const mention of jotdownMentions) {
        mention.kind = 'resolved'
        mention.resolvedPath = 'JotDown'
        mention.resolvedKind = 'file'
        mention.candidatePaths = ['JotDown']
      }
      const home = homedir()
      const jotdownPath = deps.jotdownStore.baseDir.startsWith(home)
        ? join('~', relative(home, deps.jotdownStore.baseDir), `${latest.id}.md`)
        : 'JotDown'
      fileMentionResolution.augmentedUserQuery = [
        buildHiddenReferenceBlock({
          mentions: fileMentionResolution.mentions,
          inlinedReference: {
            tagName: 'referenced_jotdown',
            path: jotdownPath,
            content: latest.content.trimEnd()
          }
        }),
        '',
        requestMessage?.content ?? ''
      ].join('\n')
    }
  }

  const config = deps.readConfig()
  let memoryEntries: string[] = []
  let recallDecision: RecallDecisionSnapshot | undefined
  if (
    input.includeMemoryRecall !== false &&
    config.memory?.autoRecall !== false &&
    deps.buildMemoryLayerEntries &&
    !isGuest &&
    !isSteerLeg
  ) {
    try {
      const result = await deps.buildMemoryLayerEntries({
        requestMessageId: input.requestMessageId,
        signal: AbortSignal.any([
          input.abortController.signal,
          AbortSignal.timeout(MEMORY_RECALL_TIMEOUT_MS)
        ]),
        thread: input.thread,
        userQuery: requestMessage?.content ?? ''
      })
      memoryEntries = result.entries
      recallDecision = result.recallDecision
    } catch (error) {
      if (input.abortController.signal.aborted) {
        throw error
      }
      console.warn('[yachiyo][memory] failed to build memory layer; continuing run', {
        error: error instanceof Error ? error.message : String(error),
        runId: input.runId,
        threadId: input.thread.id
      })
    }
  }
  if (input.emitContextEvents !== false) {
    deps.emit<RunMemoryRecalledEvent>({
      type: 'run.memory.recalled',
      threadId: input.thread.id,
      runId: input.runId,
      requestMessageId: input.requestMessageId,
      recalledMemoryEntries: memoryEntries,
      ...(recallDecision ? { recallDecision } : {})
    })
  }

  const enabledSubagentProfiles = (config.subagentProfiles ?? []).filter((p) => p.enabled)
  const savedWorkspacePaths = config.workspace?.savedPaths ?? []
  const gitCtx =
    enabledSubagentProfiles.length > 0
      ? await detectGitContext(workspacePath)
      : ({ hasGit: false } as GitContext)
  const gitValidatedWorkspaces =
    enabledSubagentProfiles.length > 0 && savedWorkspacePaths.length > 0
      ? (
          await Promise.all(
            savedWorkspacePaths.map(async (p) => {
              const hasGit = await access(join(resolve(p), '.git'), constants.F_OK)
                .then(() => true)
                .catch(() => false)
              return hasGit ? p : null
            })
          )
        ).filter((p): p is string => p !== null)
      : []
  const subagentContextBlock = buildSubagentContextBlock(
    gitCtx,
    workspacePath,
    enabledSubagentProfiles,
    gitValidatedWorkspaces
  )

  // Fetch activity summary - only for local / owner-DM runs, never for guests.
  const shouldIncludeActivity = (!isExternalChannel || isOwnerDm) && !requestIsHidden
  const activitySummary = shouldIncludeActivity
    ? (deps.activityTracker ?? getActivityTracker('simple')).finalizeAndConsume()
    : null
  const activityText = activitySummary?.text

  if (activitySummary && input.persistTurnContext !== false) {
    deps.storage.saveActivitySourceRecord({
      id: deps.createId(),
      threadId: input.thread.id,
      runId: input.runId,
      requestMessageId: input.requestMessageId,
      startedAt: activitySummary.startedAt,
      endedAt: activitySummary.endedAt,
      totalDurationMs: activitySummary.totalDurationMs,
      uniqueApps: activitySummary.uniqueApps,
      ...(activitySummary.afkDurationMs !== undefined
        ? { afkDurationMs: activitySummary.afkDurationMs }
        : {}),
      summaryText: activitySummary.text,
      entries: activitySummary.entries,
      ...(activitySummary.snapshots ? { snapshots: activitySummary.snapshots } : {}),
      createdAt: deps.timestamp()
    })
  }

  if (input.persistTurnContext !== false && requestMessage) {
    const turnContext: MessageTurnContext = {
      ...requestMessage.turnContext,
      ...(hiddenQueryReminder ? { reminder: hiddenQueryReminder } : {}),
      ...(memoryEntries.length > 0 ? { memoryEntries } : {}),
      ...(activityText ? { activityText } : {}),
      enabledTools: [...input.enabledTools],
      enabledSkillNames: activeSkills.map((skill) => skill.name),
      runMode: input.runMode
    }
    deps.storage.updateMessage({ ...requestMessage, turnContext })
  }

  const rawContent = requestMessage?.content ?? ''
  const skillExpandedContent = await expandSkillMention(rawContent, deps.listSkills, [
    workspacePath
  ])
  const augmentedUserQuery = fileMentionResolution.augmentedUserQuery
  const hasSkillExpansion = skillExpandedContent !== rawContent
  const modelUserQuery = hasSkillExpansion
    ? augmentedUserQuery.slice(0, augmentedUserQuery.length - rawContent.length) +
      skillExpandedContent
    : augmentedUserQuery

  const history =
    input.historyMessages !== undefined
      ? toRunHistoryMessages(input.historyMessages, input.requestMessageId, modelUserQuery)
      : loadRunHistory(
          deps.loadThreadMessages,
          deps.storage,
          input.thread.id,
          input.requestMessageId,
          modelUserQuery,
          input.thread.summaryWatermarkMessageId
        )
  const recoveredToolCalls = input.recoveryCheckpoint
    ? deps.loadThreadToolCalls(input.thread.id).filter((toolCall) => toolCall.runId === input.runId)
    : []
  const recoveryHistory = input.recoveryCheckpoint
    ? buildRecoveryHistory({
        checkpoint: input.recoveryCheckpoint,
        toolCalls: recoveredToolCalls
      })
    : []
  let contextHistory = [...history, ...recoveryHistory]

  if (deps.isModelImageCapable === false && deps.imageToTextService) {
    contextHistory = await preprocessImagesForNonVisionModel(
      contextHistory,
      deps.imageToTextService
    )
    if (input.persistImageReplayMarkers !== false) {
      persistI2TDescriptions(deps, input.thread.id, history, contextHistory)
    }
  }

  const messages =
    isExternalChannel && !isOwnerDm
      ? compileExternalContextLayers({
          personality: { basePersona: EXTERNAL_SYSTEM_PROMPT },
          soul: { content: soulDocument?.rawContent ?? '' },
          user: { content: userDocument?.content ?? '' },
          executionContract: buildExternalAgentInstructions({
            enabledTools: modelEnabledTools,
            guest: isGuest,
            guestInstruction: isGuest ? readChannelsConfig().guestInstruction : undefined
          }),
          channelInstruction: input.channelHint ?? '',
          rollingSummary: input.thread.rollingSummary,
          history: contextHistory,
          hint: { reminder: effectiveReminder },
          memory: { entries: memoryEntries }
        })
      : prepareModelMessages({
          personality: {
            basePersona: isLocalOrOwnerDm
              ? `Today is ${formatDateLine(now)}.\n\n${SYSTEM_PROMPT}`
              : SYSTEM_PROMPT
          },
          soul: { content: soulDocument?.rawContent ?? '' },
          user: { content: userDocument?.content ?? '' },
          skills: { activeSkills },
          agent: {
            instructions: [
              buildAgentInstructions({
                workspacePath,
                workspaceLabel: config.workspace?.pathLabels?.[workspacePath],
                enabledTools: modelEnabledTools,
                activeSkills,
                hasSourceQuery:
                  !input.thread.privacyMode &&
                  (!isExternalChannel ||
                    isOwnerDm ||
                    deps.memoryService.hasHiddenSearchCapability()),
                hasUpdateProfile: true,
                hasRemember:
                  !input.thread.privacyMode &&
                  (!isExternalChannel || isOwnerDm) &&
                  deps.memoryService.isConfigured(),
                hasTodoTool: isLocalRunTrigger,
                soulDocumentPath: soulDocument?.filePath,
                userDocumentPath: userDocument?.filePath,
                subagentContextBlock: subagentContextBlock || undefined,
                isUserSpecifiedWorkspace: !!input.thread.workspacePath?.trim()
              }),
              ...(isOwnerDm && input.channelHint?.trim() ? [input.channelHint.trim()] : []),
              ...(isLocalRunTrigger
                ? [
                    'Mermaid diagrams in ```mermaid code blocks are rendered as interactive diagrams in this conversation. Write Mermaid code directly — do not suggest the user open it in an external tool.'
                  ]
                : [])
            ].join('\n\n')
          },
          hint: {
            reminder: effectiveReminder
          },
          memory: { entries: memoryEntries },
          activityText,
          anthropicCacheBreakpoints: settings.provider === 'anthropic',
          history: input.thread.rollingSummary?.trim()
            ? [
                {
                  role: 'user' as const,
                  content: `<conversation_summary>\n${input.thread.rollingSummary.trim()}\n</conversation_summary>`
                },
                ...contextHistory
              ]
            : contextHistory
        })
  const stripCompactEnabled = config.chat?.stripCompact !== false
  const previousActualPromptTokens = getPreviousRunActualPromptTokens(
    deps.storage,
    deps.loadThreadMessages,
    input.thread.id,
    input.runId,
    input.requestMessageId
  )
  const finalMessages =
    input.applyStripCompact !== false && stripCompactEnabled
      ? applyStripCompact(
          messages,
          modelEnabledTools.length,
          previousActualPromptTokens,
          config.chat?.stripCompactThresholdTokens
        )
      : messages

  if (input.emitContextEvents !== false) {
    deps.emit<RunContextCompiledEvent>({
      type: 'run.context.compiled',
      threadId: input.thread.id,
      runId: input.runId,
      contextSources: buildContextSources({
        evolvedTraitCount: (soulDocument?.evolvedTraits ?? []).filter((t) => t.trim()).length,
        hasUserContent: (userDocument?.content ?? '').trim().length > 0,
        enabledTools: modelEnabledTools,
        activeSkills,
        fileMentionCount: fileMentionResolution.mentions.length,
        inlinedFileCount: (fileMentionResolution.inlinedPath ? 1 : 0) + (hasInlinedJotdown ? 1 : 0),
        workspacePath,
        hasToolReminder: hiddenQueryReminder !== undefined,
        memoryEntries,
        recallDecision,
        ...(activitySummary
          ? {
              activitySummary: {
                uniqueApps: activitySummary.uniqueApps,
                ...(activitySummary.afkDurationMs !== undefined
                  ? { afkDurationMs: activitySummary.afkDurationMs }
                  : {})
              }
            }
          : {})
      })
    })
  }

  return {
    workspacePath,
    config,
    messages: finalMessages,
    modelEnabledTools,
    maxToolSteps,
    availableSkills,
    activeSkills,
    soulDocument,
    userDocument,
    isExternalChannel,
    isGuest,
    isOwnerDm,
    isLocalRunTrigger,
    hiddenQueryReminder,
    ...(planModeDocument ? { planModeDocument } : {}),
    memoryEntries,
    ...(recallDecision ? { recallDecision } : {}),
    fileMentionCount: fileMentionResolution.mentions.length,
    inlinedFileCount: (fileMentionResolution.inlinedPath ? 1 : 0) + (hasInlinedJotdown ? 1 : 0),
    enabledSubagentProfiles,
    gitCtx,
    gitValidatedWorkspaces,
    runMode: input.runMode
  }
}

function persistI2TDescriptions(
  deps: Pick<RunExecutionDeps, 'storage' | 'loadThreadMessages'>,
  threadId: string,
  originalHistory: RunHistoryMessage[],
  processedHistory: { role: string; images?: { altText?: string; replayAsText?: boolean }[] }[]
): void {
  const storedMessages = new Map(deps.loadThreadMessages(threadId).map((m) => [m.id, m]))
  for (let i = 0; i < originalHistory.length; i++) {
    const original = originalHistory[i]
    const processed = processedHistory[i]
    if (original.role !== 'user' || !processed?.images?.length) continue
    const stored = storedMessages.get(original.id)
    if (!stored?.images) continue
    let needsUpdate = false
    const updatedImages = stored.images.map((storedImg, idx) => {
      const procImg = processed.images?.[idx]
      if (!procImg?.altText) return storedImg
      if (storedImg.altText === procImg.altText && storedImg.replayAsText === true) {
        return storedImg
      }
      if (procImg.replayAsText) {
        needsUpdate = true
        return { ...storedImg, altText: storedImg.altText ?? procImg.altText, replayAsText: true }
      }
      return storedImg
    })
    if (needsUpdate) {
      deps.storage.updateMessage({ ...stored, images: updatedImages })
    }
  }
}
