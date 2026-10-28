import { APP_RPC_METHODS } from '@yachiyo/shared/appServer/methods'
import type {
  AcceptThreadPlanDocumentInput,
  AnswerToolQuestionInput,
  ChannelsConfig,
  CompactThreadInput,
  ComposerReasoningSelection,
  CreateScheduleInput,
  DeleteMemoryTermInput,
  DeleteMemoryTermResult,
  DeleteThingInput,
  EditMessageInput,
  GetMemoryTermDocumentInput,
  ImportWebSearchBrowserSessionInput,
  JotdownSaveInput,
  ListActivitySourceRecordsInput,
  ListSkillsInput,
  LoadThreadDataInput,
  ManagedPythonEnvironmentAction,
  MemoryTermDocument,
  ProviderConfig,
  ProviderSettings,
  RemoveThingSourceInput,
  RenameThingInput,
  ResolveFileReferencesInput,
  ResolveSyncConflictInput,
  RetryInput,
  RunModeId,
  SaveThreadInput,
  SearchThreadsAndMessagesInput,
  SearchWorkspaceFilesInput,
  SendChatInput,
  SettingsConfig,
  TestSubagentProfileInput,
  ThreadColorTag,
  ThreadModelOverride,
  ToolCallName,
  ToolPreferencesInput,
  TranslateInput,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  UsageStatsInput
} from '@yachiyo/shared/protocol'
import type { ComposerPredictionInput } from '@yachiyo/shared/protocol/composerPrediction'
import { readFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import type { YachiyoServer } from '../app/host/YachiyoServer.ts'
import type { RuntimeLiveServices } from '../app/host/runtimeLiveServices.ts'
import { resolveExistingFileReferences } from '../runtime/files/inlineCodeFileReferences.ts'
import { hashWorkspacePath } from '../services/fileSnapshot/casStore.ts'
import {
  generateDiffForRun,
  restoreToCheckpoint,
  revertFile,
  revertRun
} from '../services/fileSnapshot/diffGenerator.ts'
import { listSnapshotRuns } from '../services/fileSnapshot/snapshotIndex.ts'
import type { JotdownStore } from '../services/jotdownStore.ts'
import { preserveUnsupportedPlatformSettings } from '../settings/settingsPlatformPreservation.ts'
import type { AppHostBridge } from './hostBridge.ts'
import { readFilePreview } from './readFilePreview.ts'
import type { AppRemoteBinding } from './remoteBinding.ts'

export function createAppRpcTarget(options: {
  cursor: () => import('@yachiyo/shared/appServer/protocol').AppEventCursor
  server: YachiyoServer
  live: RuntimeLiveServices
  host: AppHostBridge
  jotdownStore: JotdownStore
  remote: AppRemoteBinding
}): Record<string, unknown> {
  const { server, live, host, jotdownStore, remote } = options
  const rpc = (): YachiyoServer => server
  const hostCall = async <TResult = unknown>(
    method: string,
    args: unknown[] = []
  ): Promise<TResult> => {
    const operation = live.rpcOps[`host.${method}`]
    if (!operation) throw new Error(`Unknown runtime operation: ${method}`)
    return (await Reflect.apply(operation, live.rpcOps, args)) as TResult
  }
  const target: Record<string, unknown> = Object.create(null)
  const register = <Args extends unknown[], Result>(
    name: string,
    operation: (...args: Args) => Result
  ): void => {
    if (Object.hasOwn(target, name)) throw new Error(`Duplicate app RPC method: ${name}`)
    target[name] = operation
  }
  register(APP_RPC_METHODS.searchThreadsAndMessages, (input: SearchThreadsAndMessagesInput) =>
    rpc().searchThreadsAndMessages(input)
  )
  register(APP_RPC_METHODS.searchWorkspaceFiles, (input: SearchWorkspaceFilesInput) =>
    rpc().searchWorkspaceFiles(input)
  )
  register(APP_RPC_METHODS.listThings, (input?: { includeInactive?: boolean }) =>
    rpc().listThings(input)
  )
  register(APP_RPC_METHODS.getThing, (input: { name: string }) => rpc().getThing(input))
  register(APP_RPC_METHODS.restoreThing, (input: { name: string }) => rpc().restoreThing(input))
  register(APP_RPC_METHODS.renameThing, (input: RenameThingInput) => rpc().renameThing(input))
  register(APP_RPC_METHODS.deleteThing, (input: DeleteThingInput) => rpc().deleteThing(input))
  register(APP_RPC_METHODS.removeThingSource, (input: RemoveThingSourceInput) =>
    rpc().removeThingSource(input)
  )
  register(APP_RPC_METHODS.continueThingInNewChat, (input: { name: string }) =>
    rpc().continueThingInNewChat(input)
  )
  register(APP_RPC_METHODS.bootstrap, () => ({
    ...server.getClientSnapshot(),
    streamCursor: options.cursor()
  }))
  register(
    APP_RPC_METHODS.createThread,
    (input?: {
      workspacePath?: string
      createdFromEssentialId?: string
      privacyMode?: boolean
      modelOverride?: ThreadModelOverride
      enabledTools?: ToolCallName[]
      runMode?: RunModeId
      reasoningEffort?: ComposerReasoningSelection
    }) => rpc().createThread(input)
  )
  register(
    APP_RPC_METHODS.createBranch,
    (input: { threadId: string; messageId: string; truncateBeforeToolCallId?: string }) =>
      rpc().createBranch(input)
  )
  register(APP_RPC_METHODS.compactThreadToAnotherThread, (input: CompactThreadInput) =>
    rpc().compactThreadToAnotherThread(input)
  )
  register(APP_RPC_METHODS.createFolderForThreads, (input: { threadIds: string[] }) =>
    rpc().createFolderForThreads(input)
  )
  register(APP_RPC_METHODS.renameFolder, (input: { folderId: string; title: string }) =>
    rpc().renameFolder(input)
  )
  register(APP_RPC_METHODS.setFolderColor, (input: { folderId: string; colorTag: string | null }) =>
    rpc().setFolderColor(input as never)
  )
  register(APP_RPC_METHODS.deleteFolder, (input: { folderId: string }) => rpc().deleteFolder(input))
  register(
    APP_RPC_METHODS.moveThreadToFolder,
    (input: { threadId: string; folderId: string | null }) => rpc().moveThreadToFolder(input)
  )
  register(APP_RPC_METHODS.renameThread, (input: { threadId: string; title: string }) =>
    rpc().renameThread(input)
  )
  register(
    APP_RPC_METHODS.setThreadColor,
    (input: { threadId: string; colorTag: ThreadColorTag | null }) => rpc().setThreadColor(input)
  )
  register(APP_RPC_METHODS.setThreadIcon, (input: { threadId: string; icon: string | null }) =>
    rpc().setThreadIcon(input)
  )
  register(APP_RPC_METHODS.archiveThread, (input: { threadId: string }) =>
    rpc().archiveThread(input)
  )
  register(APP_RPC_METHODS.deleteThread, (input: { threadId: string }) => rpc().deleteThread(input))
  register(
    APP_RPC_METHODS.getThreadWorkspaceChangeDecision,
    (input: { threadId: string; workspacePath?: string | null }) =>
      rpc().getThreadWorkspaceChangeDecision(input)
  )
  register(APP_RPC_METHODS.readThreadPlanDocument, (input: { threadId: string }) =>
    rpc().readThreadPlanDocument(input)
  )
  register(APP_RPC_METHODS.acceptThreadPlanDocument, (input: AcceptThreadPlanDocumentInput) =>
    rpc().acceptThreadPlanDocument(input)
  )
  register(
    APP_RPC_METHODS.updateThreadWorkspace,
    (input: { threadId: string; workspacePath?: string | null; confirmed?: boolean }) =>
      rpc().updateThreadWorkspace(input)
  )
  register(APP_RPC_METHODS.restoreThread, (input: { threadId: string }) =>
    rpc().restoreThread(input)
  )
  register(APP_RPC_METHODS.saveToolPreferences, (input: ToolPreferencesInput) =>
    rpc().saveToolPreferences(input)
  )
  register(APP_RPC_METHODS.clearRecapText, (input: { threadId: string }) =>
    rpc().clearRecapText(input)
  )
  register(APP_RPC_METHODS.requestRecap, (input: { threadId: string }) => rpc().requestRecap(input))
  register(APP_RPC_METHODS.sendChat, (input: SendChatInput) => {
    const safeInput: SendChatInput = { ...input }
    delete (
      safeInput as SendChatInput & {
        toolPreset?: unknown
      }
    ).toolPreset
    delete safeInput.extraTools
    delete safeInput.channelHint
    delete safeInput.hidden
    delete safeInput.runTrigger
    return rpc().sendChat(safeInput)
  })
  register(APP_RPC_METHODS.retryMessage, (input: RetryInput) => rpc().retryMessage(input))
  register(APP_RPC_METHODS.saveThread, (input: SaveThreadInput) => rpc().saveThread(input))
  register(
    APP_RPC_METHODS.selectReplyBranch,
    (input: { threadId: string; assistantMessageId: string }) => rpc().selectReplyBranch(input)
  )
  register(APP_RPC_METHODS.deleteMessage, (input: { threadId: string; messageId: string }) =>
    rpc().deleteMessageFromHere(input)
  )
  register(APP_RPC_METHODS.editMessage, (input: EditMessageInput) => rpc().editMessage(input))
  register(APP_RPC_METHODS.cancelRun, (input: { runId: string }) => rpc().cancelRun(input))
  register(APP_RPC_METHODS.withdrawPendingSteer, (input: { threadId: string }) =>
    rpc().withdrawPendingSteer(input)
  )
  register(APP_RPC_METHODS.answerToolQuestion, (input: AnswerToolQuestionInput) =>
    rpc().answerToolQuestion(input)
  )
  register(APP_RPC_METHODS.getConfig, () => rpc().getConfig())
  register(APP_RPC_METHODS.getSoulDocument, () => rpc().getSoulDocument())
  register(APP_RPC_METHODS.addSoulTrait, (input: { trait: string }) => rpc().addSoulTrait(input))
  register(APP_RPC_METHODS.deleteSoulTrait, (input: { trait: string }) =>
    rpc().deleteSoulTrait(input)
  )
  register(
    APP_RPC_METHODS.getMemoryTermDocument,
    async (input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> =>
      rpc().getMemoryTermDocument(input)
  )
  register(
    APP_RPC_METHODS.deleteMemoryTerm,
    async (input: DeleteMemoryTermInput): Promise<DeleteMemoryTermResult> =>
      rpc().deleteMemoryTerm(input)
  )
  register(APP_RPC_METHODS.listActivitySourceRecords, (input?: ListActivitySourceRecordsInput) =>
    rpc().listActivitySourceRecords(input)
  )
  register(APP_RPC_METHODS.getUserDocument, () => rpc().getUserDocument())
  register(APP_RPC_METHODS.testSubagentProfile, (input: TestSubagentProfileInput) =>
    rpc().testSubagentProfile(input)
  )
  register(APP_RPC_METHODS.getSettings, () => rpc().getSettings())
  register(APP_RPC_METHODS.getSyncStatus, () => rpc().getSyncStatus())
  register(APP_RPC_METHODS.initSync, () => rpc().initSync())
  register(APP_RPC_METHODS.runSyncNow, () => rpc().runSyncNow())
  register(APP_RPC_METHODS.listSyncConflicts, () => rpc().listSyncConflicts())
  register(APP_RPC_METHODS.resolveSyncConflict, (input: ResolveSyncConflictInput) =>
    rpc().resolveSyncConflict(input)
  )
  register(APP_RPC_METHODS.saveUserDocument, (input: { content: string }) =>
    rpc().saveUserDocument(input)
  )
  register(APP_RPC_METHODS.saveSettings, (input: Partial<ProviderSettings>) =>
    rpc().saveSettings(input)
  )
  register(APP_RPC_METHODS.upsertProvider, (input: ProviderConfig) => rpc().upsertProvider(input))
  register(APP_RPC_METHODS.removeProvider, (input: { name: string }) => rpc().removeProvider(input))
  register(APP_RPC_METHODS.enableProviderModel, (input: { name: string; model: string }) =>
    rpc().enableProviderModel(input)
  )
  register(APP_RPC_METHODS.disableProviderModel, (input: { name: string; model: string }) =>
    rpc().disableProviderModel(input)
  )
  register(APP_RPC_METHODS.fetchProviderModels, (input: ProviderConfig) =>
    rpc().fetchProviderModels(input)
  )
  register(APP_RPC_METHODS.listWebSearchBrowserImportSources, () =>
    rpc().listWebSearchBrowserImportSources()
  )
  register(APP_RPC_METHODS.listSkills, (input: ListSkillsInput | undefined) =>
    rpc().listSkills(input)
  )
  register(
    APP_RPC_METHODS.importWebSearchBrowserSession,
    (input: ImportWebSearchBrowserSessionInput) => rpc().importWebSearchBrowserSession(input)
  )
  register(APP_RPC_METHODS.setThreadPrivacyMode, (input: { threadId: string; enabled: boolean }) =>
    rpc().setThreadPrivacyMode(input)
  )
  register(
    APP_RPC_METHODS.setThreadModelOverride,
    (input: { threadId: string; modelOverride: ThreadModelOverride | null }) =>
      rpc().setThreadModelOverride(input)
  )
  register(
    APP_RPC_METHODS.setThreadReasoningEffort,
    (input: { threadId: string; reasoningEffort: ComposerReasoningSelection | null }) =>
      rpc().setThreadReasoningEffort(input)
  )
  register(APP_RPC_METHODS.setThreadToolMode, (input: { threadId: string; runMode: RunModeId }) =>
    rpc().setThreadToolMode(input)
  )
  register(
    APP_RPC_METHODS.setThreadRuntimeBinding,
    (input: {
      threadId: string
      runtimeBinding: import('@yachiyo/shared/protocol').ThreadRuntimeBinding | null
    }) => rpc().setThreadRuntimeBinding(input)
  )
  register(APP_RPC_METHODS.regenerateThreadTitle, (input: { threadId: string }) =>
    rpc().regenerateThreadTitle(input)
  )
  register(APP_RPC_METHODS.starThread, (input: { threadId: string; starred: boolean }) =>
    rpc().starThread(input)
  )
  register(APP_RPC_METHODS.loadThreadData, (input: LoadThreadDataInput) =>
    rpc().loadThreadData(input.threadId, {
      includeMessages: input.includeMessages,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.beforeMessageId === undefined ? {} : { beforeMessageId: input.beforeMessageId })
    })
  )
  register(APP_RPC_METHODS.listSubagents, (input?: { threadId?: string }) =>
    rpc().listSubagents(input)
  )
  register(APP_RPC_METHODS.cancelSubagent, (input: { agentId: string }) =>
    rpc().cancelSubagent(input)
  )
  register(APP_RPC_METHODS.closeSubagent, (input: { agentId: string }) =>
    rpc().closeSubagent(input)
  )
  register(APP_RPC_METHODS.cancelRunningSubagents, (input: { threadId: string }) =>
    rpc().cancelRunningSubagents(input)
  )
  register(APP_RPC_METHODS.listExternalThreads, () => rpc().listExternalThreads())
  register(APP_RPC_METHODS.listChannelUsers, () => rpc().listChannelUsers())
  register(APP_RPC_METHODS.updateChannelUser, (input: UpdateChannelUserInput) =>
    rpc().updateChannelUser(input)
  )
  register(APP_RPC_METHODS.listChannelGroups, () => rpc().listChannelGroups())
  register(APP_RPC_METHODS.updateChannelGroup, (input: UpdateChannelGroupInput) =>
    hostCall('updateChannelGroupAndNotify', [input])
  )
  register(APP_RPC_METHODS.clearGroupMonitorBuffer, (input: { groupId: string }) =>
    hostCall('clearChannelGroupHistory', [input])
  )
  register(APP_RPC_METHODS.getChannelsConfig, () => rpc().getChannelsConfig())
  register(APP_RPC_METHODS.saveChannelsConfig, (input: ChannelsConfig) =>
    hostCall('saveChannelsConfigAndReconcile', [input])
  )
  register(
    APP_RPC_METHODS.restartChannelService,
    (input: { platform: 'telegram' | 'qq' | 'discord' | 'qqbot' | 'all' }) =>
      hostCall('restartChannelServices', [input])
  )
  register(APP_RPC_METHODS.listSchedules, () => rpc().listSchedules())
  register(APP_RPC_METHODS.createSchedule, async (input: CreateScheduleInput) => {
    const schedule = await rpc().createSchedule(input)
    await hostCall('reloadSchedules')
    return schedule
  })
  register(APP_RPC_METHODS.updateSchedule, async (input: UpdateScheduleInput) => {
    const schedule = await rpc().updateSchedule(input)
    await hostCall('reloadSchedules')
    return schedule
  })
  register(APP_RPC_METHODS.deleteSchedule, async (input: { id: string }) => {
    await rpc().deleteSchedule(input.id)
    await hostCall('reloadSchedules')
  })
  register(APP_RPC_METHODS.enableSchedule, async (input: { id: string }) => {
    const result = await rpc().enableSchedule(input.id)
    await hostCall('reloadSchedules')
    return result
  })
  register(APP_RPC_METHODS.disableSchedule, async (input: { id: string }) => {
    const result = await rpc().disableSchedule(input.id)
    await hostCall('reloadSchedules')
    return result
  })
  register(APP_RPC_METHODS.listScheduleRuns, (input: { scheduleId: string; limit?: number }) =>
    rpc().listScheduleRuns(input.scheduleId, input.limit)
  )
  register(APP_RPC_METHODS.listRecentScheduleRuns, (input?: { limit?: number }) =>
    rpc().listRecentScheduleRuns(input?.limit)
  )
  register(APP_RPC_METHODS.triggerScheduleNow, (input: { scheduleId: string }) =>
    hostCall('triggerScheduleNow', [input])
  )
  register(APP_RPC_METHODS.markThreadAsRead, (input: { threadId: string }) =>
    rpc().markThreadAsRead(input)
  )
  register(
    APP_RPC_METHODS.downloadRemoteImageForMessage,
    (input: { threadId: string; messageId: string; url: string }) =>
      rpc().downloadRemoteImageForMessage(input)
  )
  register(APP_RPC_METHODS.predictComposer, (input: ComposerPredictionInput) =>
    rpc().predictComposer(input)
  )
  register(APP_RPC_METHODS.jotdownList, () => jotdownStore.list())
  register(APP_RPC_METHODS.jotdownLoad, (input: { id: string }) => jotdownStore.load(input.id))
  register(APP_RPC_METHODS.jotdownCreate, () => jotdownStore.create())
  register(APP_RPC_METHODS.jotdownSave, (input: JotdownSaveInput) => jotdownStore.save(input))
  register(APP_RPC_METHODS.jotdownDelete, (input: { id: string }) => jotdownStore.delete(input.id))
  register(APP_RPC_METHODS.pruneEmptyTemporaryWorkspaces, () =>
    rpc().pruneEmptyTemporaryWorkspaces()
  )
  register(APP_RPC_METHODS.getUsageStats, (input: UsageStatsInput) => rpc().getUsageStats(input))
  register(
    APP_RPC_METHODS.getSnapshotDiff,
    async (input: { runId: string; workspacePath: string }) => {
      const changes = await generateDiffForRun(input.workspacePath, input.runId)
      if (!changes) await rpc().clearRunSnapshotFileCounts({ runIds: [input.runId] })
      return changes
    }
  )
  register(
    APP_RPC_METHODS.revertSnapshotFile,
    (input: { runId: string; workspacePath: string; relativePath: string }) =>
      revertFile(input.workspacePath, input.runId, input.relativePath)
  )
  register(APP_RPC_METHODS.revertSnapshotRun, (input: { runId: string; workspacePath: string }) =>
    revertRun(input.workspacePath, input.runId)
  )
  register(APP_RPC_METHODS.listRunSnapshots, (input: { workspacePath: string }) =>
    listSnapshotRuns(hashWorkspacePath(input.workspacePath))
  )
  register(
    APP_RPC_METHODS.restoreToCheckpoint,
    async (input: { runId: string; workspacePath: string }) => {
      const destroyedRunIds = await restoreToCheckpoint(input.workspacePath, input.runId)
      await rpc().clearRunSnapshotFileCounts({ runIds: destroyedRunIds })
      return destroyedRunIds
    }
  )

  register(APP_RPC_METHODS.saveConfig, async (input: SettingsConfig) => {
    const current = await server.getConfig()
    let submitted = preserveUnsupportedPlatformSettings({
      platform: process.platform,
      previous: current,
      submitted: input
    })
    if (host.connected) {
      submitted = (await host.call('mainHost.prepareConfig', [
        submitted,
        current
      ])) as SettingsConfig
    } else if (
      submitted.general?.activityTracking?.mode !== current.general?.activityTracking?.mode
    ) {
      throw new Error('Changing activity tracking requires an attached desktop app')
    }
    const saved = await server.saveConfig(submitted)
    return saved
  })
  register(APP_RPC_METHODS.getPerfStats, () => hostCall('getPerfStats'))
  register(APP_RPC_METHODS.getPythonEnvironmentStatus, () => server.getPythonEnvironmentStatus())
  register(
    APP_RPC_METHODS.managePythonEnvironment,
    (input: { action: ManagedPythonEnvironmentAction }) =>
      server.managePythonEnvironment(input.action)
  )
  register(APP_RPC_METHODS.listBackgroundTasks, (input?: { threadId?: string }) =>
    server.listBackgroundTasks(input)
  )
  register(
    APP_RPC_METHODS.getBackgroundTaskLog,
    (input: { threadId: string; taskId: string; maxBytes?: number }) =>
      server.getBackgroundTaskLog(input)
  )
  register(APP_RPC_METHODS.cancelBackgroundTask, (input: { taskId: string }) =>
    server.cancelBackgroundTask(input)
  )
  register(APP_RPC_METHODS.translate, (input: TranslateInput, progress: (delta: string) => void) =>
    server.translateStream(input, progress)
  )
  register(APP_RPC_METHODS.remoteStatus, () => remote.handleCommand({ action: 'status' }))
  register(APP_RPC_METHODS.remoteActivateRelay, (input: { code: string }) =>
    remote.activateRelay(input.code)
  )
  register(APP_RPC_METHODS.remoteCreatePairing, async () => {
    const pairing = await remote.createPairingUrl()
    return {
      ...pairing,
      svg: await QRCode.toString(pairing.url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
    }
  })
  register(APP_RPC_METHODS.remoteListPairings, () =>
    remote.handleCommand({ action: 'pairings-list' })
  )
  register(APP_RPC_METHODS.remoteRevokePairing, (input: { pairingId: string }) =>
    remote.revokePairing(input.pairingId)
  )
  register(APP_RPC_METHODS.readFilePreview, readFilePreview)
  register(APP_RPC_METHODS.resolveFileReferences, (input: ResolveFileReferencesInput) =>
    resolveExistingFileReferences(input)
  )
  register(
    APP_RPC_METHODS.readAttachmentFile,
    async (input: { filePath: string; mediaType: string }) => {
      const bytes = await readFile(input.filePath)
      if (bytes.length > 25 * 1024 * 1024)
        throw new Error('Attachments must be smaller than 25 MiB')
      return `data:${input.mediaType};base64,${bytes.toString('base64')}`
    }
  )
  for (const name of Object.values(APP_RPC_METHODS)) {
    if (!Object.hasOwn(target, name)) throw new Error(`App RPC method missing: ${name}`)
  }
  return target
}
