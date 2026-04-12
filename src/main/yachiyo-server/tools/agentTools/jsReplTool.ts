import { tool, type Tool } from 'ai'

import vm from 'node:vm'
import { createRequire } from 'node:module'

import type { JsReplToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  jsReplToolInputSchema,
  type AgentToolContext,
  type JsReplToolInput,
  type JsReplToolOutput,
  takeTail,
  textContent,
  toToolModelOutput
} from './shared.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_MODEL_OUTPUT_CHARS = 20_000
const MAX_DETAILS_OUTPUT_CHARS = 8_000

export function createTool(context: AgentToolContext): Tool<JsReplToolInput, JsReplToolOutput> {
  // Persistent VM context — lives as long as this tool instance (= one run).
  // GC'd naturally when the run ends and the closure goes out of scope.
  let vmContext: vm.Context
  let timerTracker: TimerTracker

  function resetContext(): void {
    timerTracker?.clearAll()
    timerTracker = new TimerTracker()
    vmContext = createFreshContext(context.workspacePath, timerTracker)
  }

  resetContext()

  return tool({
    description:
      `Run synchronous JavaScript code in a persistent REPL session with cwd set to ${context.workspacePath}. ` +
      'Variables and imports persist across calls within the same run. ' +
      'Use `reset: true` to clear all state. ' +
      'Has access to `require()` for Node built-ins and project dependencies. ' +
      'Relative paths in fs operations resolve against the workspace. ' +
      'Async code (promises, await) is not supported — use synchronous APIs.',
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

      // Temporarily chdir so relative fs paths resolve against the workspace.
      // vm.runInContext is synchronous, so cwd is restored before anything else runs.
      const previousCwd = process.cwd()
      process.chdir(context.workspacePath)
      try {
        const rawResult: unknown = vm.runInContext(input.code, vmContext, {
          timeout: DEFAULT_TIMEOUT_MS,
          filename: 'jsRepl'
        })

        if (isThenable(rawResult)) {
          // Suppress unhandled rejections — async code can't be safely timed out
          // or cwd-protected, so we report the promise without awaiting it.
          ;(rawResult as Promise<unknown>).catch(() => {})
          result = '[Promise — async results are not captured; use synchronous code]'
        } else if (rawResult !== undefined) {
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
          error = 'Script execution timed out (30s limit).'
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

function createFreshContext(workspacePath: string, timerTracker: TimerTracker): vm.Context {
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
