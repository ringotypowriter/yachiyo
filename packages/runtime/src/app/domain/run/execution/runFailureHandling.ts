import type {
  MessageCompletedEvent,
  MessageTextBlockRecord,
  ProviderSettings,
  RunFailedEvent,
  RunRetryingEvent,
  ThreadUpdatedEvent
} from '@yachiyo/shared/protocol'
import { RETRY_MAX_ATTEMPTS } from '../../../../runtime/models/modelRuntime.ts'
import { isRetryableRunError } from '../../../../runtime/models/runtimeErrors.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { balanceRecoveryResponseMessages, type RecoveryResponseMessage } from '../runRecovery.ts'
import { usageFieldsFrom } from '../runUsageFields.ts'
import { finishPendingToolCalls } from '../tools/toolCallLifecycle.ts'
import { finalizeRunSnapshot } from './runSnapshotFinalize.ts'
import { mergeRunUsage } from './runUsage.ts'
import type { PersistRecoveryCheckpointOptions } from './recoveryCheckpointManager.ts'
import { persistTerminalAssistantMessage } from './terminalPersistence.ts'
import type { RunToolLifecycleState } from './runToolLifecycleState.ts'
import type { ExecuteRunInput, ExecuteRunResult, RunExecutionDeps } from './runExecutionTypes.ts'
import type { RunExecutionPhase } from '../runTypes.ts'

const FRIENDLY_ERROR_LABELS: Array<[test: RegExp | string, label: string]> = [
  ['ERR_HTTP2_PROTOCOL_ERROR', 'Connection interrupted (HTTP/2 stream reset)'],
  ['ECONNRESET', 'Connection reset by server'],
  ['ETIMEDOUT', 'Connection timed out'],
  ['ECONNREFUSED', 'Connection refused'],
  ['ENOTFOUND', 'Could not resolve host'],
  ['ENETDOWN', 'Network is down'],
  ['ENETUNREACH', 'Network is unreachable'],
  ['ENETRESET', 'Network connection reset'],
  ['EHOSTUNREACH', 'Host is unreachable'],
  ['ERR_CONNECTION_CLOSED', 'Connection closed unexpectedly'],
  ['ERR_CONNECTION_RESET', 'Connection reset by server'],
  ['ERR_CONNECTION_REFUSED', 'Connection refused'],
  ['ERR_CONNECTION_ABORTED', 'Connection aborted'],
  ['ERR_CONNECTION_FAILED', 'Connection failed'],
  ['ERR_EMPTY_RESPONSE', 'Server closed the connection without a response'],
  ['ERR_NAME_RESOLUTION_FAILED', 'Could not resolve host'],
  ['ERR_QUIC_PROTOCOL_ERROR', 'Connection interrupted (QUIC protocol error)'],
  ['ECONNABORTED', 'Connection aborted'],
  ['UND_ERR_HEADERS_TIMEOUT', 'Response timed out (headers)'],
  ['UND_ERR_BODY_TIMEOUT', 'Response timed out (body)'],
  ['ERR_NETWORK_CHANGED', 'Network changed during request'],
  ['ERR_INTERNET_DISCONNECTED', 'Internet connection lost'],
  ['ERR_SSL_PROTOCOL_ERROR', 'Secure connection interrupted (TLS handshake failed)'],
  ['ERR_CONNECTION_TIMED_OUT', 'Connection timed out'],
  ['ERR_TIMED_OUT', 'Connection timed out'],
  ['ERR_NAME_NOT_RESOLVED', 'Could not resolve host'],
  ['ERR_ADDRESS_UNREACHABLE', 'Host is unreachable'],
  ['EPIPE', 'Connection dropped (broken pipe)'],
  ['EAI_AGAIN', 'Temporary DNS failure'],
  ['UND_ERR_SOCKET', 'Socket error'],
  ['UND_ERR_CONNECT_TIMEOUT', 'Connection timed out'],
  [/socket hang up/i, 'Connection dropped (socket hang up)'],
  [/fetch failed/i, 'Network request failed']
]

interface RunFailureOutputSnapshot {
  content: string
  reasoning?: string
  textBlocks: MessageTextBlockRecord[]
  recoveryResponseMessages: RecoveryResponseMessage[]
}

interface HandleRunFailureInput {
  bindCurrentRunToolCallsToAssistant: (assistantMessageId: string) => void
  deps: RunExecutionDeps
  error: unknown
  executionInput: ExecuteRunInput
  flushDeltas: () => void
  getOutputSnapshot: () => RunFailureOutputSnapshot
  lastUsage?: ModelUsage
  messageId: string
  perfCollector: RunPerfCollector
  persistRecoveryCheckpoint: (
    options?: PersistRecoveryCheckpointOptions
  ) => RunRecoveryCheckpoint | undefined
  recoveryAttempts: number
  setExecutionPhase: (phase: RunExecutionPhase) => void
  settings: ProviderSettings
  snapshotTracker: SnapshotTracker | null
  toolLifecycle: RunToolLifecycleState
}

export async function handleRunFailure(input: HandleRunFailureInput): Promise<ExecuteRunResult> {
  const message = extractRetryErrorMessage(input.error) || 'Unknown model runtime error'
  const nextRecoveryAttempt = input.recoveryAttempts + 1
  if (
    input.executionInput.requestMessageId &&
    isRetryableRunError(input.error) &&
    nextRecoveryAttempt < RETRY_MAX_ATTEMPTS
  ) {
    input.flushDeltas()
    input.toolLifecycle.clearRunningToolCalls()
    input.setExecutionPhase('generating')
    finishInterruptedToolCalls(input, input.deps.timestamp(), {
      error: 'Tool execution was interrupted before completion.'
    })

    const checkpoint = input.persistRecoveryCheckpoint({
      lastError: message,
      recoveryAttempts: nextRecoveryAttempt
    })
    if (checkpoint) {
      input.deps.emit<RunRetryingEvent>({
        type: 'run.retrying',
        threadId: input.executionInput.thread.id,
        runId: input.executionInput.runId,
        attempt: checkpoint.recoveryAttempts,
        maxAttempts: RETRY_MAX_ATTEMPTS,
        delayMs: Math.min(1_000 * 2 ** Math.max(0, checkpoint.recoveryAttempts - 1), 30_000),
        error: message
      })
      return {
        kind: 'recovering',
        checkpoint
      }
    }
  }

  return failRun(input, message)
}

export function extractRetryErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return humanizeErrorMessage(String(error))
  const status = readHttpStatus(error)
  const code = (error as { code?: string }).code
  if (code) {
    const label = humanizeErrorMessage(code)
    if (label !== code) return label
  }
  if (error.message) {
    const message = humanizeErrorMessage(error.message)
    return status ? appendHttpStatus(message, status) : message
  }
  return status ? humanizeErrorMessage(`HTTP ${status}`) : 'Provider error'
}

async function failRun(input: HandleRunFailureInput, message: string): Promise<ExecuteRunResult> {
  const timestamp = input.deps.timestamp()
  input.flushDeltas()
  finishInterruptedToolCalls(input, timestamp, { error: message })

  if (input.executionInput.requestMessageId) {
    await persistFailedAssistantMessage(input, timestamp)
  }

  const failUsage = mergeRunUsage(input.executionInput.priorUsage, input.lastUsage)
  input.deps.onExecutionPhaseChange?.('terminal')
  input.deps.storage.failRun({
    runId: input.executionInput.runId,
    completedAt: timestamp,
    error: message,
    ...usageFieldsFrom(failUsage)
  })

  await finalizeRunSnapshot({
    deps: input.deps,
    runId: input.executionInput.runId,
    snapshotTracker: input.snapshotTracker,
    threadId: input.executionInput.thread.id,
    perfCollector: input.perfCollector
  })

  input.deps.onTerminalState?.()
  input.deps.emit<RunFailedEvent>({
    type: 'run.failed',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    requestMessageId: input.executionInput.requestMessageId,
    error: message
  })
  input.perfCollector.finish(input.executionInput.thread.id)
  return { kind: 'failed', usage: failUsage }
}

async function persistFailedAssistantMessage(
  input: HandleRunFailureInput,
  timestamp: string
): Promise<void> {
  const snapshot = input.getOutputSnapshot()
  const failedResponseMessages =
    snapshot.recoveryResponseMessages.length > 0
      ? balanceRecoveryResponseMessages(
          snapshot.recoveryResponseMessages,
          input.toolLifecycle.getAllToolCalls()
        )
      : snapshot.recoveryResponseMessages
  const failedMessage = persistTerminalAssistantMessage(input.deps, {
    runId: input.executionInput.runId,
    threadId: input.executionInput.thread.id,
    messageId: input.messageId,
    requestMessageId: input.executionInput.requestMessageId,
    timestamp,
    settings: input.settings,
    status: 'failed',
    content: snapshot.content,
    textBlocks: snapshot.textBlocks,
    ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
    ...(failedResponseMessages.length > 0 ? { responseMessages: failedResponseMessages } : {})
  })
  input.bindCurrentRunToolCallsToAssistant(input.messageId)
  await input.deps.onAssistantMessagePersisted?.(failedMessage.id)
  input.deps.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    message: failedMessage
  })
  const currentThread = input.deps.readThread(input.executionInput.thread.id)
  input.deps.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: input.executionInput.thread.id,
    thread: { ...currentThread, updatedAt: timestamp }
  })
}

function finishInterruptedToolCalls(
  input: HandleRunFailureInput,
  timestamp: string,
  options: { error: string }
): void {
  finishPendingToolCalls(input.deps, input.toolLifecycle.toolCalls, {
    error: options.error,
    finishedAt: timestamp,
    runId: input.executionInput.runId,
    threadId: input.executionInput.thread.id
  })
}

function humanizeErrorMessage(raw: string): string {
  for (const [test, label] of FRIENDLY_ERROR_LABELS) {
    if (typeof test === 'string' ? raw.includes(test) : test.test(raw)) return label
  }
  const httpStatusMatch = /^HTTP (\d{3})$/.exec(raw)
  if (httpStatusMatch) {
    return httpStatusMatch[1] === '401' ? `Authentication failed (${raw})` : `Server error (${raw})`
  }
  return raw
}

function readHttpStatus(error: Error): number | undefined {
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') return status
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

function appendHttpStatus(message: string, status: number): string {
  const httpStatus = `HTTP ${status}`
  return message.includes(httpStatus) ? message : `${message} (${httpStatus})`
}
