import { tool, type Tool } from 'ai'

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { BashToolCallDetails } from '@yachiyo/shared/protocol'
import {
  isReadOnlyBashSemanticGroup,
  resolveBashSemanticGroup
} from '@yachiyo/shared/bashSemanticAnalyzer'

import type { ProcessBroker, ProcessJob } from '../../services/processBroker/processBroker.ts'
import { extractBashTargetFiles } from '../../services/fileSnapshot/bashTargetExtractor.ts'
import { validateBashCommand } from './bashSecurity.ts'
import { getChainedSleepTimeoutBlockMessage } from './bashTimeoutGuard.ts'
import { withInjectedEnv } from './injectedEnv.ts'
import { extractBashReadRanges } from './bashReadExtractor.ts'
import {
  bashToolInputSchema,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_DETAILS_OUTPUT_CHARS,
  MAX_BASH_MODEL_OUTPUT_CHARS,
  type AgentToolContext,
  type BashRunner,
  type BashToolInput,
  type BashToolOutput,
  type ToolContentBlock,
  takeTail,
  raceAgainstSignal,
  textContent,
  toToolModelOutput,
  truncateForDetails
} from './shared.ts'

export function createTool(context: AgentToolContext): Tool<BashToolInput, BashToolOutput> {
  return tool({
    description:
      `Run a shell command with cwd set to ${context.workspacePath}. Use timeout in seconds; set it longer than the whole command, including sleeps and waits, or use background mode for intentionally long work.\n` +
      'Always provide a `description`: a short, present-tense, user-facing summary of what this command does (e.g. "List files in the current directory", "Run the linter"). It is shown to the user in place of the raw command.\n' +
      'Do not chain follow-up work after a sleep that is longer than or equal to the timeout; the follow-up command cannot run before the timeout fires.\n' +
      'Do NOT use bash for searching code or finding files — use the `grep` tool (content search) or `glob` tool (file discovery) instead. They are faster, produce structured output, and respect workspace boundaries.',
    inputSchema: bashToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      streamBashTool(input, context, {
        abortSignal: options.abortSignal,
        toolCallId: options.toolCallId
      })
  })
}

function appendTail(value: string, chunk: string, maxChars: number): string {
  return takeTail(`${value}${chunk}`, maxChars).text
}

function summarizeCombinedBashOutput(value: string): string {
  return value
}

function toAbortError(reason: unknown, fallbackMessage: string): Error {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallbackMessage
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function buildBashContent(input: {
  combinedOutput: string
  error?: string
  exitCode?: number
  outputFilePath?: string
  preliminary?: boolean
}): { content: ToolContentBlock[]; truncated: boolean } {
  const baseText = summarizeCombinedBashOutput(input.combinedOutput)

  if (baseText.length > 0) {
    const tail = takeTail(baseText, MAX_BASH_MODEL_OUTPUT_CHARS)

    if (input.outputFilePath && !input.preliminary) {
      return {
        content: textContent(
          `Output too large to inline. Full output saved to ${input.outputFilePath}.\nUse the read tool to read it.`
        ),
        truncated: true
      }
    }

    const note = ''

    return {
      content: textContent(`${tail.text}${note}`),
      truncated: tail.truncated
    }
  }

  if (input.preliminary) {
    return {
      content: [],
      truncated: false
    }
  }

  if (input.error) {
    return {
      content: textContent(input.error),
      truncated: false
    }
  }

  return {
    content: textContent(`Command exited ${input.exitCode ?? 0} with no output.`),
    truncated: false
  }
}

function createBashResult(input: {
  command: string
  description?: string
  cwd: string
  combinedOutput?: string
  stdout: string
  stderr: string
  exitCode?: number
  blocked?: boolean
  timedOut?: boolean
  error?: string
  outputFilePath?: string
  preliminary?: boolean
}): BashToolOutput {
  const combinedOutput = input.combinedOutput ?? `${input.stdout}${input.stderr}`
  const stdoutTail = truncateForDetails(input.stdout)
  const stderrTail = truncateForDetails(input.stderr)
  const content = buildBashContent({
    combinedOutput,
    error: input.error,
    exitCode: input.exitCode,
    outputFilePath: input.outputFilePath,
    preliminary: input.preliminary
  })
  const truncated =
    content.truncated ||
    stdoutTail.truncated ||
    stderrTail.truncated ||
    Boolean(input.outputFilePath)

  const details: BashToolCallDetails = {
    command: input.command,
    ...(input.description ? { description: input.description } : {}),
    cwd: input.cwd,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    stdout: stdoutTail.text,
    stderr: stderrTail.text,
    ...(truncated ? { truncated: true } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.blocked ? { blocked: true } : {}),
    ...(input.outputFilePath ? { outputFilePath: input.outputFilePath } : {})
  }

  return {
    content: content.content,
    details,
    ...(input.error ? { error: input.error } : {}),
    metadata: {
      cwd: input.cwd,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(truncated ? { truncated: true } : {}),
      ...(input.blocked ? { blocked: true } : {}),
      ...(input.timedOut ? { timedOut: true } : {}),
      ...(input.outputFilePath ? { outputFilePath: input.outputFilePath } : {})
    }
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    reject: (error: unknown) => void
    resolve: (value: IteratorResult<T>) => void
  }> = []
  private closed = false
  private error: unknown

  push(value: T): void {
    if (this.closed || this.error !== undefined) {
      return
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value })
      return
    }

    this.values.push(value)
  }

  close(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.error !== undefined) {
      return
    }

    this.error = error
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(error)
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T
        continue
      }

      if (this.error !== undefined) {
        throw this.error
      }

      if (this.closed) {
        return
      }

      const nextResult = Promise.withResolvers<IteratorResult<T>>()
      this.waiters.push({ reject: nextResult.reject, resolve: nextResult.resolve })
      const next = await nextResult.promise

      if (next.done) {
        return
      }

      yield next.value
    }
  }
}

// Re-export for backward compatibility
export { isBlockedBashCommand, isSelfLaunchCommand } from './bashSecurity.ts'

function createProcessBrokerBashRunner(processBroker: ProcessBroker): BashRunner {
  return async ({
    abortSignal,
    command,
    cwd,
    env,
    jobId,
    logPath,
    onStderr,
    onStdout,
    onOutputBatch,
    onTimeoutLift,
    retainLog,
    spillThresholdChars,
    timeoutSeconds
  }) => {
    if (abortSignal?.aborted) {
      throw toAbortError(abortSignal.reason, 'Tool execution aborted.')
    }

    const startingJob = processBroker.startJob({
      id: jobId,
      command,
      cwd,
      env,
      logPath,
      timeoutSeconds,
      keepRunningOnTimeout: onTimeoutLift !== undefined,
      retainLog,
      spillThresholdChars
    })
    let job: ProcessJob
    if (abortSignal) {
      try {
        job = await raceAgainstSignal(startingJob, abortSignal)
      } catch (error) {
        if (!abortSignal.aborted) throw error
        void startingJob.then(
          (lateJob) => {
            lateJob.cancel()
            void lateJob.wait().catch(() => {})
            void lateJob.waitForOutcome().catch(() => {})
          },
          () => {}
        )
        throw toAbortError(abortSignal.reason, 'Tool execution aborted.')
      }
    } else {
      job = await startingJob
    }
    let stdout = ''
    let stderr = ''
    let aborted = false
    let lifted = false
    const unsubscribeOutput = job.onOutput((batch) => {
      for (const chunk of batch.chunks) {
        if (chunk.stream === 'stdout') {
          if (!onStdout) stdout = appendTail(stdout, chunk.text, MAX_BASH_DETAILS_OUTPUT_CHARS)
          onStdout?.(chunk.text)
        } else {
          if (!onStderr) stderr = appendTail(stderr, chunk.text, MAX_BASH_DETAILS_OUTPUT_CHARS)
          onStderr?.(chunk.text)
        }
      }
      onOutputBatch?.()
    })
    const handleAbort = (): void => {
      aborted = true
      job.cancel()
    }
    abortSignal?.addEventListener('abort', handleAbort, { once: true })
    if (abortSignal?.aborted) handleAbort()

    try {
      const outcome = await job.waitForOutcome()
      if (aborted) {
        await job.wait().catch(() => {})
        throw toAbortError(abortSignal?.reason, 'Tool execution aborted.')
      }

      if (outcome.kind === 'timed-out') {
        if (onTimeoutLift) {
          abortSignal?.removeEventListener('abort', handleAbort)
          if (await onTimeoutLift(job)) {
            lifted = true
            return {
              exitCode: 0,
              stderr,
              stdout,
              lifted: true,
              spilled: true
            }
          }
          job.cancel()
        }

        const result = await job.wait()
        return {
          exitCode: result.exitCode,
          stderr,
          stdout,
          timedOut: true,
          spilled: result.spilled,
          ...(result.error ? { error: result.error } : {})
        }
      }

      return {
        exitCode: outcome.result.exitCode,
        stderr,
        stdout,
        ...(outcome.result.timedOut ? { timedOut: true } : {}),
        ...(outcome.result.spilled ? { spilled: true } : {}),
        ...(outcome.result.error ? { error: outcome.result.error } : {})
      }
    } finally {
      unsubscribeOutput()
      if (!lifted) abortSignal?.removeEventListener('abort', handleAbort)
    }
  }
}

export async function* streamBashTool(
  input: BashToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal; runCommand?: BashRunner; toolCallId?: string } = {}
): AsyncIterable<BashToolOutput> {
  const queue = new AsyncQueue<BashToolOutput>()
  const command = input.command.trim()
  const description = input.description.trim()
  const timeoutSeconds = input.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS

  const securityCheck = validateBashCommand(command)

  // Plan Mode: bash is restricted to read-only commands (search, read).
  if (context.runMode === 'plan') {
    const semanticGroup = resolveBashSemanticGroup(command)
    if (!isReadOnlyBashSemanticGroup(semanticGroup)) {
      queue.push(
        createBashResult({
          command,
          description,
          combinedOutput: '',
          cwd: context.workspacePath,
          stdout: '',
          stderr: '',
          blocked: true,
          error: `This bash command is classified as '${semanticGroup}' and is not allowed in Plan Mode. Only read-only commands (search-files, read-files) are permitted. Use the grep, glob, or read tools instead, or switch to Auto Mode to execute this command.`
        })
      )
      queue.close()
      yield* queue.iterate()
      return
    }
  }

  // Background mode: the manager asks the resident native broker to start and own the job.
  if (input.background && !securityCheck.blocked) {
    const taskId = options.toolCallId ?? randomUUID()
    const logPath = join(context.workspacePath, '.yachiyo', 'tool-output', `${taskId}.log`)
    const startBackgroundTask = context.onBackgroundBashStarted
    if (!startBackgroundTask) {
      yield createBashResult({
        command,
        description,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        error: 'Background Bash execution is unavailable in this runtime.'
      })
      return
    }

    try {
      await startBackgroundTask({
        taskId,
        command,
        description,
        cwd: context.workspacePath,
        env: withInjectedEnv(process.env, { runId: context.runId }),
        logPath,
        toolCallId: options.toolCallId
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background task failed to start.'
      yield createBashResult({
        command,
        description,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        error: message
      })
      return
    }

    const handle = { taskId, logPath }
    yield {
      content: [{ type: 'text', text: JSON.stringify(handle) }],
      details: {
        command,
        description,
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        background: true,
        taskId,
        logPath
      },
      metadata: { cwd: context.workspacePath }
    }
    return
  }

  if (securityCheck.blocked) {
    queue.push(
      createBashResult({
        command,
        description,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        blocked: true,
        error: securityCheck.message
      })
    )
    queue.close()
    yield* queue.iterate()
    return
  }

  const sleepTimeoutBlockMessage = getChainedSleepTimeoutBlockMessage(command, timeoutSeconds)
  if (sleepTimeoutBlockMessage) {
    queue.push(
      createBashResult({
        command,
        description,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        blocked: true,
        error: sleepTimeoutBlockMessage
      })
    )
    queue.close()
    yield* queue.iterate()
    return
  }

  let stdout = ''
  let stderr = ''
  let combinedOutput = ''
  let sawStreamChunks = false
  const taskId = options.toolCallId ?? randomUUID()
  const logPath = join(context.workspacePath, '.yachiyo', 'tool-output', `${taskId}.log`)

  const pushPreliminary = (): void => {
    queue.push(
      createBashResult({
        command,
        combinedOutput,
        cwd: context.workspacePath,
        stdout,
        stderr,
        preliminary: true
      })
    )
  }

  const appendChunk = (
    streamName: 'stdout' | 'stderr',
    chunk: string,
    emitUpdate: boolean
  ): void => {
    sawStreamChunks = true
    if (streamName === 'stdout') {
      stdout = appendTail(stdout, chunk, MAX_BASH_DETAILS_OUTPUT_CHARS)
    } else {
      stderr = appendTail(stderr, chunk, MAX_BASH_DETAILS_OUTPUT_CHARS)
    }
    combinedOutput = appendTail(combinedOutput, chunk, MAX_BASH_MODEL_OUTPUT_CHARS)
    if (emitUpdate) pushPreliminary()
  }

  let liftedHandle: { taskId: string; logPath: string } | undefined

  void (async () => {
    try {
      // Layer 2: Pre-backup files that bash might modify
      if (context.snapshotTracker) {
        try {
          const targets = extractBashTargetFiles(command, context.workspacePath)
          for (const target of targets) {
            await context.snapshotTracker.trackBeforeWrite(target)
          }
        } catch {
          // Don't block bash execution for snapshot errors
        }
      }

      let runner = options.runCommand
      if (!runner) {
        if (!context.processBroker) {
          throw new Error('Native process broker is unavailable for Bash execution.')
        }
        runner = createProcessBrokerBashRunner(context.processBroker)
      }
      const adoptHook = context.onBackgroundBashAdopted
      const result = await runner({
        abortSignal: options.abortSignal,
        jobId: taskId,
        command,
        cwd: context.workspacePath,
        env: withInjectedEnv(process.env, { runId: context.runId }),
        logPath,
        timeoutSeconds,
        retainLog: false,
        spillThresholdChars: MAX_BASH_MODEL_OUTPUT_CHARS,
        onStdout: (chunk) => appendChunk('stdout', chunk, false),
        onStderr: (chunk) => appendChunk('stderr', chunk, false),
        onOutputBatch: pushPreliminary,
        ...(adoptHook
          ? {
              onTimeoutLift: async (job) => {
                try {
                  await adoptHook({
                    taskId,
                    command,
                    description,
                    cwd: context.workspacePath,
                    logPath,
                    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
                    job,
                    initialOutput: combinedOutput
                  })
                  liftedHandle = { taskId, logPath }
                  return true
                } catch (error) {
                  console.warn('[yachiyo][bash] failed to adopt timed-out native job', {
                    taskId,
                    error: error instanceof Error ? error.message : String(error)
                  })
                  return false
                }
              }
            }
          : {})
      })

      if (liftedHandle) {
        const liftNotice =
          `[Notice] Command timed out after ${timeoutSeconds} second${timeoutSeconds === 1 ? '' : 's'} ` +
          `and has been converted to a background task.\n` +
          `Task ID: ${liftedHandle.taskId}\n` +
          `Log file: ${liftedHandle.logPath}\n\n` +
          `The command is still running in the background. ` +
          `Do NOT assume it has finished — you will receive a "[Background task completed]" ` +
          `message when it exits. Until then, you can read the log file to check partial output.`
        queue.push({
          content: [{ type: 'text', text: liftNotice }],
          details: {
            command,
            description,
            cwd: context.workspacePath,
            stdout: truncateForDetails(stdout).text,
            stderr: truncateForDetails(stderr).text,
            background: true,
            taskId: liftedHandle.taskId,
            logPath: liftedHandle.logPath,
            liftedAfterTimeout: true
          },
          metadata: { cwd: context.workspacePath }
        })
        queue.close()
        return
      }

      if (!sawStreamChunks) {
        if (result.stdout) appendChunk('stdout', result.stdout, false)
        if (result.stderr) appendChunk('stderr', result.stderr, false)
      }

      if (result.exitCode === 0 && !result.timedOut && !result.spilled && context.readRecordCache) {
        try {
          const reads = await extractBashReadRanges(command, context.workspacePath)
          for (const read of reads) {
            const mtimeMs = await stat(read.resolvedPath).then(
              (file) => file.mtimeMs,
              () => undefined
            )
            if (read.endLine === 0) {
              context.readRecordCache.recordEmptyFileRead(read.resolvedPath, mtimeMs)
            } else {
              context.readRecordCache.recordRead(read.resolvedPath, 1, 1, mtimeMs)
            }
          }
        } catch {
          // Best-effort: don't fail the bash tool if read extraction fails.
        }
      }

      const error =
        result.error ??
        (result.timedOut
          ? `Command timed out after ${timeoutSeconds} second${timeoutSeconds === 1 ? '' : 's'}.`
          : result.exitCode === 0
            ? undefined
            : `Command exited with code ${result.exitCode}.`)

      queue.push(
        createBashResult({
          command,
          description,
          combinedOutput,
          cwd: context.workspacePath,
          exitCode: result.exitCode,
          stdout,
          stderr,
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(result.spilled ? { outputFilePath: logPath } : {}),
          ...(error ? { error } : {})
        })
      )
      queue.close()
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        queue.fail(error)
        return
      }

      const message = error instanceof Error ? error.message : 'Command failed.'
      queue.push(
        createBashResult({
          command,
          description,
          combinedOutput,
          cwd: context.workspacePath,
          stdout,
          stderr,
          error: message
        })
      )
      queue.close()
    }
  })()

  yield* queue.iterate()
}

export async function runBashTool(
  input: BashToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal; runCommand?: BashRunner; toolCallId?: string } = {}
): Promise<BashToolOutput> {
  let finalResult: BashToolOutput | undefined

  for await (const result of streamBashTool(input, context, options)) {
    finalResult = result
  }

  if (!finalResult) {
    throw new Error('Bash tool did not produce a final result.')
  }

  return finalResult
}
