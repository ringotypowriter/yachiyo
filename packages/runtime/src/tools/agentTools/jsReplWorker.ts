import { inspect } from 'node:util'
import { createRequire, isBuiltin } from 'node:module'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parentPort, type MessagePort } from 'node:worker_threads'
import vm from 'node:vm'

import { compileJsReplCell } from './jsReplCellCompiler.ts'
import { resolveReplCallCwd } from './replCwd.ts'
import type {
  JsReplParentMessage,
  JsReplSerializedError,
  JsReplWorkerFetchRequest,
  JsReplWorkerFetchResult,
  JsReplWorkerMessage
} from './jsReplWorkerProtocol.ts'

interface PendingHostCall {
  runId: string
  resolve(value: unknown): void
  reject(error: Error): void
}

interface ActiveRun {
  runId: string
  consoleLines: string[]
  displayOutputs: string[]
  asyncErrors: unknown[]
}

interface WorkerState {
  workspacePath: string
  cwdRef: { value: string }
  context: vm.Context | undefined
  timerTracker: TimerTracker | undefined
  toolNames: Set<string>
  pendingHostCalls: Map<number, PendingHostCall>
  nextCallId: number
  activeRun: ActiveRun | undefined
}

function requireParentPort(): MessagePort {
  if (!parentPort) throw new Error('jsRepl worker requires a parent port.')
  return parentPort
}

const port = requireParentPort()

const state: WorkerState = {
  workspacePath: '',
  cwdRef: { value: '' },
  context: undefined,
  timerTracker: undefined,
  toolNames: new Set(),
  pendingHostCalls: new Map(),
  nextCallId: 1,
  activeRun: undefined
}

function errorFromSerialized(error: JsReplSerializedError): Error {
  const next = new Error(error.message)
  next.name = error.name
  if (error.stack) next.stack = error.stack
  return next
}

function formatValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value, null, 2)
    if (json !== undefined) return json
  } catch {
    // Circular and BigInt-rich values still have a useful inspected representation.
  }
  return inspect(value, {
    colors: false,
    compact: false,
    depth: 8,
    maxArrayLength: 200,
    maxStringLength: 20_000,
    breakLength: 100
  })
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((value) =>
      typeof value === 'string'
        ? value
        : inspect(value, { colors: false, depth: 6, maxArrayLength: 100, breakLength: 100 })
    )
    .join(' ')
}

class TimerTracker {
  private readonly timeouts = new Set<NodeJS.Timeout>()
  private readonly intervals = new Set<NodeJS.Timeout>()
  private readonly onError: (error: unknown) => void

  constructor(onError: (error: unknown) => void) {
    this.onError = onError
  }

  setTimeout(
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): NodeJS.Timeout {
    const handle = setTimeout(() => {
      this.timeouts.delete(handle)
      try {
        callback(...args)
      } catch (error) {
        this.onError(error)
      }
    }, delay)
    this.timeouts.add(handle)
    return handle
  }

  setInterval(
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): NodeJS.Timeout {
    const handle = setInterval(() => {
      try {
        callback(...args)
      } catch (error) {
        this.onError(error)
      }
    }, delay)
    this.intervals.add(handle)
    return handle
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    clearTimeout(handle)
    this.timeouts.delete(handle)
  }

  clearInterval(handle: NodeJS.Timeout): void {
    clearInterval(handle)
    this.intervals.delete(handle)
  }

  clearAll(): void {
    for (const handle of this.timeouts) clearTimeout(handle)
    for (const handle of this.intervals) clearInterval(handle)
    this.timeouts.clear()
    this.intervals.clear()
  }
}

function wrapFsForCwd<T extends object>(fsModule: T, cwdRef: { value: string }): T {
  const twoPathMethods = new Set<PropertyKey>(['cp', 'copyFile', 'link', 'rename'])
  const pathConstructors = new Set<PropertyKey>([
    'FileReadStream',
    'FileWriteStream',
    'ReadStream',
    'WriteStream'
  ])
  const resolveArgument = (value: unknown): unknown =>
    typeof value === 'string' && !isAbsolute(value) ? resolvePath(cwdRef.value, value) : value

  const resolvePathArguments = (property: PropertyKey, input: unknown[]): unknown[] => {
    const args = [...input]
    if (args.length > 0) args[0] = resolveArgument(args[0])
    if (twoPathMethods.has(property) && args.length > 1) args[1] = resolveArgument(args[1])
    return args
  }

  return new Proxy(fsModule, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'promises' && value && typeof value === 'object') {
        return wrapFsForCwd(value, cwdRef)
      }
      if (typeof value !== 'function') return value
      return new Proxy(value, {
        apply(callable, _thisArg, input) {
          return Reflect.apply(callable, target, resolvePathArguments(property, input))
        },
        construct(constructor, input, newTarget) {
          const args = pathConstructors.has(property)
            ? resolvePathArguments(property, input)
            : input
          return Reflect.construct(constructor, args, newTarget)
        }
      })
    }
  })
}

function createMockProcess(cwdRef: { value: string }): NodeJS.Process {
  const target = { env: { ...process.env } }
  return new Proxy(target, {
    get(current, property) {
      if (property === 'cwd') return () => cwdRef.value
      if (property === 'env') return current.env
      if (property === 'chdir') {
        return () => {
          throw new Error(
            'process.chdir() is unavailable in a worker thread; pass jsRepl.cwd instead.'
          )
        }
      }
      const value = Reflect.get(process, property)
      return typeof value === 'function' ? value.bind(process) : value
    },
    set(current, property, value) {
      if (property === 'env') {
        current.env = value as NodeJS.ProcessEnv
        return true
      }
      return Reflect.set(process, property, value)
    }
  }) as unknown as NodeJS.Process
}

function wrapChildProcessForCwd<T extends object>(module: T, cwdRef: { value: string }): T {
  const methods = new Set<PropertyKey>([
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'spawn',
    'spawnSync',
    'fork'
  ])

  return new Proxy(module, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || !methods.has(property)) return value
      return (...input: unknown[]) => {
        const args = [...input]
        const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined
        const finalArgument = args.at(-1)
        if (finalArgument && typeof finalArgument === 'object' && !Array.isArray(finalArgument)) {
          args[args.length - 1] = { cwd: cwdRef.value, ...finalArgument }
        } else if (
          property === 'execSync' &&
          typeof finalArgument === 'string' &&
          args.length === 2
        ) {
          args[1] = { cwd: cwdRef.value, encoding: finalArgument }
        } else {
          args.push({ cwd: cwdRef.value })
        }
        if (callback) args.push(callback)
        return Reflect.apply(value, target, args)
      }
    }
  })
}

function createCwdRequire(cwdRef: { value: string }, mockProcess: NodeJS.Process): NodeJS.Require {
  const fsModule = wrapFsForCwd(createRequire(import.meta.url)('node:fs'), cwdRef)
  const fsPromisesModule = wrapFsForCwd(createRequire(import.meta.url)('node:fs/promises'), cwdRef)
  const childProcessModule = wrapChildProcessForCwd(
    createRequire(import.meta.url)('node:child_process'),
    cwdRef
  )

  return ((specifier: string) => {
    if (specifier === 'fs' || specifier === 'node:fs') return fsModule
    if (specifier === 'fs/promises' || specifier === 'node:fs/promises') return fsPromisesModule
    if (specifier === 'process' || specifier === 'node:process') return mockProcess
    if (specifier === 'child_process' || specifier === 'node:child_process') {
      return childProcessModule
    }
    return createRequire(resolvePath(cwdRef.value, 'package.json'))(specifier)
  }) as NodeJS.Require
}

async function importFromCwd(source: string, options?: ImportCallOptions): Promise<unknown> {
  let target = source
  if (!source.startsWith('node:') && !isBuiltin(source) && !/^[a-zA-Z][\w+.-]*:/.test(source)) {
    const resolved = createRequire(resolvePath(state.cwdRef.value, 'package.json')).resolve(source)
    target = pathToFileURL(resolved).href
  }
  const imported = await (options === undefined ? import(target) : import(target, options))
  if (!source.startsWith('node:') && !isBuiltin(source)) return imported

  const cwdRequire = state.context?.require
  if (typeof cwdRequire !== 'function') {
    throw new Error('JavaScript REPL import called before context initialization.')
  }
  const wrapped = cwdRequire(source) as Record<PropertyKey, unknown>
  const namespace = Object.create(null) as Record<PropertyKey, unknown>
  for (const property of new Set([...Reflect.ownKeys(imported), ...Reflect.ownKeys(wrapped)])) {
    namespace[property] =
      property === 'default'
        ? wrapped
        : Reflect.has(wrapped, property)
          ? Reflect.get(wrapped, property)
          : Reflect.get(imported, property)
  }
  namespace.default = wrapped
  return Object.freeze(namespace)
}

function activeRun(): ActiveRun {
  if (!state.activeRun) throw new Error('JavaScript REPL helper called outside an active cell.')
  return state.activeRun
}

function callHost(toolName: string, input: unknown): Promise<unknown> {
  const run = activeRun()
  if (!state.toolNames.has(toolName)) {
    throw new Error(`Tool ${JSON.stringify(toolName)} is not available in this JavaScript REPL.`)
  }
  const callId = state.nextCallId++
  return new Promise((resolve, reject) => {
    state.pendingHostCalls.set(callId, { runId: run.runId, resolve, reject })
    const message: JsReplWorkerMessage = {
      type: 'toolCall',
      runId: run.runId,
      callId,
      toolName,
      input
    }
    try {
      port.postMessage(message)
    } catch (error) {
      state.pendingHostCalls.delete(callId)
      reject(error)
    }
  })
}

function resultText(value: unknown, helper: string): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text
  }
  throw new Error(`${helper}() received an invalid tool result.`)
}

async function readLocalText(
  path: string,
  options: { offset?: number; limit?: number } = {}
): Promise<string> {
  const resolved = isAbsolute(path) ? path : resolvePath(state.cwdRef.value, path)
  const content = await readFile(resolved, 'utf8')
  if (options.offset === undefined && options.limit === undefined) return content

  const offset = options.offset ?? 1
  if (!Number.isInteger(offset) || offset < 1) {
    throw new TypeError('read() offset must be a positive integer.')
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new TypeError('read() limit must be a non-negative integer.')
  }
  const lines = content.split('\n')
  return lines
    .slice(offset - 1, options.limit === undefined ? undefined : offset - 1 + options.limit)
    .join('\n')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return String(error)
}

function formatThrownError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (error && typeof error === 'object') {
    if ('stack' in error && typeof error.stack === 'string') return error.stack
    if ('message' in error && typeof error.message === 'string') {
      const name = 'name' in error && typeof error.name === 'string' ? error.name : 'Error'
      return `${name}: ${error.message}`
    }
  }
  return String(error)
}

async function serializeFetchRequest(
  input: string | URL | Request,
  init?: RequestInit
): Promise<JsReplWorkerFetchRequest> {
  const request = new Request(input, init)
  let bodyBase64: string | undefined
  if (request.body !== null) {
    bodyBase64 = Buffer.from(await request.arrayBuffer()).toString('base64')
  }
  return {
    url: request.url,
    init: {
      method: request.method,
      headers: Array.from(request.headers.entries()),
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      credentials: request.credentials,
      cache: request.cache,
      mode: request.mode,
      integrity: request.integrity,
      keepalive: request.keepalive,
      ...(bodyBase64 !== undefined ? { bodyBase64 } : {})
    }
  }
}

async function callFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const run = activeRun()
  const callId = state.nextCallId++
  const request = await serializeFetchRequest(input, init)
  const result = await new Promise<JsReplWorkerFetchResult>((resolve, reject) => {
    state.pendingHostCalls.set(callId, { runId: run.runId, resolve, reject })
    const message: JsReplWorkerMessage = {
      type: 'fetchCall',
      runId: run.runId,
      callId,
      request
    }
    port.postMessage(message)
  })
  if ('error' in result) throw errorFromSerialized(result.error)
  const response = new Response(result.body ?? null, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers
  })
  Object.defineProperties(response, {
    url: { value: result.url },
    redirected: { value: result.redirected },
    type: { value: result.type }
  })
  return response
}

async function parallel(thunks: Iterable<(index: number) => unknown>): Promise<unknown[]> {
  const list = Array.from(thunks)
  if (list.some((thunk) => typeof thunk !== 'function')) {
    throw new TypeError('parallel() expects an iterable of functions.')
  }
  const settled = await Promise.allSettled(list.map((thunk, index) => thunk(index)))
  const firstFailure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (firstFailure) throw firstFailure.reason
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value)
}

function makeConsole(lines: string[]): Console {
  const write = (prefix: string, args: unknown[]): void => {
    lines.push(`${prefix}${formatConsoleArgs(args)}`)
  }
  return {
    log: (...args: unknown[]) => write('', args),
    info: (...args: unknown[]) => write('', args),
    warn: (...args: unknown[]) => write('[warn] ', args),
    error: (...args: unknown[]) => write('[error] ', args),
    debug: (...args: unknown[]) => write('[debug] ', args)
  } as Console
}

function resetContext(): void {
  state.timerTracker?.clearAll()
  state.cwdRef.value = state.workspacePath
  const mockProcess = createMockProcess(state.cwdRef)
  state.timerTracker = new TimerTracker((error) => activeRun().asyncErrors.push(error))
  const tool = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      return (input: unknown = {}) => callHost(property, input)
    }
  })
  const sandbox: Record<string, unknown> = {
    require: createCwdRequire(state.cwdRef, mockProcess),
    __dirname: state.workspacePath,
    __filename: resolvePath(state.workspacePath, 'jsRepl.js'),
    process: mockProcess,
    Buffer,
    fetch: callFetch,
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    crypto: globalThis.crypto,
    structuredClone,
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      state.timerTracker!.setTimeout(callback, delay, ...args),
    setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      state.timerTracker!.setInterval(callback, delay, ...args),
    clearTimeout: (handle: NodeJS.Timeout) => state.timerTracker!.clearTimeout(handle),
    clearInterval: (handle: NodeJS.Timeout) => state.timerTracker!.clearInterval(handle),
    display: (value: unknown) => {
      const formatted = formatValue(value)
      if (formatted !== undefined) activeRun().displayOutputs.push(formatted)
    },
    tool,
    parallel,
    [IMPORT_HELPER_NAME]: importFromCwd
  }
  if (state.toolNames.has('read')) {
    sandbox.read = readLocalText
  }
  if (state.toolNames.has('write')) {
    sandbox.write = async (path: string, content: string) =>
      resultText(await callHost('write', { path, content }), 'write')
  }
  sandbox.console = makeConsole([])
  state.context = vm.createContext(sandbox)
}

const IMPORT_HELPER_NAME = '__yachiyoJsReplImport__'

function refreshCallContext(cwd: string, consoleLines: string[]): void {
  if (!state.context) throw new Error('JavaScript REPL worker is not initialized.')
  state.cwdRef.value = cwd
  const mockProcess = createMockProcess(state.cwdRef)
  state.context.require = createCwdRequire(state.cwdRef, mockProcess)
  state.context.process = mockProcess
  state.context.__dirname = cwd
  state.context.__filename = resolvePath(cwd, 'jsRepl.js')
  state.context.console = makeConsole(consoleLines)
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes('Script execution timed out'))
  )
}

async function executeCell(
  message: Extract<JsReplParentMessage, { type: 'execute' }>
): Promise<void> {
  if (state.activeRun) throw new Error('JavaScript REPL received overlapping cells.')
  if (message.reset || !state.context) resetContext()

  const cwd = resolveReplCallCwd(state.workspacePath, message.cwd)
  const run: ActiveRun = {
    runId: message.runId,
    consoleLines: [],
    displayOutputs: [],
    asyncErrors: []
  }
  state.activeRun = run
  refreshCallContext(cwd, run.consoleLines)

  let result: string | undefined
  let error: string | undefined
  let timedOut = false
  try {
    const compiled = compileJsReplCell(message.code)
    const script = new vm.Script(compiled.source, { filename: 'jsRepl' })
    const rawResult = script.runInContext(state.context!, { timeout: message.timeoutMs })
    const resolved = await rawResult
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (run.asyncErrors.length > 0) {
      const [first] = run.asyncErrors
      throw new Error(`Unhandled asynchronous error: ${errorMessage(first)}`, { cause: first })
    }
    result = formatValue(resolved)
  } catch (caught) {
    timedOut = isTimeoutError(caught)
    error = timedOut
      ? `Script execution timed out (${Math.round(message.timeoutMs / 1000)}s limit).`
      : formatThrownError(caught)
  } finally {
    state.timerTracker?.clearAll()
    state.activeRun = undefined
  }

  const response: JsReplWorkerMessage = {
    type: 'result',
    runId: message.runId,
    ...(result !== undefined ? { result } : {}),
    consoleLines: run.consoleLines,
    displayOutputs: run.displayOutputs,
    ...(error ? { error } : {}),
    timedOut
  }
  port.postMessage(response)
}

function settleHostCall(message: Extract<JsReplParentMessage, { type: 'toolResult' }>): void {
  const pending = state.pendingHostCalls.get(message.callId)
  if (!pending || pending.runId !== message.runId) return
  state.pendingHostCalls.delete(message.callId)
  if (message.result.ok) pending.resolve(message.result.value)
  else pending.reject(errorFromSerialized(message.result.error))
}

function settleFetchCall(message: Extract<JsReplParentMessage, { type: 'fetchResult' }>): void {
  const pending = state.pendingHostCalls.get(message.callId)
  if (!pending || pending.runId !== message.runId) return
  state.pendingHostCalls.delete(message.callId)
  pending.resolve(message.result)
}

process.on('unhandledRejection', (reason) => {
  if (state.activeRun) {
    state.activeRun.asyncErrors.push(reason)
    return
  }
  setImmediate(() => {
    throw reason
  })
})

port.on('message', (message: JsReplParentMessage) => {
  if (message.type === 'init') {
    state.workspacePath = message.workspacePath
    state.toolNames = new Set(message.toolNames)
    resetContext()
    const ready: JsReplWorkerMessage = { type: 'ready' }
    port.postMessage(ready)
    return
  }
  if (message.type === 'toolResult') {
    settleHostCall(message)
    return
  }
  if (message.type === 'fetchResult') {
    settleFetchCall(message)
    return
  }
  void executeCell(message).catch((error) => {
    const response: JsReplWorkerMessage = {
      type: 'result',
      runId: message.runId,
      consoleLines: [],
      displayOutputs: [],
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      timedOut: false
    }
    port.postMessage(response)
  })
})
