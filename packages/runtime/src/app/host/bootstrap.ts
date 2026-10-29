import type { BootstrapPayload, SettingsConfig } from '@yachiyo/shared/protocol'
import type { YachiyoServerConfigDomain } from '../domain/config/configDomain.ts'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import type { ThreadSentinelManager } from '../domain/sentinel/threadSentinelManager.ts'

export async function initializeYachiyoServer(input: {
  developmentMode: boolean
  readSoulDocument: () => Promise<unknown>
  readUserDocument: () => Promise<unknown>
  recoverInterruptedRuns: () => void
  recoverInterruptedSaves: () => string[]
  runDomain: YachiyoServerRunDomain
  storage: YachiyoStorage
}): Promise<string[]> {
  if (!input.developmentMode) {
    input.recoverInterruptedRuns()
  }
  const recoveredInterruptedSaveThreadIds = input.recoverInterruptedSaves()
  await Promise.all([input.readSoulDocument(), input.readUserDocument()])
  const recoveredRuns = input.developmentMode ? [] : input.runDomain.prepareRecoveredRuns()
  if (!input.developmentMode) {
    const { threads, archivedThreads } = input.storage.bootstrap()
    input.runDomain.recoverOrphanedSubagents(
      Object.fromEntries(
        [...threads, ...archivedThreads].map((thread) => [
          thread.id,
          input.storage.listThreadToolCalls(thread.id)
        ])
      )
    )
  }
  input.runDomain.scheduleRecoveredRuns(recoveredRuns)
  return recoveredInterruptedSaveThreadIds
}

/** A client snapshot never performs startup recovery or changes a running task. */
export function bootstrapYachiyoServer(input: {
  configDomain: YachiyoServerConfigDomain
  runDomain: YachiyoServerRunDomain
  sentinelManager?: ThreadSentinelManager
  storage: YachiyoStorage
  recoveredInterruptedSaveThreadIds: string[]
}): BootstrapPayload {
  return {
    ...input.runDomain.withLiveMessagesBootstrap(
      input.runDomain.withQueuedFollowUpDraftsBootstrap(input.storage.bootstrap())
    ),
    sentinelsByThread: Object.fromEntries(
      (input.sentinelManager?.list() ?? []).map((sentinel) => [sentinel.threadId, sentinel])
    ),
    recoveredInterruptedSaveThreadIds: input.recoveredInterruptedSaveThreadIds,
    config: input.configDomain.readConfig() as SettingsConfig,
    settings: input.configDomain.readSettings()
  }
}
