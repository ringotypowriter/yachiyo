import { Worker } from 'node:worker_threads'
import { modelMessageSchema } from 'ai'
import { z } from 'zod'
import type { ModelMessage } from '../../runtime/models/types.ts'
import { PluginExecutionError } from '../../runtime/models/runtimeErrors.ts'
import { PLUGIN_WORKER_SCRIPT } from './pluginWorkerScript.ts'
import { normalizePluginValue } from './pluginWire.ts'
import type {
  PluginContext,
  PluginDescriptor,
  PluginHooks,
  PluginSource,
  PluginToolCall,
  PluginToolResult
} from './pluginTypes.ts'

const modelResultSchema = z.object({ messages: z.array(modelMessageSchema) }).strict()
const toolDecisionSchema = z.object({ block: z.string().trim().min(1) }).strict()
const DEFAULT_HOOK_TIMEOUT_MS = 10_000

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
  label: string
}

/** Owns one execution leg. The worker is an interruption boundary, not a security sandbox. */
export class PluginSession {
  readonly descriptors: PluginDescriptor[] = []
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0
  private closedError: Error | undefined
  private termination: Promise<number> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly timeoutMs: number

  private constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
    this.worker = new Worker(PLUGIN_WORKER_SCRIPT, {
      eval: true,
      execArgv: [],
      stdout: true,
      stderr: true
    })
    this.worker.stdout.pipe(process.stderr, { end: false })
    this.worker.stderr.pipe(process.stderr, { end: false })
    this.worker.on('message', (message: { id: number; value?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      if (message.error !== undefined) {
        this.fail(new PluginExecutionError(`${pending.label}: ${message.error}`))
        return
      }
      this.pending.delete(message.id)
      pending.cleanup()
      pending.resolve(message.value)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.fail(new Error(`Plugin worker exited (${code}).`)))
  }

  static async create(
    sources: PluginSource[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<PluginSession> {
    const session = new PluginSession(options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
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
    let nextMessages = messages
    for (const [index, plugin] of this.descriptors.entries()) {
      if (!plugin.hooks.includes('beforeModel')) continue
      const result = await this.invoke(
        index,
        'beforeModel',
        { context, messages: nextMessages, stepNumber },
        signal
      )
      if (result !== undefined) {
        const parsed = modelResultSchema.safeParse(result)
        if (!parsed.success) {
          throw new PluginExecutionError(
            `Plugin ${plugin.name} beforeModel returned invalid messages: ${parsed.error.message}`
          )
        }
        nextMessages = parsed.data.messages
      }
    }
    return nextMessages
  }

  async beforeTool(
    context: PluginContext,
    call: PluginToolCall,
    signal: AbortSignal
  ): Promise<void> {
    for (const [index, plugin] of this.descriptors.entries()) {
      if (!plugin.hooks.includes('beforeTool')) continue
      const result = await this.invoke(index, 'beforeTool', { ...call, context }, signal)
      if (result === undefined) continue
      const parsed = toolDecisionSchema.safeParse(result)
      if (!parsed.success) {
        throw new PluginExecutionError(
          `Plugin ${plugin.name} beforeTool returned an invalid decision: ${parsed.error.message}`
        )
      }
      throw new PluginExecutionError(
        `Plugin ${plugin.name} blocked ${call.toolName}: ${parsed.data.block}`
      )
    }
  }

  async afterTool(
    context: PluginContext,
    result: PluginToolResult,
    signal: AbortSignal
  ): Promise<void> {
    for (const [index, plugin] of this.descriptors.entries()) {
      if (!plugin.hooks.includes('afterTool')) continue
      const value = await this.invoke(index, 'afterTool', { ...result, context }, signal)
      if (value !== undefined) {
        throw new PluginExecutionError(`Plugin ${plugin.name} afterTool must not return a value.`)
      }
    }
  }

  async dispose(): Promise<void> {
    this.fail(new Error('Plugin session closed.'))
    await this.termination
  }

  private invoke(
    pluginIndex: number,
    hook: keyof PluginHooks,
    event: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    const label = `Plugin ${this.descriptors[pluginIndex].name} ${hook}`
    const next = this.chain.then(() =>
      this.request({ type: 'hook', pluginIndex, hook, event }, label, signal)
    )
    // Rejections still reach the caller. Later calls observe the failed worker through request().
    this.chain = next.catch(() => {})
    return next
  }

  private request(
    payload: Record<string, unknown>,
    label: string,
    signal?: AbortSignal
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
