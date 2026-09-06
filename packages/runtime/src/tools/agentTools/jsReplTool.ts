import { Worker, type Transferable } from 'node:worker_threads'

import type { JsReplToolCallDetails } from '@yachiyo/shared/protocol'
import { asSchema, type Tool, type ToolExecutionOptions } from 'ai'
import { isOrchestrationTool, orchestrationJson } from './jsReplOrchestrationKernel.ts'
import { formatToolInputValidationError } from './jsReplErrorFormat.ts'

import {
  DEFAULT_REPL_TIMEOUT_SECONDS,
  jsReplToolInputSchema,
  MAX_REPL_DETAILS_OUTPUT_CHARS,
  MAX_REPL_MODEL_OUTPUT_CHARS,
  type AgentToolContext,
  type JsReplToolInput,
  type JsReplToolOutput,
  takeTail,
  textContent,
  toToolModelOutput
} from './shared.ts'
import {
  createReplToolExecutionOptions,
  executeNestedReplTool,
  isReplToolName,
  resolveReplToolCwd
} from './replNestedTools.ts'
import type {
  JsReplSerializedError,
  JsReplWorkerFetchRequest,
  JsReplWorkerFetchResult,
  JsReplWorkerFetchSuccess,
  JsReplWorkerMessage
} from './jsReplWorkerProtocol.ts'

export interface JsReplToolDependencies {
  fetchImpl?: typeof globalThis.fetch
  resolveTool?: (name: string) => unknown
  listToolNames?: () => string[]
  workerPath?: string | URL
}

interface ActiveExecution {
  cwd: string
  options: ToolExecutionOptions
  abortController: AbortController
  calls: number
  running: number
  queue: Array<{ resolve(): void; reject(error: unknown): void }>
}

interface WorkerResult {
  result?: string
  consoleLines: string[]
  displayOutputs: string[]
  error?: string
  timedOut: boolean
  contextReset?: boolean
}

const WORKER_INIT_TIMEOUT_MS = 15_000
const WORKER_TIMEOUT_GRACE_MS = 100

function serializeError(error: unknown): JsReplSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    }
  }
  return { name: 'Error', message: String(error) }
}

async function runConfiguredFetch(
  fetchImpl: typeof globalThis.fetch,
  request: JsReplWorkerFetchRequest,
  signal: AbortSignal
): Promise<JsReplWorkerFetchSuccess> {
  const { bodyBase64, headers, ...init } = request.init
  const response = await fetchImpl(request.url, {
    ...init,
    ...(headers ? { headers } : {}),
    ...(bodyBase64 !== undefined ? { body: Buffer.from(bodyBase64, 'base64') } : {}),
    signal
  })
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    ...(response.body ? { body: response.body } : {}),
    url: response.url.length > 0 ? response.url : request.url,
    redirected: response.redirected,
    type: response.type
  }
}

class JsReplWorkerHandle {
  private worker: Worker | undefined
  private initialized = false
  private executeChain: Promise<unknown> = Promise.resolve()
  private readonly activeExecutions = new Map<string, ActiveExecution>()
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly workspacePath: string
  private readonly dependencies: JsReplToolDependencies
  private readonly mode: 'full' | 'orchestration'

  constructor(
    workspacePath: string,
    dependencies: JsReplToolDependencies,
    mode: 'full' | 'orchestration'
  ) {
    this.workspacePath = workspacePath
    this.dependencies = dependencies
    this.mode = mode
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  }

  private availableToolNames(): string[] {
    return [...new Set(this.dependencies.listToolNames?.() ?? [])]
      .filter((name) => !isReplToolName(name))
      .filter((name) => this.mode === 'full' || isOrchestrationTool(name))
      .sort()
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.initialized) return
    if (this.worker) await this.worker.terminate().catch(() => undefined)

    const worker = new Worker(
      this.dependencies.workerPath ?? new URL('./jsReplWorker.ts', import.meta.url),
      {
        name: 'yachiyo-js-repl'
      }
    )
    this.worker = worker
    this.initialized = false
    worker.on('message', (message: JsReplWorkerMessage) => {
      if (message.type === 'toolCall') void this.handleToolCall(worker, message)
      if (message.type === 'fetchCall') void this.handleFetchCall(worker, message)
    })

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('JavaScript REPL worker did not initialize in time.'))
      }, WORKER_INIT_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timeout)
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      const onMessage = (message: JsReplWorkerMessage): void => {
        if (message.type !== 'ready') return
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number): void => {
        cleanup()
        reject(new Error(`JavaScript REPL worker exited during initialization with code ${code}.`))
      }
      worker.on('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.postMessage({
        type: 'init',
        mode: this.mode,
        workspacePath: this.workspacePath,
        toolNames: this.availableToolNames()
      })
    })
    this.initialized = true
  }

  private async handleToolCall(
    worker: Worker,
    message: Extract<JsReplWorkerMessage, { type: 'toolCall' }>
  ): Promise<void> {
    const active = this.activeExecutions.get(message.runId)
    let acquired = false
    try {
      if (!active || worker !== this.worker)
        throw new Error('JavaScript REPL tool call no longer has an active cell.')
      active.abortController.signal.throwIfAborted()
      let input = message.input
      if (this.mode === 'orchestration') {
        if (!this.availableToolNames().includes(message.toolName))
          throw new Error(`Tool ${JSON.stringify(message.toolName)} is not available.`)
        if (++active.calls > 100) throw new Error('JavaScript cell exceeds 100 tool calls.')
        orchestrationJson(input)
        if (active.running >= 8)
          await new Promise<void>((resolve, reject) => active.queue.push({ resolve, reject }))
        else active.running++
        acquired = true
        active.abortController.signal.throwIfAborted()
        const nested = this.dependencies.resolveTool?.(message.toolName) as Tool | undefined
        const validate = nested && asSchema(nested.inputSchema).validate
        if (!validate) throw new Error('Tool input validation is unavailable.')
        const validated = await validate(input)
        if (!validated.success) {
          throw new Error(formatToolInputValidationError(message.toolName, validated.error))
        }
        input = validated.value
      }
      active.abortController.signal.throwIfAborted()
      const output = await executeNestedReplTool({
        replName: 'jsRepl',
        toolName: message.toolName,
        input,
        cwd: active.cwd,
        resolveTool: (name) => this.dependencies.resolveTool?.(name),
        executionOptions: active.options,
        signal: active.abortController.signal
      })
      active.abortController.signal.throwIfAborted()
      if (this.mode === 'orchestration') orchestrationJson(output)
      worker.postMessage({
        type: 'toolResult',
        runId: message.runId,
        callId: message.callId,
        result: { ok: true, value: output }
      })
    } catch (error) {
      try {
        worker.postMessage({
          type: 'toolResult',
          runId: message.runId,
          callId: message.callId,
          result: { ok: false, error: serializeError(error) }
        })
      } catch {
        // The cell may have timed out and terminated its worker.
      }
    } finally {
      if (active && acquired) {
        const next = active.queue.shift()
        if (next) next.resolve()
        else active.running--
      }
    }
  }

  private async handleFetchCall(
    worker: Worker,
    message: Extract<JsReplWorkerMessage, { type: 'fetchCall' }>
  ): Promise<void> {
    const active = this.activeExecutions.get(message.runId)
    let result: JsReplWorkerFetchResult
    try {
      if (this.mode === 'orchestration')
        throw new Error(
          'Direct fetch is unavailable in orchestration cells; use webRead or webSearch.'
        )
      if (!active) throw new Error('JavaScript REPL fetch no longer has an active cell.')
      result = await runConfiguredFetch(
        this.fetchImpl,
        message.request,
        active.abortController.signal
      )
    } catch (error) {
      result = { error: serializeError(error) }
    }
    try {
      const transferList: readonly Transferable[] =
        'body' in result && result.body ? [result.body as unknown as Transferable] : []
      worker.postMessage(
        {
          type: 'fetchResult',
          runId: message.runId,
          callId: message.callId,
          result
        },
        transferList
      )
    } catch {
      // The cell may have timed out and terminated its worker.
    }
  }

  async execute(input: {
    code: string
    cwd: string
    reset: boolean
    timeoutMs: number
    options: ToolExecutionOptions
  }): Promise<WorkerResult> {
    const execution = this.executeChain.then(async () => {
      await this.ensureWorker()
      const worker = this.worker!
      const runId = crypto.randomUUID()
      const abortController = new AbortController()
      const active: ActiveExecution = {
        cwd: input.cwd,
        options: input.options,
        abortController,
        calls: 0,
        running: 0,
        queue: []
      }
      abortController.signal.addEventListener(
        'abort',
        () => {
          for (const queued of active.queue.splice(0)) queued.reject(abortController.signal.reason)
        },
        { once: true }
      )
      this.activeExecutions.set(runId, active)

      return await new Promise<WorkerResult>((resolve, reject) => {
        let settled = false
        let expectedTermination = false
        const finish = (action: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          if (this.mode === 'orchestration')
            abortController.abort(new Error('JavaScript cell finished.'))
          this.activeExecutions.delete(runId)
          action()
        }
        const resetWorker = async (expected = false): Promise<void> => {
          if (expected) expectedTermination = true
          if (this.worker !== worker) return
          this.worker = undefined
          this.initialized = false
          await worker.terminate().catch(() => undefined)
        }
        const cleanup = (): void => {
          clearTimeout(timeout)
          worker.off('message', onMessage)
          worker.off('error', onError)
          worker.off('exit', onExit)
          input.options.abortSignal?.removeEventListener('abort', onAbort)
        }
        const timeout = setTimeout(() => {
          abortController.abort(new DOMException('JavaScript REPL timed out.', 'TimeoutError'))
          void resetWorker(true).finally(() => {
            finish(() =>
              resolve({
                consoleLines: [],
                displayOutputs: [],
                error: `Script execution timed out (${Math.round(input.timeoutMs / 1000)}s limit).`,
                timedOut: true,
                contextReset: true
              })
            )
          })
        }, input.timeoutMs + WORKER_TIMEOUT_GRACE_MS)
        const onMessage = (message: JsReplWorkerMessage): void => {
          if (message.type !== 'result' || message.runId !== runId) return
          if (message.timedOut) {
            abortController.abort(new DOMException('JavaScript REPL timed out.', 'TimeoutError'))
            void resetWorker(true).finally(() => {
              finish(() => resolve({ ...message, contextReset: true }))
            })
            return
          }
          finish(() => resolve(message))
        }
        const onError = (error: Error): void => {
          if (expectedTermination) return
          void resetWorker(true).finally(() => finish(() => reject(error)))
        }
        const onExit = (code: number): void => {
          if (expectedTermination) return
          void resetWorker().finally(() =>
            finish(() =>
              reject(new Error(`JavaScript REPL worker exited unexpectedly with code ${code}.`))
            )
          )
        }
        const onAbort = (): void => {
          abortController.abort(input.options.abortSignal?.reason)
          void resetWorker(true).finally(() =>
            finish(() =>
              reject(input.options.abortSignal?.reason ?? new Error('JavaScript REPL aborted.'))
            )
          )
        }
        worker.on('message', onMessage)
        worker.once('error', onError)
        worker.once('exit', onExit)
        if (input.options.abortSignal?.aborted) {
          onAbort()
          return
        }
        input.options.abortSignal?.addEventListener('abort', onAbort, { once: true })
        worker.postMessage({
          type: 'execute',
          runId,
          code: input.code,
          cwd: input.cwd,
          reset: input.reset,
          timeoutMs: input.timeoutMs
        })
      })
    })
    this.executeChain = execution.catch(() => undefined)
    return execution
  }

  async terminate(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    this.initialized = false
    for (const active of this.activeExecutions.values()) {
      active.abortController.abort(new Error('JavaScript REPL disposed.'))
    }
    this.activeExecutions.clear()
    if (worker) await worker.terminate().catch(() => undefined)
  }
}

function buildDescription(context: AgentToolContext, toolNames: readonly string[]): string {
  const enabled = new Set<string>([...(context.enabledTools ?? []), ...toolNames])
  const helpers = [
    'display(value) → show a structured value',
    ...(enabled.has('read') ? ['read(path, options?) → text'] : []),
    ...(enabled.has('write') && context.jsReplMode !== 'orchestration'
      ? ['write(path, content) → result text']
      : []),
    context.jsReplMode === 'orchestration'
      ? 'tool.<name>(args) → invoke an available read/search tool; Object.keys(tool) lists them'
      : 'tool.<name>(args) → invoke any enabled tool',
    'parallel(thunks) → run independent async functions concurrently'
  ]

  return [
    'Run one JavaScript cell in a persistent worker. State survives across calls in this agent execution.',
    'Work incrementally: load → transform → inspect. Reuse prior bindings; pass `reset: true` only when you need a clean context.',
    context.jsReplMode === 'orchestration'
      ? 'Use top-level await and return for in-memory computation and asynchronous read/search tool orchestration. Modules, Node APIs, direct fetch and write are unavailable. Read uses the read tool and its pagination limits. Each cell allows up to 100 tool calls, 8 concurrently, and 8 MiB per bridge payload and across pending inputs.'
      : 'Top-level `await`, `return`, static/dynamic imports, `require`, `fetch`, and `Buffer` are available.',
    'On error, fix and rerun only the failed cell. A timeout terminates the worker and clears all prior bindings.',
    '',
    'Prelude:',
    ...helpers.map((helper) => `- ${helper}`),
    '',
    'Tool helpers are async. Pass one object to `tool.<name>`, matching that tool’s normal input schema.',
    'Omit `cwd` or use "." for the current workspace; use a relative path for a subdirectory. Unlike delegateTask.workspace, cwd does not accept an absolute workspace path. It applies only to this cell.',
    '',
    'Example sequence:',
    '1. `{ code: "const text = await read(\'package.json\')", title: "load package" }`',
    '2. `{ code: "display(JSON.parse(text).scripts)", title: "inspect scripts" }`'
  ].join('\n')
}

export function createTool(
  context: AgentToolContext,
  dependencies: JsReplToolDependencies = {}
): Tool<JsReplToolInput, JsReplToolOutput> {
  if (context.sandboxed) {
    throw new Error('jsRepl is unavailable in sandboxed runs.')
  }
  const handle = new JsReplWorkerHandle(
    context.workspacePath,
    dependencies,
    context.jsReplMode ?? 'full'
  )
  const tool: Tool<JsReplToolInput, JsReplToolOutput> & { dispose(): Promise<void> } = {
    description: buildDescription(context, dependencies.listToolNames?.() ?? []),
    inputSchema: jsReplToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input, executionOptions): Promise<JsReplToolOutput> => {
      const cwdResolution = resolveReplToolCwd(context.workspacePath, input.cwd)
      if ('error' in cwdResolution) {
        const details: JsReplToolCallDetails = {
          code: input.code,
          ...(input.title ? { title: input.title } : {}),
          error: cwdResolution.error,
          ...(input.cwd ? { cwd: input.cwd } : {})
        }
        return {
          content: textContent(cwdResolution.error),
          details,
          metadata: {},
          error: cwdResolution.error
        }
      }

      const timeoutMs = (input.timeout ?? DEFAULT_REPL_TIMEOUT_SECONDS) * 1000
      let workerResult: WorkerResult
      try {
        workerResult = await handle.execute({
          code: input.code,
          cwd: cwdResolution.resolved,
          reset: input.reset ?? false,
          timeoutMs,
          options: executionOptions ?? createReplToolExecutionOptions('jsRepl')
        })
      } catch (workerError) {
        const message = workerError instanceof Error ? workerError.message : String(workerError)
        const error = `${message}\nJavaScript context was reset; bindings from earlier cells are unavailable.`
        const details: JsReplToolCallDetails = {
          code: input.code,
          ...(input.title ? { title: input.title } : {}),
          error,
          contextReset: true,
          ...(input.cwd ? { cwd: input.cwd } : {})
        }
        return {
          content: textContent(error),
          details,
          metadata: {},
          error
        }
      }

      const consoleOutput = workerResult.consoleLines.join('\n')
      const displayOutput = workerResult.displayOutputs.join('\n\n')
      const stateNotice = workerResult.contextReset
        ? 'JavaScript context was reset; bindings from earlier cells are unavailable.'
        : undefined
      const parts: string[] = []
      if (consoleOutput) parts.push(`[console]\n${consoleOutput}`)
      for (const [index, output] of workerResult.displayOutputs.entries()) {
        parts.push(`[display ${index + 1}]\n${output}`)
      }
      if (workerResult.result !== undefined) parts.push(`[result]\n${workerResult.result}`)
      if (workerResult.error) parts.push(`[error]\n${workerResult.error}`)
      if (stateNotice) parts.push(`[state]\n${stateNotice}`)

      const outputText = parts.join('\n\n') || '(no output)'
      const tail = takeTail(outputText, MAX_REPL_MODEL_OUTPUT_CHARS)
      const details: JsReplToolCallDetails = {
        code: input.code,
        ...(input.title ? { title: input.title } : {}),
        ...(workerResult.result !== undefined
          ? { result: takeTail(workerResult.result, MAX_REPL_DETAILS_OUTPUT_CHARS).text }
          : {}),
        ...(consoleOutput
          ? { consoleOutput: takeTail(consoleOutput, MAX_REPL_DETAILS_OUTPUT_CHARS).text }
          : {}),
        ...(displayOutput
          ? { displayOutput: takeTail(displayOutput, MAX_REPL_DETAILS_OUTPUT_CHARS).text }
          : {}),
        ...(workerResult.error
          ? { error: takeTail(workerResult.error, MAX_REPL_DETAILS_OUTPUT_CHARS).text }
          : {}),
        ...(workerResult.timedOut ? { timedOut: true } : {}),
        ...(input.reset || workerResult.contextReset ? { contextReset: true } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      }

      return {
        content: textContent(tail.text),
        details,
        metadata: {
          ...(workerResult.timedOut ? { timedOut: true } : {}),
          ...(tail.truncated ? { truncated: true } : {})
        },
        ...(workerResult.error ? { error: workerResult.error } : {})
      }
    },
    dispose: () => handle.terminate()
  }
  return tool
}
