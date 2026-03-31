import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  HarnessFinishedEvent,
  HarnessStartedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  SettingsConfig,
  ThreadRecord,
  ThreadRuntimeBinding,
  ThreadUpdatedEvent
} from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import {
  DEFAULT_HARNESS_NAME,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from '../../app/domain/shared.ts'
import type { ExecuteRunResult } from '../../app/domain/runExecution.ts'
import { launchAcpProcess } from './acpLauncher.ts'
import { runAcpSession } from './acpSessionClient.ts'
import { createAcpStreamAdapter } from './acpStreamAdapter.ts'

export interface AcpChatRunDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  readThread: (threadId: string) => ThreadRecord
  readConfig: () => SettingsConfig
  loadThreadMessages: (threadId: string) => MessageRecord[]
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  launchAcpProcess?: typeof launchAcpProcess
  runAcpSession?: typeof runAcpSession
  onTerminalState?: () => void
}

export interface AcpChatRunInput {
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  abortController: AbortController
  updateHeadOnComplete: boolean
}

export async function runAcpChatThread(
  deps: AcpChatRunDeps,
  input: AcpChatRunInput
): Promise<ExecuteRunResult> {
  const harnessId = deps.createId()
  const messageId = deps.createId()

  const runtimeBinding = input.thread.runtimeBinding
  if (!runtimeBinding || runtimeBinding.kind !== 'acp') {
    throw new Error('Thread is not bound to an ACP profile')
  }

  const config = deps.readConfig()
  const profile = (config.subagentProfiles ?? []).find((p) => p.id === runtimeBinding.profileId)
  if (!profile) {
    throw new Error(
      `ACP profile "${runtimeBinding.profileId}" not found. Check your subagent profile configuration.`
    )
  }

  const requestMessage = deps
    .loadThreadMessages(input.thread.id)
    .find((m) => m.id === input.requestMessageId && m.role === 'user')
  if (!requestMessage) {
    throw new Error(`Request message "${input.requestMessageId}" not found in thread`)
  }

  const prompt = requestMessage.content

  let workspacePath: string
  if (input.thread.workspacePath?.trim()) {
    workspacePath = resolve(input.thread.workspacePath)
    await mkdir(workspacePath, { recursive: true })
  } else {
    workspacePath = await deps.ensureThreadWorkspace(input.thread.id)
  }

  deps.emit<HarnessStartedEvent>({
    type: 'harness.started',
    threadId: input.thread.id,
    runId: input.runId,
    harnessId,
    name: DEFAULT_HARNESS_NAME
  })
  deps.emit<MessageStartedEvent>({
    type: 'message.started',
    threadId: input.thread.id,
    runId: input.runId,
    messageId,
    parentMessageId: input.requestMessageId
  })

  let buffer = ''
  const resumeSessionId =
    runtimeBinding.sessionStatus === 'active' && runtimeBinding.sessionId !== undefined
      ? runtimeBinding.sessionId
      : undefined
  const startAcpProcess = deps.launchAcpProcess ?? launchAcpProcess
  const executeAcpSession = deps.runAcpSession ?? runAcpSession

  try {
    if (input.abortController.signal.aborted) {
      throw new Error('Aborted before ACP session started')
    }

    const { proc, stream, procExited } = startAcpProcess(profile, workspacePath)

    const adapter = createAcpStreamAdapter({
      onProgress: (chunk) => {
        buffer += chunk
        deps.emit<MessageDeltaEvent>({
          type: 'message.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta: chunk
        })
      }
    })

    proc.stderr?.on('data', (data: Buffer) => adapter.onStderr(data))

    const sessionResult = await executeAcpSession(
      stream,
      proc,
      procExited,
      workspacePath,
      prompt,
      adapter,
      {
        abortSignal: input.abortController.signal,
        resumeSessionId
      }
    )

    if (input.abortController.signal.aborted) {
      return emitCancelledAndReturn(deps, input, {
        buffer,
        harnessId,
        messageId,
        modelId: profile.name
      })
    }

    const timestamp = deps.timestamp()
    const finalContent = sessionResult.lastMessageText.trim() || buffer.trim()

    const updatedBinding: ThreadRuntimeBinding = {
      kind: 'acp',
      profileId: runtimeBinding.profileId,
      profileName: runtimeBinding.profileName ?? profile.name,
      sessionId: sessionResult.sessionId,
      sessionStatus: 'active',
      lastSessionBoundAt: timestamp
    }

    const assistantMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: finalContent,
      status: 'completed',
      createdAt: timestamp,
      modelId: profile.name,
      providerName: 'acp'
    }

    const currentThread = deps.readThread(input.thread.id)
    const updatedThread: ThreadRecord = {
      ...currentThread,
      runtimeBinding: updatedBinding,
      updatedAt: timestamp,
      ...(input.updateHeadOnComplete
        ? { headMessageId: assistantMessage.id, preview: finalContent.slice(0, 240) }
        : {})
    }

    deps.storage.completeRun({ runId: input.runId, updatedThread, assistantMessage })
    deps.onTerminalState?.()

    deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.thread.id,
      runId: input.runId,
      message: assistantMessage
    })
    deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.thread.id,
      thread: updatedThread
    })
    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'completed'
    })
    deps.emit<RunCompletedEvent>({
      type: 'run.completed',
      threadId: input.thread.id,
      runId: input.runId
    })

    return { kind: 'completed' }
  } catch (error) {
    if (input.abortController.signal.aborted) {
      return emitCancelledAndReturn(deps, input, {
        buffer,
        harnessId,
        messageId,
        modelId: profile.name
      })
    }

    const errMsg = error instanceof Error ? error.message : String(error)
    const timestamp = deps.timestamp()
    const currentThread = deps.readThread(input.thread.id)
    const updatedThread: ThreadRecord = {
      ...currentThread,
      updatedAt: timestamp,
      ...(resumeSessionId
        ? {
            runtimeBinding: {
              kind: 'acp',
              profileId: runtimeBinding.profileId,
              profileName: runtimeBinding.profileName ?? profile.name,
              sessionStatus: 'expired',
              ...(runtimeBinding.lastSessionBoundAt
                ? { lastSessionBoundAt: runtimeBinding.lastSessionBoundAt }
                : {})
            }
          }
        : {})
    }

    const failedMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: buffer,
      status: 'failed',
      createdAt: timestamp
    }

    if (resumeSessionId) {
      deps.storage.updateThread(updatedThread)
    }

    deps.storage.saveThreadMessage({
      thread: currentThread,
      updatedThread,
      message: failedMessage
    })
    deps.storage.failRun({ runId: input.runId, completedAt: timestamp, error: errMsg })
    deps.onTerminalState?.()

    deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.thread.id,
      runId: input.runId,
      message: failedMessage
    })
    if (resumeSessionId) {
      deps.emit<ThreadUpdatedEvent>({
        type: 'thread.updated',
        threadId: input.thread.id,
        thread: updatedThread
      })
    }
    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'failed'
    })
    deps.emit<RunFailedEvent>({
      type: 'run.failed',
      threadId: input.thread.id,
      runId: input.runId,
      error: errMsg
    })

    return { kind: 'failed' }
  }
}

function emitCancelledAndReturn(
  deps: AcpChatRunDeps,
  input: AcpChatRunInput,
  options: {
    buffer: string
    harnessId: string
    messageId: string
    modelId: string
  }
): ExecuteRunResult {
  const timestamp = deps.timestamp()
  if (options.buffer.length > 0) {
    const currentThread = deps.readThread(input.thread.id)
    const stoppedMessage: MessageRecord = {
      id: options.messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: options.buffer,
      status: 'stopped',
      createdAt: timestamp,
      modelId: options.modelId,
      providerName: 'acp'
    }
    const updatedThread: ThreadRecord = {
      ...currentThread,
      updatedAt: timestamp,
      preview: options.buffer.slice(0, 240)
    }
    deps.storage.saveThreadMessage({
      thread: currentThread,
      updatedThread,
      message: stoppedMessage
    })
    deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.thread.id,
      runId: input.runId,
      message: stoppedMessage
    })
    deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.thread.id,
      thread: updatedThread
    })
  }

  deps.storage.cancelRun({ runId: input.runId, completedAt: timestamp })
  deps.onTerminalState?.()
  deps.emit<HarnessFinishedEvent>({
    type: 'harness.finished',
    threadId: input.thread.id,
    runId: input.runId,
    harnessId: options.harnessId,
    name: DEFAULT_HARNESS_NAME,
    status: 'cancelled'
  })
  deps.emit<RunCancelledEvent>({
    type: 'run.cancelled',
    threadId: input.thread.id,
    runId: input.runId
  })
  return { kind: 'cancelled' }
}
