import type { MessageRecord } from '@yachiyo/shared/protocol'
import type { YachiyoStorage } from '../../../../storage/storage.ts'

export type EphemeralStorage = YachiyoStorage & { lastAssistantContent: string | null }

export function createEphemeralStorageProxy(real: YachiyoStorage): EphemeralStorage {
  const state = { lastAssistantContent: null as string | null }
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'lastAssistantContent') return state.lastAssistantContent
      if (
        prop === 'startRun' ||
        prop === 'cancelRun' ||
        prop === 'failRun' ||
        prop === 'saveThreadMessage' ||
        prop === 'updateThread' ||
        prop === 'updateMessage' ||
        prop === 'persistResponseMessagesRepairInBackground' ||
        prop === 'createToolCall' ||
        prop === 'updateToolCall' ||
        prop === 'saveActivitySourceRecord' ||
        prop === 'upsertRunRecoveryCheckpoint' ||
        prop === 'deleteRunRecoveryCheckpoint' ||
        prop === 'updateRunSnapshot'
      ) {
        return () => {}
      }
      if (prop === 'flushBackgroundTasks') {
        return async () => {}
      }
      if (prop === 'completeRun') {
        return (input: { assistantMessage?: MessageRecord }) => {
          state.lastAssistantContent = input.assistantMessage?.content ?? null
        }
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as EphemeralStorage
}
