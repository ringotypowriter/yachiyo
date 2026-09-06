import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten'
import { compileJsReplCell } from './jsReplCellCompiler.ts'
import { MAX_REPL_DETAILS_OUTPUT_CHARS } from './shared.ts'

export const ORCHESTRATION_TOOL_NAMES = [
  'read',
  'grep',
  'glob',
  'skillsRead',
  'querySource',
  'webRead',
  'webSearch'
] as const
export const ORCHESTRATION_PAYLOAD_BYTES = 8 * 1024 * 1024

export function isOrchestrationTool(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.some((allowed) => allowed === name)
}

export function orchestrationJson(value: unknown): string {
  const json = JSON.stringify(value ?? null)
  if (Buffer.byteLength(json) > ORCHESTRATION_PAYLOAD_BYTES)
    throw new Error('JavaScript bridge payload exceeds 8 MiB.')
  return json
}

interface CellResult {
  result?: string
  consoleLines: string[]
  displayOutputs: string[]
  error?: string
  timedOut: boolean
}

export interface OrchestrationKernel {
  execute(code: string, timeoutMs: number): Promise<CellResult>
  dispose(): void
}

export async function createOrchestrationKernel(
  toolNames: readonly string[],
  callTool: (name: string, input: unknown) => Promise<unknown>
): Promise<OrchestrationKernel> {
  const quickjs = await getQuickJS()
  const runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(64 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  const vm = runtime.newContext()
  let deadline = Infinity
  let cell: CellResult | undefined
  let outputSize = 0
  let disposed = false
  let calls = 0
  let pendingBytes = 0
  let wake: (() => void) | undefined
  const pending = new Set<QuickJSDeferredPromise>()
  runtime.setInterruptHandler(() => Date.now() >= deadline)

  const output = vm.newFunction('__output', (kind, text) => {
    if (!cell || outputSize >= MAX_REPL_DETAILS_OUTPUT_CHARS) return vm.undefined
    const value = vm.getString(text).slice(0, MAX_REPL_DETAILS_OUTPUT_CHARS - outputSize)
    outputSize += value.length + 1
    const target = vm.getString(kind) === 'console' ? cell.consoleLines : cell.displayOutputs
    target.push(value)
    return vm.undefined
  })
  vm.setProp(vm.global, '__output', output)
  output.dispose()
  const bridge = vm.newFunction('__call', (nameHandle, jsonHandle) => {
    if (++calls > 100) return { error: vm.newError('JavaScript cell exceeds 100 tool calls.') }
    const name = vm.getString(nameHandle)
    if (!cell || !isOrchestrationTool(name) || !toolNames.includes(name)) {
      return { error: vm.newError(`Tool ${JSON.stringify(name)} is not available.`) }
    }
    const json = vm.getString(jsonHandle)
    const bytes = Buffer.byteLength(json)
    if (bytes > ORCHESTRATION_PAYLOAD_BYTES || pendingBytes + bytes > ORCHESTRATION_PAYLOAD_BYTES) {
      return { error: vm.newError('JavaScript bridge payload exceeds 8 MiB.') }
    }
    pendingBytes += bytes
    const promise = vm.newPromise()
    pending.add(promise)
    const settle = (value: unknown): void => {
      if (disposed || !pending.has(promise)) return
      const handle = vm.newString(orchestrationJson(value))
      pending.delete(promise)
      pendingBytes -= bytes
      promise.resolve(handle)
      handle.dispose()
      promise.dispose()
      wake?.()
    }
    void Promise.resolve()
      .then(() => callTool(name, JSON.parse(json)))
      .then(
        (value) => {
          try {
            settle({ ok: true, value })
          } catch (error) {
            settle({ ok: false, error: String(error) })
          }
        },
        (error) =>
          settle({ ok: false, error: error instanceof Error ? error.message : String(error) })
      )
    return promise.handle
  })
  vm.setProp(vm.global, '__call', bridge)
  bridge.dispose()
  vm.unwrapResult(
    vm.evalCode(`
    (() => {
      const call = __call, output = __output;
      const stringify = JSON.stringify, parse = JSON.parse;
      delete globalThis.__call; delete globalThis.__output;
      const format = value => typeof value === 'string' ? value : stringify(value, null, 2);
      globalThis.display = value => { if(value !== undefined) output('display', format(value)); };
      globalThis.console = Object.fromEntries(['log','info','warn','error','debug'].map(name => [name, (...args) => output('console', args.map(format).join(' '))]));
      globalThis.tool = Object.create(null);
      for (const name of ${JSON.stringify(toolNames.filter(isOrchestrationTool))}) {
        tool[name] = async (input = {}) => {
          const result = parse(await call(name, stringify(input)));
          if (!result.ok) throw new Error(result.error);
          return result.value;
        };
      }
      ${toolNames.includes('read') ? "globalThis.read = async (path, options = {}) => { const value = await tool.read({path, ...options}); return typeof value === 'string' ? value : value.text; };" : ''}
      globalThis.parallel = async thunks => {
        const results = await Promise.allSettled(Array.from(thunks, (fn, index) => fn(index)));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        return results.map(result => result.value);
      };
      globalThis.__yachiyoJsReplImport__ = () => { throw new Error('Module imports are unavailable in orchestration cells.'); };
      globalThis.__formatResult = value => value === undefined ? undefined : format(value);
    })()
  `)
  ).dispose()

  return {
    async execute(code, timeoutMs) {
      if (cell || disposed) throw new Error('JavaScript orchestration kernel is not available.')
      const current: CellResult = { consoleLines: [], displayOutputs: [], timedOut: false }
      cell = current
      outputSize = 0
      calls = 0
      pendingBytes = 0
      deadline = Date.now() + timeoutMs
      let promise: QuickJSHandle | undefined
      try {
        const source = compileJsReplCell(code).source
        promise = vm.unwrapResult(vm.evalCode(`(${source}).then(__formatResult)`))
        while (true) {
          if (Date.now() >= deadline) throw new Error('Script execution timed out.')
          const jobs = runtime.executePendingJobs(100)
          if (jobs.error) {
            const message = jobs.error.context.dump(jobs.error)
            jobs.error.dispose()
            throw new Error(String(message?.message ?? message))
          }
          const state = vm.getPromiseState(promise)
          if (state.type !== 'pending' && runtime.hasPendingJob()) {
            if (state.type === 'fulfilled') state.value.dispose()
            else state.error.dispose()
            await new Promise<void>((resolve) => setImmediate(resolve))
            continue
          }
          if (state.type === 'fulfilled') {
            if (vm.typeof(state.value) !== 'undefined')
              current.result = vm.getString(state.value).slice(0, MAX_REPL_DETAILS_OUTPUT_CHARS)
            state.value.dispose()
            break
          }
          if (state.type === 'rejected') {
            const error = vm.dump(state.error)
            state.error.dispose()
            throw new Error(String(error?.message ?? error))
          }
          if (runtime.hasPendingJob()) {
            await new Promise<void>((resolve) => setImmediate(resolve))
          } else {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(
                () => {
                  wake = undefined
                  resolve()
                },
                Math.max(1, deadline - Date.now())
              )
              wake = () => {
                clearTimeout(timer)
                wake = undefined
                resolve()
              }
            })
          }
        }
      } catch (error) {
        current.timedOut = Date.now() >= deadline
        current.error = (
          current.timedOut
            ? 'Script execution timed out.'
            : error instanceof Error
              ? error.message
              : String(error)
        ).slice(0, MAX_REPL_DETAILS_OUTPUT_CHARS)
      } finally {
        promise?.dispose()
        for (const deferred of pending) deferred.dispose()
        pending.clear()
        cell = undefined
        deadline = Infinity
      }
      return current
    },
    dispose() {
      disposed = true
      for (const deferred of pending) deferred.dispose()
      pending.clear()
      vm.dispose()
      runtime.dispose()
    }
  }
}
