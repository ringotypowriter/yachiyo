import type {
  CompactThreadAccepted,
  CompactThreadInput,
  ComposerReasoningSelection,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { FolderDomain } from '../domain/folders/folderDomain.ts'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import type { YachiyoServerThreadDomain } from '../domain/threads/threadDomain.ts'

async function resolveHandoffWorkspacePath(
  sourceThread: ThreadRecord,
  ensureThreadWorkspace: (threadId: string) => Promise<string>
): Promise<string> {
  return sourceThread.workspacePath?.trim()
    ? sourceThread.workspacePath
    : await ensureThreadWorkspace(sourceThread.id)
}

export async function createThreadWithHandoffWorkspace(input: {
  createId: () => string
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
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  threadDomain: YachiyoServerThreadDomain
}): Promise<ThreadRecord> {
  if (input.payload.handoffFromThreadId && !input.payload.workspacePath?.trim()) {
    const sourceThread = input.requireThread(input.payload.handoffFromThreadId)
    const workspacePath = await resolveHandoffWorkspacePath(
      sourceThread,
      input.ensureThreadWorkspace
    )
    return input.threadDomain.createThread({
      ...input.payload,
      threadId: input.createId(),
      workspacePath
    })
  }

  return input.threadDomain.createThread(input.payload)
}

export async function compactThreadWithHandoff(input: {
  createId: () => string
  folderDomain: FolderDomain
  payload: CompactThreadInput
  requireThread: (threadId: string) => ThreadRecord
  ensureThreadWorkspace: (threadId: string) => Promise<string>
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

  const destinationThread = await input.threadDomain.createThread({
    threadId: destinationThreadId,
    handoffFromThreadId: sourceThread.id,
    workspacePath: await resolveHandoffWorkspacePath(sourceThread, input.ensureThreadWorkspace),
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
