import { Worker } from 'node:worker_threads'
import type { ModelMessage } from '../../runtime/models/types.ts'
import { PluginExecutionError } from '../../runtime/models/runtimeErrors.ts'
import { PLUGIN_WORKER_SCRIPT } from './pluginWorkerScript.ts'
import { normalizePluginValue } from './pluginWire.ts'
import { pluginResultSchemas } from './pluginContract.ts'
import { PluginState } from './pluginState.ts'
import type {
  PluginContext,
  PluginDescriptor,
  PluginHooks,
  PluginEventMap,
  PluginHookDiagnostic,
  PluginResultMap,
  PluginSource,
  PluginToolCall,
  PluginToolResult
} from './pluginTypes.ts'

const DEFAULT_HOOK_TIMEOUT_MS = 10_000

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
  label: string
  stateBinding?: { name: string; context: PluginContext }
}

/** The worker is an interruption boundary, not a security sandbox. */
export class PluginSession {
  readonly descriptors: PluginDescriptor[] = []
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0
  private closedError: Error | undefined
  private termination: Promise<number> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly timeoutMs: number
  private readonly state: PluginState
  private readonly diagnostics = new Map<string, PluginHookDiagnostic>()

  private constructor(timeoutMs: number, state: PluginState) {
    this.timeoutMs = timeoutMs
    this.state = state
    this.worker = new Worker(PLUGIN_WORKER_SCRIPT, {
      eval: true,
      execArgv: [],
      stdout: true,
      stderr: true
    })
    this.worker.stdout.pipe(process.stderr, { end: false })
    this.worker.stderr.pipe(process.stderr, { end: false })
    this.worker.on(
      'message',
      (message: {
        type?: string
        id: number
        stateId?: number
        input?: unknown
        value?: unknown
        error?: string
      }) => {
        if (message.type === 'state') {
          void this.respondToState(message)
          return
        }
        const pending = this.pending.get(message.id)
        if (!pending) return
        if (message.error !== undefined) {
          this.fail(new PluginExecutionError(`${pending.label}: ${message.error}`))
          return
        }
        this.pending.delete(message.id)
        pending.cleanup()
        pending.resolve(message.value)
      }
    )
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.fail(new Error(`Plugin worker exited (${code}).`)))
  }

  static async create(
    sources: PluginSource[],
    options: { signal?: AbortSignal; timeoutMs?: number; state?: PluginState } = {}
  ): Promise<PluginSession> {
    const session = new PluginSession(
      options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      options.state ?? new PluginState()
    )
    try {
      const descriptors = await session.request(
        { type: 'initialize', sources },
        'Loading plugins',
        options.signal
      )
      session.descriptors.push(...(descriptors as PluginDescriptor[]))
      return session
    } catch (error) {
      await session.dispose()
      throw error
    }
  }

  async beforeModel(
    context: PluginContext,
    messages: ModelMessage[],
    stepNumber: number,
    signal: AbortSignal
  ): Promise<ModelMessage[]> {
    const result = await this.dispatch('beforeModel', context, { messages, stepNumber }, signal)
    return result?.messages ?? messages
  }

  get closed(): boolean {
    return this.closedError !== undefined
  }

  getDiagnostics(): PluginHookDiagnostic[] {
    return structuredClone([...this.diagnostics.values()])
  }

  async dispatch<K extends keyof PluginHooks>(
    hook: K,
    context: PluginContext,
    event: PluginEventMap[K],
    signal?: AbortSignal
  ): Promise<PluginResultMap[K] | undefined> {
    let combined: Record<string, unknown> | undefined
    for (const [index, plugin] of this.descriptors.entries()) {
      if (!plugin.hooks.includes(hook)) continue
      const result = await this.invokeValidated(
        index,
        hook,
        { ...event, ...combined, context },
        context,
        signal
      )
      if (result === undefined) continue
      const previousOptions = combined?.options ?? ('options' in event ? event.options : undefined)
      combined = {
        ...combined,
        ...result,
        ...(hook === 'beforeModel' && result.options
          ? { options: { ...(previousOptions as object), ...(result.options as object) } }
          : {}),
        ...(hook === 'afterStep' && combined?.stop === true ? { stop: true } : {}),
        ...(hook === 'afterStep' && combined?.compact === true ? { compact: true } : {})
      }
      if (hook === 'beforeTool') break
    }
    return combined as PluginResultMap[K] | undefined
  }

  private async invokeValidated(
    index: number,
    hook: keyof PluginHooks,
    event: unknown,
    context: PluginContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    const plugin = this.descriptors[index]
    const key = `${index}:${hook}`
    const diagnostic = this.diagnostics.get(key) ?? {
      name: plugin.name,
      revision: plugin.revision,
      hook,
      calls: 0,
      durationMs: 0
    }
    const started = performance.now()
    try {
      const result = await this.invoke(index, hook, event, context, signal)
      if (result === undefined) return undefined
      const parsed = pluginResultSchemas[hook].safeParse(result)
      if (!parsed.success)
        throw new PluginExecutionError(
          `Plugin ${plugin.name} ${hook} returned invalid result: ${parsed.error.message}`
        )
      if ((hook === 'beforeCompact' || hook === 'afterCompact') && parsed.data) {
        const kind = (event as { kind: string }).kind
        if (kind === 'strip' && 'summary' in parsed.data) {
          throw new PluginExecutionError(
            `Plugin ${plugin.name}: strip compaction returns messages, not a summary`
          )
        }
        if (kind === 'handoff' && hook === 'afterCompact' && 'messages' in parsed.data) {
          throw new PluginExecutionError(
            `Plugin ${plugin.name}: after handoff compaction, return summary instead of messages`
          )
        }
      }
      return parsed.data as Record<string, unknown> | undefined
    } catch (error) {
      diagnostic.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      diagnostic.calls++
      diagnostic.durationMs += Math.round(performance.now() - started)
      this.diagnostics.set(key, diagnostic)
    }
  }

  async beforeTool(
    context: PluginContext,
    call: PluginToolCall,
    signal: AbortSignal
  ): Promise<void> {
    const result = await this.dispatch('beforeTool', context, call, signal)
    if (result) {
      throw new PluginExecutionError(`Plugin blocked ${call.toolName}: ${result.block}`)
    }
  }

  async afterTool(
    context: PluginContext,
    result: PluginToolResult,
    signal: AbortSignal
  ): Promise<void> {
    await this.dispatch('afterTool', context, result, signal)
  }

  async dispose(): Promise<void> {
    this.fail(new Error('Plugin session closed.'))
    await this.termination
  }

  private invoke(
    pluginIndex: number,
    hook: keyof PluginHooks,
    event: unknown,
    context: PluginContext,
    signal?: AbortSignal
  ): Promise<unknown> {
    const label = `Plugin ${this.descriptors[pluginIndex].name} ${hook}`
    const next = this.chain.then(() =>
      this.request({ type: 'hook', pluginIndex, hook, event }, label, signal, {
        name: this.descriptors[pluginIndex].name,
        context
      })
    )
    // Rejections still reach the caller. Later calls observe the failed worker through request().
    this.chain = next.catch(() => {})
    return next
  }

  private request(
    payload: Record<string, unknown>,
    label: string,
    signal?: AbortSignal,
    stateBinding?: PendingCall['stateBinding']
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError)
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const abort = (): void =>
        this.fail(new Error(`${label} cancelled.`, { cause: signal?.reason }))
      const timeout = setTimeout(
        () => this.fail(new Error(`${label} timed out after ${this.timeoutMs}ms.`)),
        this.timeoutMs
      )
      this.pending.set(id, {
        resolve,
        reject,
        label,
        stateBinding,
        cleanup: () => {
          clearTimeout(timeout)
          signal?.removeEventListener('abort', abort)
        }
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.worker.postMessage(normalizePluginValue({ ...payload, id }))
      } catch (error) {
        this.fail(new Error(`${label} could not be sent to the worker.`, { cause: error }))
      }
    })
  }

  private async respondToState(message: {
    id: number
    stateId?: number
    input?: unknown
  }): Promise<void> {
    try {
      const binding = this.pending.get(message.id)?.stateBinding
      if (!binding || this.closed) throw new Error('State is only available during an active hook')
      const value = await this.state.request(binding.name, binding.context, message.input)
      if (!this.closed)
        this.worker.postMessage({ type: 'state-result', stateId: message.stateId, value })
    } catch (error) {
      if (!this.closed)
        this.worker.postMessage({
          type: 'state-result',
          stateId: message.stateId,
          error: error instanceof Error ? error.message : String(error)
        })
    }
  }

  private fail(error: Error): void {
    if (this.closedError) return
    this.closedError =
      error instanceof PluginExecutionError
        ? error
        : new PluginExecutionError(error.message, { cause: error })
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(this.closedError)
    }
    this.pending.clear()
    this.termination = this.worker.terminate()
  }
}
