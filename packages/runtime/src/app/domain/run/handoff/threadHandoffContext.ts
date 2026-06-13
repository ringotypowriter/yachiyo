import type { StopCondition, ToolSet } from 'ai'

import type {
  MessageRecord,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord
} from '@yachiyo/shared/protocol'
import { normalizeEnabledTools } from '@yachiyo/shared/protocol'
import { isModelImageCapable } from '@yachiyo/shared/providerConfig'
import { resolveRunModeEnabledTools } from '@yachiyo/shared/toolModes'
import { resolveYachiyoUserPath } from '../../../../config/paths.ts'
import { createAgentToolSet, ReadRecordCache } from '../../../../tools/agentTools.ts'
import {
  prepareServerRunContext,
  type PreparedServerRunContext
} from '../context/prepareServerRunContext.ts'
import type { RunDomainDeps } from '../runTypes.ts'
import {
  disableHandoffToolExecution,
  findLatestUserTurnContext,
  HANDOFF_MAX_REFUSED_TOOL_STEPS
} from './handoffTools.ts'

export interface PreparedThreadHandoffContext {
  preparedContext: PreparedServerRunContext
  tools: ToolSet | undefined
  stopWhen: StopCondition<ToolSet> | undefined
  onToolCallError: (() => 'continue') | undefined
  didRefuseToolExecution: () => boolean
}

export async function prepareThreadHandoffContext(input: {
  deps: RunDomainDeps
  sourceThread: ThreadRecord
  sourceMessages: MessageRecord[]
  requestContent: string
  runId: string
  settings: ProviderSettings
  config: SettingsConfig
  abortController: AbortController
}): Promise<PreparedThreadHandoffContext> {
  const { config, deps, settings, sourceMessages, sourceThread } = input
  const sourceTurnContext = findLatestUserTurnContext(sourceMessages)
  const handoffRequestId = deps.createId()
  const handoffRequestMessage: MessageRecord = {
    id: handoffRequestId,
    threadId: sourceThread.id,
    role: 'user',
    content: input.requestContent,
    status: 'completed',
    createdAt: deps.timestamp()
  }
  const storedSourceRunMode = sourceTurnContext?.runMode ?? sourceThread.runMode ?? 'auto'
  const sourceRunMode = storedSourceRunMode === 'custom' ? 'auto' : storedSourceRunMode
  const sourceEnabledTools = sourceTurnContext?.enabledTools
    ? normalizeEnabledTools(sourceTurnContext.enabledTools, [])
    : resolveRunModeEnabledTools(sourceRunMode)
  const preparedContext = await prepareServerRunContext(
    {
      storage: deps.storage,
      createId: deps.createId,
      timestamp: deps.timestamp,
      emit: deps.emit,
      createModelRuntime: deps.createModelRuntime,
      ensureThreadWorkspace: deps.ensureThreadWorkspace,
      fetchImpl: deps.fetchImpl,
      webExternalFetchImpl: deps.webExternalFetchImpl,
      loadBrowserSnapshot: deps.loadBrowserSnapshot,
      memoryService: deps.memoryService,
      searchService: deps.searchService,
      webSearchService: deps.webSearchService,
      readSoulDocument: deps.readSoulDocument,
      readUserDocument: deps.readUserDocument,
      readThread: deps.requireThread,
      readConfig: deps.readConfig,
      readSettings: () => settings,
      loadThreadMessages: deps.loadThreadMessages,
      loadThreadToolCalls: deps.loadThreadToolCalls,
      listSkills: deps.listSkills,
      onEnabledToolsUsed: () => undefined,
      jotdownStore: deps.jotdownStore,
      imageToTextService: deps.imageToTextService,
      isModelImageCapable: isModelImageCapable(config, settings.providerName, settings.model)
    },
    {
      runId: input.runId,
      thread: sourceThread,
      requestMessageId: handoffRequestId,
      requestMessage: handoffRequestMessage,
      historyMessages: [...sourceMessages, handoffRequestMessage],
      enabledTools: sourceEnabledTools,
      runMode: sourceRunMode,
      runTrigger: 'local',
      ...(sourceTurnContext?.enabledSkillNames !== undefined
        ? { enabledSkillNames: sourceTurnContext.enabledSkillNames }
        : {}),
      abortController: input.abortController,
      persistTurnContext: false,
      persistImageReplayMarkers: false,
      emitContextEvents: false,
      includeMemoryRecall: false,
      applyStripCompact: false
    }
  )
  const tools = disableHandoffToolExecution(
    createAgentToolSet(
      {
        enabledTools: preparedContext.modelEnabledTools,
        workspacePath: preparedContext.workspacePath,
        sandboxed: preparedContext.isExternalChannel && !preparedContext.isOwnerDm,
        readRecordCache: new ReadRecordCache(),
        imageToTextService: deps.imageToTextService,
        isModelImageCapable: isModelImageCapable(config, settings.providerName, settings.model)
      },
      {
        availableSkills: preparedContext.availableSkills,
        fetchImpl: deps.webExternalFetchImpl ?? deps.fetchImpl,
        loadBrowserSnapshot: deps.loadBrowserSnapshot,
        searchService: deps.searchService,
        memoryService: sourceThread.privacyMode ? undefined : deps.memoryService,
        webSearchService: deps.webSearchService,
        updateProfileDeps: {
          userDocumentPath: preparedContext.isGuest
            ? resolveYachiyoUserPath(preparedContext.workspacePath)
            : resolveYachiyoUserPath(),
          ...(preparedContext.isExternalChannel
            ? {
                userDocumentMode: preparedContext.isGuest ? ('guest' as const) : ('owner' as const)
              }
            : {})
        },
        ...(!sourceThread.privacyMode &&
        (!preparedContext.isExternalChannel || preparedContext.isOwnerDm) &&
        deps.memoryService.isConfigured()
          ? { rememberDeps: { memoryService: deps.memoryService } }
          : {}),
        ...(!sourceThread.privacyMode &&
        (!preparedContext.isExternalChannel || preparedContext.isOwnerDm)
          ? {
              activityOcrEnabled: config.general?.activityTracking?.ocr?.enabled === true,
              sourceQueryExecutor: deps.sourceQueryExecutor,
              sourceQueryStorage: deps.storage
            }
          : {}),
        ...(preparedContext.isLocalRunTrigger
          ? {
              askUserContext: {
                waitForUserAnswer: async () => {
                  throw new Error('Tool execution is disabled during handoff creation.')
                }
              }
            }
          : {}),
        ...((preparedContext.subagentsConfig.mode === 'worker' &&
          preparedContext.subagentsConfig.enabledNamedAgents.length > 0) ||
        ((preparedContext.gitCtx.hasGit || preparedContext.gitValidatedWorkspaces.length > 0) &&
          preparedContext.subagentsConfig.mode === 'acp' &&
          preparedContext.enabledSubagentProfiles.length > 0)
          ? {
              subagentProfiles: preparedContext.enabledSubagentProfiles,
              subagentsConfig: preparedContext.subagentsConfig,
              availableWorkspaces: preparedContext.subagentAvailableWorkspaces,
              settings,
              config,
              createModelRuntime: deps.createModelRuntime
            }
          : {})
      }
    )
  )

  let refusedToolExecution = false
  let refusalCount = 0
  let observedRefusalCount = 0
  let refusalSteps = 0
  const stopAfterRepeatedToolRefusal: StopCondition<ToolSet> = () => {
    if (refusalCount === observedRefusalCount) {
      return false
    }

    observedRefusalCount = refusalCount
    refusalSteps += 1
    return refusalSteps >= HANDOFF_MAX_REFUSED_TOOL_STEPS
  }

  return {
    preparedContext,
    tools,
    stopWhen: tools ? stopAfterRepeatedToolRefusal : undefined,
    onToolCallError: tools
      ? () => {
          refusedToolExecution = true
          refusalCount += 1
          return 'continue' as const
        }
      : undefined,
    didRefuseToolExecution: () => refusedToolExecution
  }
}
