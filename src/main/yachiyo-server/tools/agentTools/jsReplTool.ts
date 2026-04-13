import { tool, type Tool } from 'ai'

import vm from 'node:vm'
import { createRequire } from 'node:module'

import type { JsReplToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'

import {
  jsReplToolInputSchema,
  flattenToolContent,
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

export interface JsReplToolDependencies {
  searchService?: SearchService
  webSearchService?: WebSearchService
}

/**
 * Rewrite `const` / `let` declarations that bind a `require()` call to `var`,
 * so repeated calls in the persistent VM context don't throw
 * "Identifier '…' has already been declared".
 *
 * Models habitually write `const fs = require("node:fs")` at the top of every
 * snippet.  `var` allows harmless redeclaration in the same scope.
 */
function relaxRequireBindings(code: string): string {
  return code.replace(/\b(const|let)\s+([\w{},\s]+?)\s*=\s*require\s*\(/g, 'var $2 = require(')
}

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_MODEL_OUTPUT_CHARS = 20_000
const MAX_DETAILS_OUTPUT_CHARS = 8_000

export function createTool(
  context: AgentToolContext,
  dependencies: JsReplToolDependencies = {}
): Tool<JsReplToolInput, JsReplToolOutput> {
  // Persistent VM context — lives as long as this tool instance (= one run).
  // GC'd naturally when the run ends and the closure goes out of scope.
  let vmContext: vm.Context
  let timerTracker: TimerTracker
  const toolBindings = buildToolBindings(context, dependencies)

  function resetContext(): void {
    timerTracker?.clearAll()
    timerTracker = new TimerTracker()
    vmContext = createFreshContext(context.workspacePath, timerTracker, toolBindings)
  }

  resetContext()

  return tool({
    description:
      `Run JavaScript code in a persistent REPL session with cwd set to ${context.workspacePath}. ` +
      'Variables and imports persist across calls within the same run. ' +
      'To start from a clean state, include `reset: true` in the same jsRepl call as the code you want to run. ' +
      'Do not treat reset as a separate step or a sticky mode. ' +
      'Has access to `require()` for Node built-ins and project dependencies. ' +
      'Relative paths in fs operations resolve against the workspace.\n' +
      'A `tools` object provides async access to built-in tools. ' +
      'Use `await` when calling tools — code is automatically wrapped in an async context. ' +
      'Each tool returns an object `{ content: string, error?: string }`, not a raw string.\n' +
      'Available tools: ' +
      'tools.read({ path }), tools.write({ path, content }), tools.edit({ path, oldText, newText }), ' +
      'tools.bash({ command }), tools.grep({ pattern }), tools.glob({ pattern }).\n' +
      'Prefer jsRepl over individual tool calls for: ' +
      'batch file operations, looping over search results, programmatic code generation, ' +
      'data transformation pipelines, and any task that benefits from loops, conditionals, or variables.',
    inputSchema: jsReplToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input): Promise<JsReplToolOutput> => {
      if (input.reset) {
        resetContext()
      }

      const consoleLines: string[] = []
      vmContext.console = makeCapturingConsole(consoleLines)

      let result: string | undefined
      let error: string | undefined
      let timedOut = false
      const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
      const code = relaxRequireBindings(input.code)

      // Chdir to workspace so relative fs paths resolve correctly.
      // Held across both the sync vm.runInContext and any subsequent await
      // (tool calls are I/O-bound so Promise.race timeout works).
      const previousCwd = process.cwd()
      process.chdir(context.workspacePath)
      try {
        // Try running code directly first (preserves var/let/const in VM scope).
        // If it fails because of top-level await, retry wrapped in async IIFE.
        let rawResult: unknown
        try {
          rawResult = vm.runInContext(code, vmContext, {
            timeout: timeoutMs,
            filename: 'jsRepl'
          })
        } catch (syncErr: unknown) {
          const errMsg =
            syncErr instanceof Error
              ? syncErr.message
              : typeof syncErr === 'object' && syncErr !== null && 'message' in syncErr
                ? String((syncErr as { message: unknown }).message)
                : ''
          if (errMsg.includes('await is only valid in async function')) {
            rawResult = vm.runInContext(
              `(async () => {\n${wrapLastExpression(code)}\n})()`,
              vmContext,
              { timeout: timeoutMs, filename: 'jsRepl' }
            )
          } else {
            throw syncErr
          }
        }

        // If result is a promise (from tool calls or async IIFE), await with timeout.
        if (isThenable(rawResult)) {
          let raceTimer: ReturnType<typeof setTimeout> | undefined
          try {
            rawResult = await Promise.race([
              rawResult,
              new Promise((_, reject) => {
                raceTimer = setTimeout(
                  () => reject(new Error('Script execution timed out.')),
                  timeoutMs
                )
              })
            ])
          } finally {
            if (raceTimer !== undefined) clearTimeout(raceTimer)
          }
        }

        if (rawResult !== undefined) {
          result = formatResult(rawResult)
        }
      } catch (err: unknown) {
        // vm timeout errors may not pass instanceof Error when thrown across context boundaries
        const errObj = err as { code?: string; name?: string; message?: string }
        if (
          errObj.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
          (typeof errObj.message === 'string' &&
            errObj.message.includes('Script execution timed out'))
        ) {
          timedOut = true
          error = `Script execution timed out (${input.timeout ?? DEFAULT_TIMEOUT_SECONDS}s limit).`
        } else if (err instanceof Error) {
          error = `${err.name}: ${err.message}`
        } else if (typeof errObj.message === 'string') {
          error = `${errObj.name ?? 'Error'}: ${errObj.message}`
        } else {
          error = String(err)
        }
      } finally {
        process.chdir(previousCwd)
        // Clear all timers after each execution so scheduled handles cannot
        // outlive the tool call or pin the event loop after the run ends.
        timerTracker.clearAll()
      }

      const consoleOutput = consoleLines.join('\n')

      // Build model-facing content
      const parts: string[] = []
      if (consoleOutput) parts.push(`[console]\n${consoleOutput}`)
      if (result !== undefined) parts.push(`[result]\n${result}`)
      if (error) parts.push(`[error]\n${error}`)

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
        ...(input.reset ? { contextReset: true } : {})
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
    }
  })
}

class TimerTracker {
  private readonly timeouts = new Set<ReturnType<typeof setTimeout>>()
  private readonly intervals = new Set<ReturnType<typeof setInterval>>()

  trackedSetTimeout(
    callback: (...args: unknown[]) => void,
    ms?: number
  ): ReturnType<typeof setTimeout> {
    const handle = setTimeout((...args: unknown[]) => {
      this.timeouts.delete(handle)
      callback(...args)
    }, ms)
    this.timeouts.add(handle)
    return handle
  }

  trackedSetInterval(
    callback: (...args: unknown[]) => void,
    ms?: number
  ): ReturnType<typeof setInterval> {
    const handle = setInterval(callback, ms)
    this.intervals.add(handle)
    return handle
  }

  trackedClearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle)
    this.timeouts.delete(handle)
  }

  trackedClearInterval(handle: ReturnType<typeof setInterval>): void {
    clearInterval(handle)
    this.intervals.delete(handle)
  }

  clearAll(): void {
    for (const handle of this.timeouts) {
      clearTimeout(handle)
    }
    this.timeouts.clear()
    for (const handle of this.intervals) {
      clearInterval(handle)
    }
    this.intervals.clear()
  }
}

function simplifyToolResult(output: AgentToolOutput): { content: string; error?: string } {
  return {
    content: flattenToolContent(output.content),
    ...(output.error ? { error: output.error } : {})
  }
}

type ToolBinding = (input: unknown) => Promise<{ content: string; error?: string }>

function buildToolBindings(
  context: AgentToolContext,
  dependencies: JsReplToolDependencies
): Record<string, ToolBinding> {
  const enabled = new Set(context.enabledTools)
  const isEnabled = (name: string): boolean => !context.enabledTools || enabled.has(name as never)

  const bindings: Record<string, ToolBinding> = {}

  if (isEnabled('read')) {
    bindings.read = async (input) => simplifyToolResult(await runReadTool(input as never, context))
  }
  if (isEnabled('write')) {
    bindings.write = async (input) =>
      simplifyToolResult(await runWriteTool(input as never, context))
  }
  if (isEnabled('edit')) {
    bindings.edit = async (input) => simplifyToolResult(await runEditTool(input as never, context))
  }
  if (isEnabled('bash')) {
    bindings.bash = async (input) => simplifyToolResult(await runBashTool(input as never, context))
  }

  if (dependencies.searchService) {
    const searchService = dependencies.searchService
    if (isEnabled('grep')) {
      bindings.grep = async (input) =>
        simplifyToolResult(await runGrepTool(input as never, context, { searchService }))
    }
    if (isEnabled('glob')) {
      bindings.glob = async (input) =>
        simplifyToolResult(await runGlobTool(input as never, context, { searchService }))
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

function createFreshContext(
  workspacePath: string,
  timerTracker: TimerTracker,
  toolBindings: Record<string, (input: unknown) => Promise<{ content: string; error?: string }>>
): vm.Context {
  const contextRequire = createRequire(workspacePath + '/package.json')
  const sandbox: Record<string, unknown> = {
    require: contextRequire,
    __dirname: workspacePath,
    __filename: workspacePath + '/jsRepl.js',
    process: { env: process.env, cwd: () => workspacePath, argv: [] },
    setTimeout: (cb: (...args: unknown[]) => void, ms?: number) =>
      timerTracker.trackedSetTimeout(cb, ms),
    setInterval: (cb: (...args: unknown[]) => void, ms?: number) =>
      timerTracker.trackedSetInterval(cb, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
      timerTracker.trackedClearTimeout(handle),
    clearInterval: (handle: ReturnType<typeof setInterval>) =>
      timerTracker.trackedClearInterval(handle),
    tools: toolBindings,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    console
  }
  return vm.createContext(sandbox)
}

function makeCapturingConsole(lines: string[]): Record<string, (...args: unknown[]) => void> {
  const format = (...args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a, null, 2) ?? String(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')

  return {
    log: (...args: unknown[]) => lines.push(format(...args)),
    warn: (...args: unknown[]) => lines.push(`[warn] ${format(...args)}`),
    error: (...args: unknown[]) => lines.push(`[error] ${format(...args)}`),
    info: (...args: unknown[]) => lines.push(format(...args)),
    debug: (...args: unknown[]) => lines.push(`[debug] ${format(...args)}`)
  }
}

const AsyncFunction = (async () => {}).constructor as typeof Function

/**
 * Wrap code so the async IIFE returns the value of the last expression,
 * matching standard REPL behavior. Uses AsyncFunction for validation so
 * `await` expressions pass the syntax check.
 */
function wrapLastExpression(code: string): string {
  const trimmed = code.trimEnd()
  if (!trimmed) return code

  // Already has an explicit return
  if (/\breturn\b/.test(trimmed)) return code

  const tryParse = (candidate: string): boolean => {
    try {
      new AsyncFunction(candidate)
      return true
    } catch {
      return false
    }
  }

  // Try 1: entire code is a single expression
  const asReturn = `return (\n${trimmed}\n)`
  if (tryParse(asReturn)) return asReturn

  // Try 2: split off the last statement and try to return it
  const lines = trimmed.split('\n')
  let lastIdx = lines.length - 1
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') {
    lastIdx--
  }
  if (lastIdx < 0) return code

  const lastLine = lines[lastIdx]

  // Split last line on final semicolon to isolate trailing expression
  const lastSemicolon = lastLine.lastIndexOf(';')
  if (lastSemicolon >= 0) {
    const before = lastLine.slice(0, lastSemicolon + 1)
    const after = lastLine.slice(lastSemicolon + 1).trim()
    if (after) {
      const candidate = [...lines.slice(0, lastIdx), before, `return (${after})`].join('\n')
      if (tryParse(candidate)) return candidate
    }
  }

  // Try the whole last line as a return expression
  const candidate = [...lines.slice(0, lastIdx), `return (${lastLine})`].join('\n')
  if (tryParse(candidate)) return candidate

  return code
}

function isThenable(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).then === 'function'
  )
}

function formatResult(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
