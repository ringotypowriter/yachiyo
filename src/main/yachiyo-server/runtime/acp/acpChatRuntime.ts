import type { ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ContentBlock } from '@agentclientprotocol/sdk'

import type {
  HarnessFinishedEvent,
  HarnessStartedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageImageRecord,
  MessageRecord,
  MessageStartedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  SettingsConfig,
  SubagentProfile,
  ThreadRecord,
  ThreadRuntimeBinding,
  ThreadUpdatedEvent,
  ToolCallRecord,
  ToolCallUpdatedEvent
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
import { continueAcpSession, runAcpSession } from './acpSessionClient.ts'
import type { AcpWarmSession } from './acpSessionClient.ts'
import { createAcpStreamAdapter } from './acpStreamAdapter.ts'
import {
  type AcpProcessPool,
  type AcpProcessPoolKey,
  acpProcessPool as defaultAcpProcessPool
} from './acpProcessPool.ts'

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
  continueAcpSession?: typeof continueAcpSession
  onTerminalState?: () => void
  acpProcessPool?: Pick<AcpProcessPool, 'checkout' | 'checkin'>
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

  const prompt = buildAcpPromptBlocks(requestMessage)

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
  const continueSession = deps.continueAcpSession ?? continueAcpSession
  const pool = deps.acpProcessPool ?? defaultAcpProcessPool
  const activeToolCalls = new Map<string, ToolCallRecord>()
  const poolKey = buildAcpProcessPoolKey(input.thread.id, profile, workspacePath)
  let pendingWarmSession: AcpWarmSession | null = null

  try {
    if (input.abortController.signal.aborted) {
      throw new Error('Aborted before ACP session started')
    }

    let proc!: ChildProcess
    let procExited!: Promise<void>
    let acpResult!: Awaited<ReturnType<typeof runAcpSession>>
    let warmToCheckin: AcpWarmSession | null = null
    let toolStepIndex = 0

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
      },
      onToolCall: (acpToolCall) => {
        toolStepIndex += 1
        const acpStatus = acpToolCall.status
        const yachiyoStatus =
          acpStatus === 'completed' ? 'completed' : acpStatus === 'failed' ? 'failed' : 'running'
        const record: ToolCallRecord = {
          id: `${input.runId}:${acpToolCall.toolCallId}`,
          runId: input.runId,
          threadId: input.thread.id,
          requestMessageId: input.requestMessageId,
          toolName: acpToolCall.title,
          status: yachiyoStatus,
          inputSummary: acpToolCall.title,
          startedAt: deps.timestamp(),
          stepIndex: toolStepIndex,
          ...(yachiyoStatus !== 'running' ? { finishedAt: deps.timestamp() } : {})
        }
        activeToolCalls.set(acpToolCall.toolCallId, record)
        deps.storage.createToolCall(record)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall: record
        })
      },
      onToolCallUpdate: (update) => {
        const existing = activeToolCalls.get(update.toolCallId)
        if (!existing) return
        const acpStatus = update.status ?? undefined
        const yachiyoStatus =
          acpStatus === 'completed'
            ? 'completed'
            : acpStatus === 'failed'
              ? 'failed'
              : existing.status
        const isTerminal = yachiyoStatus === 'completed' || yachiyoStatus === 'failed'
        const outputSummary = extractTextFromAcpContent(update.content) ?? existing.outputSummary
        const updatedTitle = update.title ?? existing.toolName
        const updated: ToolCallRecord = {
          ...existing,
          toolName: updatedTitle,
          inputSummary: updatedTitle,
          status: yachiyoStatus,
          ...(outputSummary !== undefined ? { outputSummary } : {}),
          ...(isTerminal && !existing.finishedAt ? { finishedAt: deps.timestamp() } : {})
        }
        activeToolCalls.set(update.toolCallId, updated)
        deps.storage.updateToolCall(updated)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall: updated
        })
      }
    })

    const warmSession = pool.checkout(poolKey)
    if (warmSession) {
      proc = warmSession.proc
      procExited = warmSession.procExited
      acpResult = await continueSession(warmSession, prompt, adapter, {
        abortSignal: input.abortController.signal,
        keepAlive: true
      })
      warmToCheckin = warmSession
    } else {
      const launchResult = startAcpProcess(profile, workspacePath)
      proc = launchResult.proc
      procExited = launchResult.procExited

      const adapterRef = { current: adapter }
      proc.stderr?.on('data', (data: Buffer) => adapterRef.current.onStderr(data))

      acpResult = await executeAcpSession(
        launchResult.stream,
        proc,
        procExited,
        workspacePath,
        prompt,
        adapter,
        adapterRef,
        {
          abortSignal: input.abortController.signal,
          resumeSessionId,
          keepAlive: true
        }
      )
      warmToCheckin = acpResult.warmSession ?? null
    }
    pendingWarmSession = warmToCheckin

    if (input.abortController.signal.aborted) {
      await killDetachedProcess(
        pendingWarmSession?.proc ?? proc,
        pendingWarmSession?.procExited ?? procExited
      )
      pendingWarmSession = null
      return emitCancelledAndReturn(deps, input, {
        buffer,
        harnessId,
        messageId,
        modelId: profile.name,
        activeToolCalls
      })
    }

    const timestamp = deps.timestamp()
    const finalContent = acpResult.lastMessageText.trim() || buffer.trim()

    const updatedBinding: ThreadRuntimeBinding = {
      kind: 'acp',
      profileId: runtimeBinding.profileId,
      profileName: runtimeBinding.profileName ?? profile.name,
      sessionId: acpResult.sessionId,
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
    bindActiveToolCallsToAssistant(deps, activeToolCalls, {
      threadId: input.thread.id,
      runId: input.runId,
      assistantMessageId: messageId,
      finishedAt: timestamp,
      failRunningToolCalls: true
    })
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

    if (pendingWarmSession) {
      pool.checkin(poolKey, pendingWarmSession)
      pendingWarmSession = null
    }

    return { kind: 'completed' }
  } catch (error) {
    if (pendingWarmSession) {
      await killDetachedProcess(pendingWarmSession.proc, pendingWarmSession.procExited)
      pendingWarmSession = null
    }
    if (input.abortController.signal.aborted) {
      return emitCancelledAndReturn(deps, input, {
        buffer,
        harnessId,
        messageId,
        modelId: profile.name,
        activeToolCalls
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
    bindActiveToolCallsToAssistant(deps, activeToolCalls, {
      threadId: input.thread.id,
      runId: input.runId,
      assistantMessageId: messageId,
      finishedAt: timestamp,
      failRunningToolCalls: true
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

export function buildAcpPromptBlocks(
  message: Pick<MessageRecord, 'content' | 'images'>
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: message.content }]
  for (const image of message.images ?? []) {
    const imageBlock = dataUrlToImageBlock(image)
    if (imageBlock) blocks.push(imageBlock)
  }
  return blocks
}

function dataUrlToImageBlock(image: MessageImageRecord): (ContentBlock & { type: 'image' }) | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(image.dataUrl)
  if (!match) return null
  const [, mimeType, data] = match
  return { type: 'image', mimeType, data }
}

export function buildAcpProcessPoolKey(
  threadId: string,
  profile: Pick<SubagentProfile, 'id' | 'command' | 'args' | 'env'>,
  workspacePath: string
): AcpProcessPoolKey {
  const sessionConfig = {
    profileId: profile.id,
    command: profile.command,
    args: profile.args,
    env: Object.entries(profile.env).sort(([left], [right]) => left.localeCompare(right)),
    workspacePath
  }

  return {
    threadId,
    sessionKey: JSON.stringify(sessionConfig)
  }
}

async function killDetachedProcess(proc: ChildProcess, procExited: Promise<void>): Promise<void> {
  try {
    process.kill(-proc.pid!, 'SIGKILL')
  } catch {
    proc.kill('SIGKILL')
  }
  await procExited
}

function emitCancelledAndReturn(
  deps: AcpChatRunDeps,
  input: AcpChatRunInput,
  options: {
    buffer: string
    harnessId: string
    messageId: string
    modelId: string
    activeToolCalls?: Map<string, ToolCallRecord>
  }
): ExecuteRunResult {
  const timestamp = deps.timestamp()
  const hasContent = options.buffer.length > 0 || (options.activeToolCalls?.size ?? 0) > 0
  if (hasContent) {
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
    bindActiveToolCallsToAssistant(deps, options.activeToolCalls ?? new Map(), {
      threadId: input.thread.id,
      runId: input.runId,
      assistantMessageId: options.messageId,
      finishedAt: timestamp,
      failRunningToolCalls: true
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

function bindActiveToolCallsToAssistant(
  deps: Pick<AcpChatRunDeps, 'storage' | 'emit'>,
  activeToolCalls: Map<string, ToolCallRecord>,
  input: {
    threadId: string
    runId: string
    assistantMessageId: string
    finishedAt: string
    failRunningToolCalls: boolean
  }
): void {
  for (const toolCall of activeToolCalls.values()) {
    const needsTerminalStatus =
      input.failRunningToolCalls && toolCall.status !== 'completed' && toolCall.status !== 'failed'
    const bound: ToolCallRecord = {
      ...toolCall,
      assistantMessageId: input.assistantMessageId,
      ...(needsTerminalStatus ? { status: 'failed' as const, finishedAt: input.finishedAt } : {})
    }
    deps.storage.updateToolCall(bound)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: bound
    })
  }
}

function extractTextFromAcpContent(
  content: Array<{ type: string; content?: { type: string; text?: string } }> | null | undefined
): string | undefined {
  if (!content || content.length === 0) return undefined
  const texts = content
    .filter((item) => item.type === 'content' && item.content?.type === 'text')
    .map((item) => item.content?.text ?? '')
    .filter(Boolean)
  if (texts.length === 0) return undefined
  const joined = texts.join('\n')
  return joined.length > 240 ? joined.slice(0, 237) + '...' : joined
}
