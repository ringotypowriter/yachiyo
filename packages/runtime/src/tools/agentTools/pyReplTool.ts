import type { PyReplToolCallDetails } from '@yachiyo/shared/protocol'
import type { Tool, ToolExecutionOptions } from 'ai'

import {
  ensurePythonRuntime,
  stagePythonRunner,
  type PythonRuntime
} from '../../services/python/managedPythonRuntime.ts'
import {
  DEFAULT_REPL_TIMEOUT_SECONDS,
  MAX_REPL_DETAILS_OUTPUT_CHARS,
  MAX_REPL_MODEL_OUTPUT_CHARS,
  pyReplToolInputSchema,
  type AgentToolContext,
  type PyReplToolInput,
  type PyReplToolOutput,
  type ToolContentBlock,
  takeTail,
  textContent,
  toToolModelOutput
} from './shared.ts'
import {
  createReplToolExecutionOptions,
  isReplToolName,
  resolveReplToolCwd
} from './replNestedTools.ts'
import {
  createPyReplKernel,
  type PyReplExecutionResult,
  type PyReplKernel,
  type PyReplOutputEvent
} from './pyReplKernel.ts'
import { PyReplToolBridge } from './pyReplToolBridge.ts'

const INITIALIZATION_TIMEOUT_MS = 10 * 60 * 1000
const PROCESS_SUPERVISION_UNAVAILABLE = 'pyRepl process supervision is unavailable.'

type MimeBundle = Extract<PyReplOutputEvent, { type: 'display' | 'result' }>['bundle']

interface ReplImage {
  data: string
  mediaType: 'image/png' | 'image/jpeg'
}

interface BundleRendering {
  text: string
  images: ReplImage[]
}

interface InitializedResources {
  runtime: PythonRuntime
  bridge: PyReplToolBridge
  kernel: PyReplKernel
}

interface ShapedExecution {
  text: string
  stdout: string
  stderr: string
  displayOutput: string | undefined
  result: string | undefined
  error: string | undefined
  images: ReplImage[]
}

export interface PyReplToolDependencies {
  resolveTool?: (name: string) => unknown
  listToolNames?: () => string[]
  runnerPath?: string | URL
  ensureRuntime?: typeof ensurePythonRuntime
  createKernel?: typeof createPyReplKernel
}

class PyReplToolHandle {
  private readonly context: AgentToolContext
  private readonly dependencies: PyReplToolDependencies
  private readonly lifecycle = new AbortController()
  private resources: InitializedResources | undefined
  private initialization: Promise<InitializedResources> | undefined
  private disposal: Promise<void> | undefined
  private disposed = false

  constructor(context: AgentToolContext, dependencies: PyReplToolDependencies) {
    this.context = context
    this.dependencies = dependencies
  }

  async execute(
    input: PyReplToolInput,
    executionOptions: ToolExecutionOptions
  ): Promise<PyReplExecutionResult> {
    const resources = await this.getResources(executionOptions.abortSignal)
    return await resources.kernel.execute({
      code: input.code,
      cwd: resolveRequiredCwd(this.context.workspacePath, input.cwd),
      availableTools: listAvailableTools(this.context, this.dependencies),
      reset: input.reset ?? false,
      timeoutMs: (input.timeout ?? DEFAULT_REPL_TIMEOUT_SECONDS) * 1000,
      signal: executionOptions.abortSignal,
      executionOptions,
      resolveTool: this.dependencies.resolveTool ?? (() => undefined)
    })
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async getResources(signal?: AbortSignal): Promise<InitializedResources> {
    if (this.disposed) throw new Error('Python REPL tool is disposed.')
    if (this.resources) return this.resources
    const initialization = this.initialization ?? this.initialize(signal)
    this.initialization = initialization
    try {
      return await initialization
    } finally {
      if (this.initialization === initialization) this.initialization = undefined
    }
  }

  private async initialize(signal?: AbortSignal): Promise<InitializedResources> {
    if (!this.dependencies.ensureRuntime && !this.context.processBroker) {
      throw new Error(PROCESS_SUPERVISION_UNAVAILABLE)
    }

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error('Python REPL initialization timed out after 10 minutes.'))
    }, INITIALIZATION_TIMEOUT_MS)
    timeout.unref()
    const signals = [this.lifecycle.signal, timeoutController.signal]
    if (signal) signals.push(signal)
    const initializationSignal = AbortSignal.any(signals)
    let runtime: PythonRuntime | undefined
    let bridge: PyReplToolBridge | undefined
    let kernel: PyReplKernel | undefined

    try {
      throwIfAborted(initializationSignal)
      const ensureRuntime = this.dependencies.ensureRuntime ?? ensurePythonRuntime
      runtime = await ensureRuntime({
        processBroker: this.context.processBroker!,
        workspacePath: this.context.workspacePath,
        signal: initializationSignal
      })
      throwIfAborted(initializationSignal)
      const runnerPath = await stagePythonRunner(
        this.dependencies.runnerPath ?? new URL('./pyReplRunner.py', import.meta.url),
        runtime.rootPath
      )
      throwIfAborted(initializationSignal)
      bridge = new PyReplToolBridge()
      await bridge.endpoint()
      throwIfAborted(initializationSignal)
      const createKernel = this.dependencies.createKernel ?? createPyReplKernel
      kernel = createKernel({
        runtime,
        runnerPath,
        initialCwd: this.context.workspacePath,
        bridge
      })
      throwIfAborted(initializationSignal)
      const resources = { runtime, bridge, kernel }
      this.resources = resources
      return resources
    } catch (error) {
      const cleanupErrors = await cleanupResources({ runtime, bridge, kernel })
      if (cleanupErrors.length > 0) {
        const cause = error instanceof Error ? error.message : String(error)
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Python REPL initialization failed: ${cause}`
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    this.lifecycle.abort()
    try {
      await this.initialization
    } catch {
      // Initialization owns cleanup for every partially-created resource.
    }
    const resources = this.resources
    this.resources = undefined
    if (!resources) return
    const errors = await cleanupResources(resources)
    if (errors.length > 0)
      throw new AggregateError(errors, 'Failed to dispose Python REPL resources.')
  }
}

export function createTool(
  context: AgentToolContext,
  dependencies: PyReplToolDependencies = {}
): Tool<PyReplToolInput, PyReplToolOutput> {
  if (context.sandboxed) throw new Error('pyRepl is unavailable in sandboxed runs.')
  const handle = new PyReplToolHandle(context, dependencies)
  const tool: Tool<PyReplToolInput, PyReplToolOutput> & { dispose(): Promise<void> } = {
    description: buildDescription(context, dependencies),
    inputSchema: pyReplToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input, providedOptions): Promise<PyReplToolOutput> => {
      const cwdResolution = resolveReplToolCwd(context.workspacePath, input.cwd)
      if ('error' in cwdResolution) return immediateError(input, cwdResolution.error)
      if (!dependencies.ensureRuntime && !context.processBroker) {
        return immediateError(input, PROCESS_SUPERVISION_UNAVAILABLE)
      }

      const executionOptions = providedOptions ?? createReplToolExecutionOptions('pyRepl')
      let result: PyReplExecutionResult
      try {
        result = await handle.execute(input, executionOptions)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return immediateError(input, message)
      }

      return await outputForExecution(context, input, result)
    },
    dispose: () => handle.dispose()
  }
  return tool
}

function resolveRequiredCwd(workspacePath: string, requested: string | undefined): string {
  const resolution = resolveReplToolCwd(workspacePath, requested)
  if ('error' in resolution) throw new Error(resolution.error)
  return resolution.resolved
}

function listAvailableTools(
  context: AgentToolContext,
  dependencies: PyReplToolDependencies
): string[] {
  const names = dependencies.listToolNames?.() ?? context.enabledTools ?? []
  return [...new Set(names)].filter((name) => !isReplToolName(name)).sort()
}

function buildDescription(context: AgentToolContext, dependencies: PyReplToolDependencies): string {
  const enabled = new Set(listAvailableTools(context, dependencies))
  const helpers = [
    'display(value) → emit text, JSON, Markdown, LaTeX, PNG, or JPEG output',
    ...(enabled.has('read') ? ['read(path, offset=1, limit=None) → text'] : []),
    ...(enabled.has('write') ? ['write(path, content) → result text'] : []),
    'tool.<name>(args) → synchronously invoke an enabled Yachiyo tool',
    'parallel(callables) → run up to 32 synchronous zero-argument callables in order'
  ]

  return [
    'Run ordinary Python in a persistent CPython interpreter process.',
    'This is not Jupyter or IPython: notebook APIs, `get_ipython()`, IPython magics, and `!` shell escapes are unavailable.',
    'Yachiyo’s `%pip` command is the only supported `%` command.',
    'If the workspace root contains a valid CPython 3.11+ `.venv`, pyRepl uses it; otherwise Yachiyo uses its managed CPython 3.12.14 environment.',
    'An existing but invalid workspace `.venv` is an initialization error, not a managed-environment fallback.',
    'Bindings, imports, and loop-bound objects survive for this tool lifetime; `reset: true` intentionally discards them.',
    'Final expressions are returned automatically, top-level `await` is supported, and an implicit `None` is silent.',
    '`%pip` targets the selected environment: workspace `.venv` installs change that workspace; managed installs are shared across Yachiyo pyRepl interpreters.',
    'Yachiyo does not select system/Homebrew Python, ambient active virtualenvs, Conda, or non-root virtualenv directories.',
    'Environment selection is not an OS sandbox: explicit Python file/subprocess operations and third-party build hooks retain normal process authority.',
    'On error, fix and rerun only the failed code. Timeout, abort, unsafe background work, or process failure clears the interpreter context.',
    '',
    'Prelude:',
    ...helpers.map((helper) => `- ${helper}`),
    '',
    'Helpers are synchronous except that a completed `parallel(...)` result may also be awaited.',
    '`cwd` is optional, workspace-relative, and reasserted for each cell.'
  ].join('\n')
}

async function outputForExecution(
  context: AgentToolContext,
  input: PyReplToolInput,
  result: PyReplExecutionResult
): Promise<PyReplToolOutput> {
  const shaped = shapeExecution(result)
  let outputText = shaped.text
  let contentImages = shaped.images

  if (context.isModelImageCapable === false && context.imageToTextService) {
    const descriptions = await Promise.all(
      shaped.images.map(async (image) => {
        try {
          const dataUrl = `data:${image.mediaType};base64,${image.data}`
          const description = await context.imageToTextService!.describe(dataUrl)
          return description?.altText
            ? `[Image: ${description.altText}]`
            : '[Image: (image could not be described)]'
        } catch {
          return '[Image: (image could not be described)]'
        }
      })
    )
    if (descriptions.length > 0) {
      outputText = [outputText, descriptions.join('\n')].filter(Boolean).join('\n\n')
    }
    contentImages = []
  }

  const modelTail = takeTail(outputText || '(no output)', MAX_REPL_MODEL_OUTPUT_CHARS)
  let detailsTruncated = false
  const boundDetail = (value: string): string => {
    const bounded = takeTail(value, MAX_REPL_DETAILS_OUTPUT_CHARS)
    detailsTruncated ||= bounded.truncated
    return bounded.text
  }
  const details: PyReplToolCallDetails = {
    code: input.code,
    ...(input.title ? { title: input.title } : {}),
    ...(shaped.stdout ? { stdout: boundDetail(shaped.stdout) } : {}),
    ...(shaped.stderr ? { stderr: boundDetail(shaped.stderr) } : {}),
    ...(shaped.displayOutput !== undefined
      ? { displayOutput: boundDetail(shaped.displayOutput) }
      : {}),
    ...(shaped.result !== undefined ? { result: boundDetail(shaped.result) } : {}),
    ...(shaped.error ? { error: boundDetail(shaped.error) } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.contextReset ? { contextReset: true } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {})
  }
  const boundedError = shaped.error
    ? takeTail(shaped.error, MAX_REPL_DETAILS_OUTPUT_CHARS)
    : undefined
  if (boundedError?.truncated) detailsTruncated = true
  const content: ToolContentBlock[] = [
    ...textContent(modelTail.text),
    ...contentImages.map((image): ToolContentBlock => ({
      type: 'image-data',
      data: image.data,
      mediaType: image.mediaType
    }))
  ]

  return {
    content,
    details,
    metadata: {
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(modelTail.truncated || detailsTruncated ? { truncated: true } : {})
    },
    ...(boundedError ? { error: boundedError.text } : {})
  }
}

function shapeExecution(result: PyReplExecutionResult): ShapedExecution {
  const sections: Array<{ label: string; text: string }> = []
  const stdoutParts: string[] = []
  const stderrParts: string[] = []
  const displayOutputs: string[] = []
  const images: ReplImage[] = []
  const errorEvents: Array<Extract<PyReplOutputEvent, { type: 'error' }>> = []
  let displayIndex = 0
  let resultOutput: string | undefined

  for (const event of result.events) {
    if (event.type === 'stdout' || event.type === 'stderr') {
      const parts = event.type === 'stdout' ? stdoutParts : stderrParts
      parts.push(event.data)
      const previous = sections.at(-1)
      if (previous?.label === event.type) previous.text += event.data
      else sections.push({ label: event.type, text: event.data })
      continue
    }
    if (event.type === 'error') {
      errorEvents.push(event)
      sections.push({ label: 'error', text: renderPythonError(event) })
      continue
    }
    if (!('bundle' in event)) continue

    const rendered = renderBundle(event.bundle)
    images.push(...rendered.images)
    if (event.type === 'display') {
      displayIndex += 1
      displayOutputs.push(rendered.text)
      sections.push({ label: `display ${displayIndex}`, text: rendered.text })
    } else {
      resultOutput = rendered.text
      sections.push({ label: 'result', text: rendered.text })
    }
  }

  const eventError = errorEvents.at(-1)
  const executionError = eventError ? renderPythonError(eventError) : result.failure
  if (result.failure && !eventError) sections.push({ label: 'error', text: result.failure })
  const stateNotice = createStateNotice(result)
  if (stateNotice) sections.push({ label: 'state', text: stateNotice })
  const text =
    sections.length > 0
      ? sections.map((section) => `[${section.label}]\n${section.text}`).join('\n\n')
      : '(no output)'

  return {
    text,
    stdout: stdoutParts.join(''),
    stderr: stderrParts.join(''),
    displayOutput: displayOutputs.length > 0 ? displayOutputs.join('\n\n') : undefined,
    result: resultOutput,
    error: executionError,
    images
  }
}

function renderBundle(bundle: MimeBundle): BundleRendering {
  const textParts: string[] = []
  const seen = new Set<string>()
  if (bundle['application/json'] !== undefined) {
    const json = JSON.stringify(bundle['application/json'], null, 2)
    textParts.push(json)
    seen.add(json)
  } else if (bundle['text/plain'] !== undefined) {
    textParts.push(bundle['text/plain'])
    seen.add(bundle['text/plain'])
  }

  for (const mediaType of ['text/markdown', 'text/latex'] as const) {
    const value = bundle[mediaType]
    if (value === undefined || seen.has(value)) continue
    textParts.push(`[${mediaType}]\n${value}`)
    seen.add(value)
  }

  const images: ReplImage[] = []
  for (const mediaType of ['image/png', 'image/jpeg'] as const) {
    const data = bundle[mediaType]
    if (data === undefined) continue
    images.push({ data, mediaType })
    textParts.push(`[${mediaType}, ${decodedBase64Bytes(data)} bytes]`)
  }
  return { text: textParts.join('\n\n'), images }
}

function renderPythonError(event: Extract<PyReplOutputEvent, { type: 'error' }>): string {
  const traceback = event.traceback.join('')
  if (traceback) return traceback
  return event.evalue ? `${event.ename}: ${event.evalue}` : event.ename
}

function createStateNotice(result: PyReplExecutionResult): string | undefined {
  if (!result.contextReset) return undefined
  const reason = result.resetReason ?? 'Python context was reset.'
  if (result.resetScope === 'before') {
    if (result.failureKind === 'startup') {
      return `${reason} Bindings from earlier cells were discarded before this cell; this cell did not start.`
    }
    return `${reason} Bindings from earlier cells were discarded before this cell; bindings created by this cell remain available.`
  }
  return `${reason} Bindings from earlier cells and this cell were discarded.`
}

function immediateError(input: PyReplToolInput, message: string): PyReplToolOutput {
  const model = takeTail(`[error]\n${message}`, MAX_REPL_MODEL_OUTPUT_CHARS)
  const detail = takeTail(message, MAX_REPL_DETAILS_OUTPUT_CHARS)
  const details: PyReplToolCallDetails = {
    code: input.code,
    ...(input.title ? { title: input.title } : {}),
    error: detail.text,
    ...(input.cwd ? { cwd: input.cwd } : {})
  }
  return {
    content: textContent(model.text),
    details,
    metadata: {
      ...(model.truncated || detail.truncated ? { truncated: true } : {})
    },
    error: detail.text
  }
}

async function cleanupResources(resources: {
  runtime?: PythonRuntime
  bridge?: PyReplToolBridge
  kernel?: PyReplKernel
}): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const dispose of [
    resources.kernel ? () => resources.kernel!.dispose() : undefined,
    resources.bridge ? () => resources.bridge!.dispose() : undefined,
    resources.runtime ? () => resources.runtime!.release() : undefined
  ]) {
    if (!dispose) continue
    try {
      await dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The operation was aborted.', 'AbortError')
}
