import type { BootstrapPayload, SettingsConfig } from '@yachiyo/shared/protocol'
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
  const recoveredRuns = input.developmentMode ? [] : input.runDomain.prepareRecoveredRuns()
  const bootstrapped = input.runDomain.withQueuedFollowUpDraftsBootstrap(input.storage.bootstrap())
  const recoveredToolCallsByThread = input.developmentMode
    ? bootstrapped.toolCallsByThread
    : (() => {
        const bootstrappedThreadIds = new Set(
          [...bootstrapped.threads, ...bootstrapped.archivedThreads].map((thread) => thread.id)
        )
        const persistedToolCallsByThread = Object.fromEntries(
          [...bootstrappedThreadIds].map((threadId) => [
            threadId,
            input.storage.listThreadToolCalls(threadId)
          ])
        )
        const recoveredPersistedToolCallsByThread = input.runDomain.recoverOrphanedSubagents(
          persistedToolCallsByThread
        )

        return Object.fromEntries(
          Object.entries(bootstrapped.toolCallsByThread).map(([threadId, toolCalls]) => {
            const recoveredToolCalls = recoveredPersistedToolCallsByThread[threadId]
            if (recoveredToolCalls === undefined) {
              throw new Error(`Missing persisted tool calls for bootstrapped thread ${threadId}.`)
            }
            const recoveredToolCallsById = new Map(
              recoveredToolCalls.map((toolCall) => [toolCall.id, toolCall] as const)
            )
            return [
              threadId,
              toolCalls.map((toolCall) => {
                const recoveredToolCall = recoveredToolCallsById.get(toolCall.id)
                if (recoveredToolCall === undefined) {
                  throw new Error(
                    `Missing persisted tool call ${toolCall.id} for bootstrapped thread ${threadId}.`
                  )
                }
                return recoveredToolCall
              })
            ]
          })
        )
      })()

  input.runDomain.scheduleRecoveredRuns(recoveredRuns)

  return {
    ...bootstrapped,
    toolCallsByThread: recoveredToolCallsByThread,
    sentinelsByThread: Object.fromEntries(
      (input.sentinelManager?.list() ?? []).map((sentinel) => [sentinel.threadId, sentinel])
    ),
    recoveredInterruptedSaveThreadIds,
    config: input.configDomain.readConfig() as SettingsConfig,
    settings: input.configDomain.readSettings()
  }
}
