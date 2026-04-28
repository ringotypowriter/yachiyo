import { Worker } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import type { JsReplToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'

import {
  jsReplToolInputSchema,
  flattenToolContent,
  resolvePathWithinWorkspace,
  DEFAULT_JSREPL_TIMEOUT_SECONDS,
  type AgentToolContext,
  type AgentToolOutput,
  type JsReplToolInput,
  type JsReplToolOutput,
  takeTail,
  textContent,
  toToolModelOutput
} from './shared.ts'
import { runReadTool } from './readTool.ts'
import { runWriteTool } from './writeTool.ts'
import { runEditTool } from './editTool.ts'
import { runBashTool } from './bashTool.ts'
import { runGlobTool } from './globTool.ts'
import { runGrepTool } from './grepTool.ts'
import { runWebSearchTool } from './webSearchTool.ts'
import { JS_REPL_WORKER_SCRIPT } from './jsReplWorkerScript.ts'

export interface JsReplToolDependencies {
  searchService?: SearchService
  webSearchService?: WebSearchService
}

const DEFAULT_TIMEOUT_SECONDS = DEFAULT_JSREPL_TIMEOUT_SECONDS
const MAX_MODEL_OUTPUT_CHARS = 20_000
const MAX_DETAILS_OUTPUT_CHARS = 8_000

// Safety buffer added to the script timeout so the worker has time to report
// a graceful timeout before the main thread force-terminates it.
const WORKER_RESPONSE_BUFFER_MS = 5_000

type ToolBinding = (input: unknown) => Promise<{ content: string; error?: string }>

function simplifyToolResult(output: AgentToolOutput): { content: string; error?: string } {
  return {
    content: flattenToolContent(output.content),
    ...(output.error ? { error: output.error } : {})
  }
}

function rewriteRelativePath(input: unknown, cwd: string): unknown {
  if (!input || typeof input !== 'object') return input
  const copy = { ...(input as Record<string, unknown>) }
  const path = copy.path
  if (typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.startsWith('~')) {
    copy.path = resolvePath(cwd, path)
  }
  return copy
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildToolBindings(
  context: AgentToolContext,
  dependencies: JsReplToolDependencies,
  cwdRef: { value: string }
): Record<string, ToolBinding> {
  const enabled = new Set(context.enabledTools)
  const isEnabled = (name: string): boolean => !context.enabledTools || enabled.has(name as never)

  const bindings: Record<string, ToolBinding> = {}
  const withCwd = (input: unknown): unknown => rewriteRelativePath(input, cwdRef.value)

  if (isEnabled('read')) {
    bindings.read = async (input) =>
      simplifyToolResult(await runReadTool(withCwd(input) as never, context))
  }
  if (isEnabled('write')) {
    bindings.write = async (input) =>
      simplifyToolResult(await runWriteTool(withCwd(input) as never, context))
  }
  if (isEnabled('edit')) {
    bindings.edit = async (input) =>
      simplifyToolResult(await runEditTool(withCwd(input) as never, context))
  }
  if (isEnabled('bash')) {
    bindings.bash = async (input) => {
      const parsed = input as { command?: unknown }
      const command = typeof parsed?.command === 'string' ? parsed.command : ''
      const rewritten =
        cwdRef.value !== context.workspacePath
          ? {
              ...(input as Record<string, unknown>),
              command: `cd ${singleQuote(cwdRef.value)} && ${command}`
            }
          : input
      return simplifyToolResult(await runBashTool(rewritten as never, context))
    }
  }

  if (dependencies.searchService) {
    const searchService = dependencies.searchService
    if (isEnabled('grep')) {
      bindings.grep = async (input) =>
        simplifyToolResult(await runGrepTool(withCwd(input) as never, context, { searchService }))
    }
    if (isEnabled('glob')) {
      bindings.glob = async (input) =>
        simplifyToolResult(await runGlobTool(withCwd(input) as never, context, { searchService }))
    }
  }

  if (dependencies.webSearchService) {
    const webSearchService = dependencies.webSearchService
    if (isEnabled('webSearch')) {
      bindings.webSearch = async (input) =>
        simplifyToolResult(await runWebSearchTool(input as never, { webSearchService }))
    }
  }

  return bindings
}

interface WorkerResultMessage {
  type: 'result'
  result?: string
  consoleLines: string[]
  error?: string
  timedOut: boolean
  stateHint?: string
}

interface WorkerMessage {
  type: string
  id?: number
  toolName?: string
  input?: unknown
  result?: { content: string; error?: string }
}

export async function terminateAllJsReplWorkers(): Promise<void> {
  // No-op: workers are now disposed deterministically via tool.dispose().
}

class JsReplWorkerHandle {
  private worker: Worker | undefined
  private executeChain: Promise<unknown> = Promise.resolve()
  private readonly toolBindings: Record<string, ToolBinding>
  private readonly workspacePath: string
  private readonly cwdRef: { value: string }
  private initialized = false

  constructor(context: AgentToolContext, dependencies: JsReplToolDependencies) {
    this.workspacePath = context.workspacePath
    this.cwdRef = { value: context.workspacePath }
    this.toolBindings = buildToolBindings(context, dependencies, this.cwdRef)
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.initialized) return

    if (this.worker) {
      await this.worker.terminate().catch(() => {})
    }

    const worker = new Worker(JS_REPL_WORKER_SCRIPT, { eval: true })
    this.worker = worker
    this.initialized = false

    worker.on('message', async (message: WorkerMessage) => {
      if (message.type === 'toolCall' && message.id !== undefined && message.toolName) {
        const binding = this.toolBindings[message.toolName]
        if (!binding) {
          try {
            worker.postMessage({
              type: 'toolResult',
              id: message.id,
              result: { content: '', error: `Tool "${message.toolName}" is not available.` }
            })
          } catch {
            // Worker may have been terminated; ignore.
          }
          return
        }
        try {
          const result = await binding(message.input)
          try {
            worker.postMessage({ type: 'toolResult', id: message.id, result })
          } catch {
            // Worker may have been terminated; ignore.
          }
        } catch (error) {
          try {
            worker.postMessage({
              type: 'toolResult',
              id: message.id,
              result: {
                content: '',
                error: error instanceof Error ? error.message : String(error)
              }
            })
          } catch {
            // Worker may have been terminated; ignore.
          }
        }
      }
    })

    worker.postMessage({
      type: 'init',
      workspacePath: this.workspacePath,
      enabledTools: Object.keys(this.toolBindings)
    })

    await new Promise<void>((resolve, reject) => {
      const onMessage = (m: WorkerMessage): void => {
        if (m.type === 'initDone') {
          worker.off('message', onMessage)
          worker.off('error', onError)
          resolve()
        }
      }
      const onError = (err: Error): void => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        reject(err)
      }
      worker.on('message', onMessage)
      worker.once('error', onError)
    })

    this.initialized = true
  }

  async execute(
    code: string,
    timeoutMs: number,
    cwd?: string,
    reset?: boolean
  ): Promise<WorkerResultMessage> {
    // Serialize execute calls so the shared VM state isn't clobbered.
    const promise = this.executeChain.then(async () => {
      await this.ensureWorker()
      this.cwdRef.value = cwd || this.workspacePath

      return new Promise<WorkerResultMessage>((resolve, reject) => {
        let settled = false
        const worker = this.worker!

        const cleanup = (): void => {
          clearTimeout(timeoutHandle)
          worker.off('message', messageHandler)
          worker.off('error', errorHandler)
          worker.off('exit', exitHandler)
        }

        const timeoutHandle = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          worker.terminate().catch(() => {})
          this.worker = undefined
          this.initialized = false
          reject(new Error('jsRepl worker did not respond in time.'))
        }, timeoutMs + WORKER_RESPONSE_BUFFER_MS)

        const messageHandler = (message: WorkerMessage): void => {
          if (message.type !== 'result') return
          if (settled) return
          settled = true
          cleanup()
          resolve(message as WorkerResultMessage)
        }

        const errorHandler = (err: Error): void => {
          if (settled) return
          settled = true
          cleanup()
          this.worker = undefined
          this.initialized = false
          reject(err)
        }

        const exitHandler = (code: number): void => {
          if (settled) return
          settled = true
          cleanup()
          this.worker = undefined
          this.initialized = false
          reject(new Error(`jsRepl worker exited unexpectedly with code ${code}`))
        }

        worker.on('message', messageHandler)
        worker.once('error', errorHandler)
        worker.once('exit', exitHandler)

        worker.postMessage({ type: 'execute', code, timeoutMs, cwd, reset })
      })
    })

    this.executeChain = promise.catch(() => {})
    return promise
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      const w = this.worker
      this.worker = undefined
      this.initialized = false
      await w.terminate().catch(() => {})
    }
  }
}

export function createTool(
  context: AgentToolContext,
  dependencies: JsReplToolDependencies = {}
): import('ai').Tool<JsReplToolInput, JsReplToolOutput> {
  const handle = new JsReplWorkerHandle(context, dependencies)

  const tool: import('ai').Tool<JsReplToolInput, JsReplToolOutput> & {
    dispose(): Promise<void>
  } = {
    description:
      `Run JavaScript code in a REPL session with cwd set to ${context.workspacePath}. ` +
      'Only JavaScript is supported — never write Python code or treat this as a Python interpreter. ' +
      'Context is reset by default so each call starts with a clean slate. ' +
      'Pass `reset: false` to preserve variables and imports from the previous call when you need multi-step state. ' +
      'Has access to `require()` for Node built-ins and project dependencies. ' +
      'Relative paths in fs operations resolve against the workspace.\n' +
      'Optional `cwd` overrides the working directory for this call only; it must be a relative path inside the workspace — ' +
      'absolute paths, `~`, and any `..` segments are rejected.\n' +
      'A `tools` object provides async access to built-in tools. ' +
      'Use `await` when calling tools — code is automatically wrapped in an async context. ' +
      'Each tool returns an object `{ content: string, error?: string }`, not a raw string.\n' +
      'Available tools: ' +
      "tools.read({ path }), tools.write({ path, content }), tools.edit({ mode: 'inline', path, oldText, newText }), " +
      "tools.edit({ mode: 'range', path, replaceLines: { start, end }, newLines }), " +
      'tools.bash({ command }), tools.grep({ pattern }), tools.glob({ pattern }).\n' +
      'Prefer jsRepl over individual tool calls for: ' +
      'batch file operations, looping over search results, programmatic code generation, ' +
      'data transformation pipelines, and any task that benefits from loops, conditionals, or variables.',
    inputSchema: jsReplToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input): Promise<JsReplToolOutput> => {
      const cwdResolution = resolveCallCwd(context.workspacePath, input.cwd)
      if ('error' in cwdResolution) {
        const details: JsReplToolCallDetails = {
          code: input.code,
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

      const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000

      let workerResult: WorkerResultMessage
      try {
        workerResult = await handle.execute(
          input.code,
          timeoutMs,
          cwdResolution.resolved,
          input.reset ?? true
        )
      } catch (workerError) {
        const errorMessage =
          workerError instanceof Error ? workerError.message : String(workerError)
        const details: JsReplToolCallDetails = {
          code: input.code,
          error: errorMessage,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.reset ? { contextReset: true } : {})
        }
        return {
          content: textContent(errorMessage),
          details,
          metadata: {},
          error: errorMessage
        }
      }

      const consoleOutput = workerResult.consoleLines.join('\n')
      const result = workerResult.result
      const error = workerResult.error
      const timedOut = workerResult.timedOut

      const stateHint = workerResult.stateHint

      const parts: string[] = []
      if (consoleOutput) parts.push(`[console]\n${consoleOutput}`)
      if (result !== undefined) parts.push(`[result]\n${result}`)
      if (error) parts.push(`[error]\n${error}`)
      if (stateHint) parts.push(`[vars] ${stateHint}`)

      const outputText = parts.join('\n\n') || '(no output)'
      const tail = takeTail(outputText, MAX_MODEL_OUTPUT_CHARS)

      const details: JsReplToolCallDetails = {
        code: input.code,
        ...(result !== undefined
          ? { result: takeTail(result, MAX_DETAILS_OUTPUT_CHARS).text }
          : {}),
        ...(consoleOutput
          ? { consoleOutput: takeTail(consoleOutput, MAX_DETAILS_OUTPUT_CHARS).text }
          : {}),
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut } : {}),
        ...(input.reset ? { contextReset: true } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      }

      return {
        content: textContent(tail.text),
        details,
        metadata: {
          ...(timedOut ? { timedOut } : {}),
          ...(tail.truncated ? { truncated: true } : {})
        },
        ...(error ? { error } : {})
      }
    },
    dispose: () => handle.terminate()
  }

  return tool
}

function resolveCallCwd(
  workspacePath: string,
  requested: string | undefined
): { resolved: string } | { error: string } {
  if (!requested) return { resolved: workspacePath }
  const resolved = resolvePathWithinWorkspace(workspacePath, requested)
  if (!resolved) {
    return {
      error: `Invalid cwd "${requested}" — must be a relative path inside the workspace (no "..", no absolute, no "~").`
    }
  }
  try {
    const info = statSync(resolved)
    if (!info.isDirectory()) {
      return { error: `Invalid cwd "${requested}" — not a directory.` }
    }
  } catch {
    return { error: `Invalid cwd "${requested}" — directory does not exist.` }
  }
  return { resolved }
}
