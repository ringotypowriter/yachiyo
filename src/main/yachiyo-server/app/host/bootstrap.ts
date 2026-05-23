import type { BootstrapPayload, SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoServerConfigDomain } from '../domain/config/configDomain.ts'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import type { ThreadSentinelManager } from '../domain/sentinel/threadSentinelManager.ts'

export async function bootstrapYachiyoServer(input: {
  configDomain: YachiyoServerConfigDomain
  developmentMode: boolean
  readSoulDocument: () => Promise<unknown>
  readUserDocument: () => Promise<unknown>
  recoverInterruptedRuns: () => void
  recoverInterruptedSaves: () => string[]
  runDomain: YachiyoServerRunDomain
  sentinelManager?: ThreadSentinelManager
  storage: YachiyoStorage
}): Promise<BootstrapPayload> {
  if (!input.developmentMode) {
    input.recoverInterruptedRuns()
  }
  const recoveredInterruptedSaveThreadIds = input.recoverInterruptedSaves()
  await Promise.all([input.readSoulDocument(), input.readUserDocument()])
  const recoveredQueuedFollowUps = input.runDomain.prepareRecoveredQueuedFollowUps()
  const recoveredRuns = input.developmentMode ? [] : input.runDomain.prepareRecoveredRuns()
  const bootstrapped = input.runDomain.withQueuedFollowUpDraftsBootstrap(input.storage.bootstrap())

  input.runDomain.scheduleRecoveredQueuedFollowUps(recoveredQueuedFollowUps)
  input.runDomain.scheduleRecoveredRuns(recoveredRuns)

  return {
    ...bootstrapped,
    sentinelsByThread: Object.fromEntries(
      (input.sentinelManager?.list() ?? []).map((sentinel) => [sentinel.threadId, sentinel])
    ),
    recoveredInterruptedSaveThreadIds,
    config: input.configDomain.readConfig() as SettingsConfig,
    settings: input.configDomain.readSettings()
  }
}
