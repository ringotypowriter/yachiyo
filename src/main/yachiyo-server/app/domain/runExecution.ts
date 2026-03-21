import type {
  HarnessFinishedEvent,
  HarnessStartedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  ProviderSettings,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  SettingsConfig,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallName,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../shared/yachiyo/protocol.ts'
import { collectMessagePath } from '../../../../shared/yachiyo/threadTree.ts'
import { prepareModelMessages } from '../../runtime/messagePrepare.ts'
import {
  buildToolAvailabilityReminderSection,
  formatQueryReminder,
  prependQueryReminderToLatestUserMessage
} from '../../runtime/queryReminder.ts'
import type { ModelRuntime } from '../../runtime/types.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import {
  createAgentToolSet,
  normalizeToolResult,
  summarizeToolInput
} from '../../tools/agentTools.ts'
import {
  DEFAULT_HARNESS_NAME,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'

export interface ExecuteRunInput {
  enabledTools: ToolCallName[]
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  abortController: AbortController
  updateHeadOnComplete: boolean
  previousEnabledTools: ToolCallName[] | null
}

export interface RestartRunReason {
  type: 'restart'
  nextRequestMessageId: string
}

export type ExecuteRunResult =
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'restarted'; nextRequestMessageId: string }

export interface RunExecutionDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  webSearchService?: WebSearchService
  readThread: (threadId: string) => ThreadRecord
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  loadThreadMessages: (threadId: string) => MessageRecord[]
  onEnabledToolsUsed: (enabledTools: ToolCallName[]) => void
  onTerminalState?: () => void
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRestartRunReason(value: unknown): value is RestartRunReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'restart' &&
    typeof (value as { nextRequestMessageId?: unknown }).nextRequestMessageId === 'string'
  )
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return
  }

  const error = new Error('Aborted')
  error.name = 'AbortError'
  throw error
}

function buildAgentInstructions(workspacePath: string, enabledTools: ToolCallName[]): string {
  const instructions = [
    'You are operating as a tool-using local agent.',
    'Default execution mode is YOLO: use tools directly for normal local work instead of asking for per-step confirmation.',
    `The current thread workspace is ${workspacePath}.`,
    'Relative paths should resolve from that workspace unless you intentionally use an absolute path.'
  ]

  if (enabledTools.length === 0) {
    instructions.push('No tools are available for this run. Respond without tool calls.')
    return instructions.join('\n')
  }

  instructions.push(`Available tools: ${enabledTools.join(', ')}.`)

  if (enabledTools.includes('bash')) {
    instructions.push('Use bash for shell commands when shell execution is the clearest path.')
  }

  if (
    enabledTools.some(
      (toolName) => toolName === 'read' || toolName === 'write' || toolName === 'edit'
    )
  ) {
    instructions.push(
      'Use read, write, or edit for direct file work when that is clearer than shell commands.'
    )
  }

  if (enabledTools.includes('webRead')) {
    instructions.push(
      'Use webRead for static HTTP(S) pages when you need readable extracted content. It is not a browser automation or JS-rendering tool.'
    )
  }

  if (enabledTools.includes('webSearch')) {
    instructions.push(
      'Use webSearch for general search results across the web. It returns normalized search hits, not arbitrary browser automation.'
    )
  }

  return instructions.join('\n')
}

function loadRunHistory(
  loadThreadMessages: RunExecutionDeps['loadThreadMessages'],
  threadId: string,
  requestMessageId: string
): Array<Pick<MessageRecord, 'content' | 'images' | 'role'>> {
  return collectMessagePath(loadThreadMessages(threadId), requestMessageId).map(
    ({ content, images, role }) => ({
      content,
      ...(images ? { images } : {}),
      role
    })
  )
}

function finishPendingToolCalls(
  deps: Pick<RunExecutionDeps, 'emit' | 'storage'>,
  toolCalls: Map<string, ToolCallRecord>,
  input: { threadId: string; runId: string; finishedAt: string; error: string }
): void {
  for (const current of toolCalls.values()) {
    if (current.status !== 'running') {
      continue
    }

    const nextToolCall: ToolCallRecord = {
      ...current,
      status: 'failed',
      outputSummary: input.error,
      error: input.error,
      finishedAt: input.finishedAt
    }

    toolCalls.set(nextToolCall.id, nextToolCall)
    deps.storage.updateToolCall(nextToolCall)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: nextToolCall
    })
  }
}

export async function executeServerRun(
  deps: RunExecutionDeps,
  input: ExecuteRunInput
): Promise<ExecuteRunResult> {
  const settings = deps.readSettings()
  const harnessId = deps.createId()
  const messageId = deps.createId()
  const toolCalls = new Map<string, ToolCallRecord>()
  let buffer = ''

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

  try {
    const workspacePath = await deps.ensureThreadWorkspace(input.thread.id)
    const runtime = deps.createModelRuntime()
    const hiddenQueryReminder = formatQueryReminder(
      [
        ...(input.previousEnabledTools
          ? [
              buildToolAvailabilityReminderSection({
                previousEnabledTools: input.previousEnabledTools,
                enabledTools: input.enabledTools
              })
            ]
          : [])
      ].flatMap((section) => (section ? [section] : []))
    )
    const history = prependQueryReminderToLatestUserMessage(
      loadRunHistory(deps.loadThreadMessages, input.thread.id, input.requestMessageId),
      hiddenQueryReminder
    )
    const messages = prepareModelMessages({
      history,
      agentInstructions: buildAgentInstructions(workspacePath, input.enabledTools)
    })
    const tools = createAgentToolSet(
      {
        enabledTools: input.enabledTools,
        workspacePath
      },
      {
        webSearchService: deps.webSearchService
      }
    )
    deps.onEnabledToolsUsed(input.enabledTools)

    for await (const delta of runtime.streamReply({
      messages,
      settings,
      signal: input.abortController.signal,
      ...(tools ? { tools } : {}),
      onToolCallStart: (event) => {
        const toolCall: ToolCallRecord = {
          id: event.toolCall.toolCallId,
          runId: input.runId,
          threadId: input.thread.id,
          requestMessageId: input.requestMessageId,
          assistantMessageId: messageId,
          toolName: event.toolCall.toolName as ToolCallRecord['toolName'],
          status: 'running',
          inputSummary: summarizeToolInput(
            event.toolCall.toolName as ToolCallRecord['toolName'],
            event.toolCall.input
          ),
          startedAt: deps.timestamp()
        }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.createToolCall(toolCall)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallUpdate: (event) => {
        const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
        if (!startedToolCall) {
          return
        }

        const toolName = event.toolCall.toolName as ToolCallRecord['toolName']
        const normalized = normalizeToolResult(toolName, event.output, { phase: 'update' })
        const toolCall: ToolCallRecord = {
          ...startedToolCall,
          status: 'running',
          ...(normalized.outputSummary ? { outputSummary: normalized.outputSummary } : {}),
          ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
          ...(normalized.details ? { details: normalized.details } : {})
        }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.updateToolCall(toolCall)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallFinish: (event) => {
        const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
        const toolName = event.toolCall.toolName as ToolCallRecord['toolName']
        const finishedAt = deps.timestamp()
        const normalized = event.success ? normalizeToolResult(toolName, event.output) : undefined
        const errorMessage =
          normalized?.error ??
          (event.success || event.error === undefined
            ? undefined
            : event.error instanceof Error
              ? event.error.message
              : String(event.error))
        const toolCall: ToolCallRecord = startedToolCall
          ? {
              ...startedToolCall,
              status: normalized?.status ?? 'failed',
              outputSummary: normalized?.outputSummary ?? errorMessage,
              ...(normalized?.cwd ? { cwd: normalized.cwd } : {}),
              ...(normalized?.details ? { details: normalized.details } : {}),
              ...(errorMessage ? { error: errorMessage } : {}),
              finishedAt
            }
          : {
              id: event.toolCall.toolCallId,
              runId: input.runId,
              threadId: input.thread.id,
              requestMessageId: input.requestMessageId,
              assistantMessageId: messageId,
              toolName,
              status: normalized?.status ?? 'failed',
              inputSummary: summarizeToolInput(toolName, event.toolCall.input),
              outputSummary: normalized?.outputSummary ?? errorMessage,
              ...(normalized?.cwd ? { cwd: normalized.cwd } : {}),
              ...(normalized?.details ? { details: normalized.details } : {}),
              ...(errorMessage ? { error: errorMessage } : {}),
              startedAt: finishedAt,
              finishedAt
            }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.updateToolCall(toolCall)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      }
    })) {
      throwIfAborted(input.abortController.signal)

      if (!delta) continue
      buffer += delta
      deps.emit<MessageDeltaEvent>({
        type: 'message.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta
      })
    }

    throwIfAborted(input.abortController.signal)

    const timestamp = deps.timestamp()
    const assistantMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: buffer,
      status: 'completed',
      createdAt: timestamp,
      modelId: settings.model,
      providerName: settings.providerName
    }
    const currentThread = deps.readThread(input.thread.id)

    const updatedThread: ThreadRecord = {
      ...currentThread,
      updatedAt: timestamp,
      ...(input.updateHeadOnComplete
        ? { preview: assistantMessage.content.slice(0, 240) }
        : currentThread.preview
          ? { preview: currentThread.preview }
          : {}),
      ...(input.updateHeadOnComplete
        ? { headMessageId: assistantMessage.id }
        : currentThread.headMessageId
          ? { headMessageId: currentThread.headMessageId }
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
    if (input.abortController.signal.aborted || isAbortError(error)) {
      const restartReason = input.abortController.signal.reason
      const timestamp = deps.timestamp()
      finishPendingToolCalls(deps, toolCalls, {
        error: isRestartRunReason(restartReason)
          ? 'Superseded by a steer message before the tool call finished.'
          : 'Run cancelled before the tool call finished.',
        finishedAt: timestamp,
        runId: input.runId,
        threadId: input.thread.id
      })

      if (isRestartRunReason(restartReason)) {
        deps.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'cancelled'
        })
        return {
          kind: 'restarted',
          nextRequestMessageId: restartReason.nextRequestMessageId
        }
      }

      deps.storage.cancelRun({
        runId: input.runId,
        completedAt: timestamp
      })
      deps.onTerminalState?.()

      deps.emit<HarnessFinishedEvent>({
        type: 'harness.finished',
        threadId: input.thread.id,
        runId: input.runId,
        harnessId,
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

    const message = error instanceof Error ? error.message : 'Unknown model runtime error'
    const timestamp = deps.timestamp()
    finishPendingToolCalls(deps, toolCalls, {
      error: message,
      finishedAt: timestamp,
      runId: input.runId,
      threadId: input.thread.id
    })
    deps.storage.failRun({
      runId: input.runId,
      completedAt: timestamp,
      error: message
    })
    deps.onTerminalState?.()

    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'failed',
      error: message
    })
    deps.emit<RunFailedEvent>({
      type: 'run.failed',
      threadId: input.thread.id,
      runId: input.runId,
      error: message
    })
    return { kind: 'failed' }
  }
}
