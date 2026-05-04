import type {
  CompactThreadAccepted,
  CompactThreadInput,
  ComposerReasoningSelection,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { FolderDomain } from '../domain/folderDomain.ts'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import type { YachiyoServerThreadDomain } from '../domain/threadDomain.ts'

export async function createThreadWithHandoffWorkspace(input: {
  createId: () => string
  cloneThreadWorkspace: (sourceThreadId: string, targetThreadId: string) => Promise<string>
  payload: {
    workspacePath?: string
    source?: ThreadRecord['source']
    channelUserId?: string
    channelGroupId?: string
    title?: string
    createdFromEssentialId?: string
    createdFromScheduleId?: string
    handoffFromThreadId?: string
    privacyMode?: boolean
    reasoningEffort?: ComposerReasoningSelection
  }
  requireThread: (threadId: string) => ThreadRecord
  threadDomain: YachiyoServerThreadDomain
}): Promise<ThreadRecord> {
  if (input.payload.handoffFromThreadId && !input.payload.workspacePath?.trim()) {
    const sourceThread = input.requireThread(input.payload.handoffFromThreadId)
    if (!sourceThread.workspacePath) {
      const threadId = input.createId()
      await input.cloneThreadWorkspace(sourceThread.id, threadId)
      return input.threadDomain.createThread({ ...input.payload, threadId })
    }
  }

  return input.threadDomain.createThread(input.payload)
}

export async function compactThreadWithHandoff(input: {
  cloneThreadWorkspace: (sourceThreadId: string, targetThreadId: string) => Promise<string>
  createId: () => string
  folderDomain: FolderDomain
  payload: CompactThreadInput
  requireThread: (threadId: string) => ThreadRecord
  runDomain: YachiyoServerRunDomain
  threadDomain: YachiyoServerThreadDomain
}): Promise<CompactThreadAccepted> {
  const sourceThread = input.requireThread(input.payload.threadId)

  if (sourceThread.source && sourceThread.source !== 'local') {
    throw new Error('Handoff is only supported for local threads.')
  }

  if (input.runDomain.hasActiveThread(sourceThread.id)) {
    throw new Error('Cannot compact a thread with an active run.')
  }

  const destinationThreadId = input.createId()
  if (!sourceThread.workspacePath) {
    await input.cloneThreadWorkspace(sourceThread.id, destinationThreadId)
  }

  const destinationThread = await input.threadDomain.createThread({
    threadId: destinationThreadId,
    handoffFromThreadId: sourceThread.id,
    ...(sourceThread.workspacePath ? { workspacePath: sourceThread.workspacePath } : {}),
    ...(sourceThread.modelOverride ? { modelOverride: sourceThread.modelOverride } : {}),
    ...(sourceThread.reasoningEffort ? { reasoningEffort: sourceThread.reasoningEffort } : {})
  })

  input.folderDomain.ensureFolderForDerivedThread({
    sourceThread,
    derivedThread: destinationThread
  })

  return input.runDomain.compactThreadToAnotherThread({
    sourceThread,
    destinationThread,
    reasoningEffort: input.payload.reasoningEffort ?? destinationThread.reasoningEffort
  })
}
