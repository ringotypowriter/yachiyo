import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import type { ToolExecutionOptions } from 'ai'

import type { PythonRuntime } from '../../services/python/managedPythonRuntime.ts'
import {
  createPyReplKernel,
  type PyReplExecutionResult,
  type PyReplKernel,
  type PyReplKernelCall,
  type PyReplKernelOptions
} from './pyReplKernel.ts'
import { createTool } from './pyReplTool.ts'
import {
  MAX_REPL_DETAILS_OUTPUT_CHARS,
  MAX_REPL_MODEL_OUTPUT_CHARS,
  pyReplToolInputSchema,
  type AgentToolContext,
  type PyReplToolInput,
  type PyReplToolOutput
} from './shared.ts'

interface KernelDouble {
  execute(call: PyReplKernelCall): Promise<PyReplExecutionResult>
  dispose(): Promise<void>
}

interface TrackedPyReplTool {
  description?: string
  execute(input: PyReplCallInput, options?: ToolExecutionOptions): Promise<PyReplToolOutput>
  dispose(): Promise<void>
}

type PyReplCallInput = Omit<PyReplToolInput, 'reset' | 'timeout'> &
  Partial<Pick<PyReplToolInput, 'reset' | 'timeout'>>

const temporaryDirectories: string[] = []
const createdTools: TrackedPyReplTool[] = []

function temporaryDirectory(label: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `yachiyo-py-tool-${label}-`)))
  temporaryDirectories.push(directory)
  return directory
}

function executionResult(overrides: Partial<PyReplExecutionResult> = {}): PyReplExecutionResult {
  return {
    events: [],
    status: 'ok',
    cancelled: false,
    timedOut: false,
    contextReset: false,
    resetReason: undefined,
    resetScope: undefined,
    failureKind: undefined,
    failure: undefined,
    ...overrides
  }
}

function runtimeDouble(directory: string, release: () => Promise<void>): PythonRuntime {
  const rootPath = join(directory, 'python')
  mkdirSync(rootPath, { recursive: true })
  return {
    kind: 'managed',
    rootPath,
    pythonPath: join(rootPath, 'environment', 'bin', 'python'),
    uvPath: join(rootPath, 'uv'),
    environmentPath: join(rootPath, 'environment'),
    env: {},
    version: '3.12.14',
    acquireProcessLease: async () => async () => undefined,
    release
  }
}

function kernelFactory(
  kernel: KernelDouble,
  onCreate?: (options: PyReplKernelOptions) => void
): typeof createPyReplKernel {
  return ((options: PyReplKernelOptions): PyReplKernel => {
    onCreate?.(options)
    return kernel as unknown as PyReplKernel
  }) as typeof createPyReplKernel
}

function trackTool(tool: ReturnType<typeof createTool>): TrackedPyReplTool {
  const tracked = tool as unknown as TrackedPyReplTool
  createdTools.push(tracked)
  return tracked
}

function textOf(output: PyReplToolOutput): string {
  return output.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

afterEach(async () => {
  await Promise.all(createdTools.splice(0).map((tool) => tool.dispose().catch(() => undefined)))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('pyRepl tool schema and authority', () => {
  it('applies persistent-context defaults and validates bounded workspace-relative inputs', () => {
    assert.deepEqual(pyReplToolInputSchema.parse({ code: '6 * 7' }), {
      code: '6 * 7',
      timeout: 60,
      reset: false
    })
    assert.deepEqual(
      pyReplToolInputSchema.parse({
        code: 'value',
        title: ' inspect value ',
        timeout: 120,
        reset: true,
        cwd: 'src/nested'
      }),
      {
        code: 'value',
        title: 'inspect value',
        timeout: 120,
        reset: true,
        cwd: 'src/nested'
      }
    )
    assert.throws(() => pyReplToolInputSchema.parse({ code: '', timeout: 30 }))
    assert.throws(() => pyReplToolInputSchema.parse({ code: 'pass', timeout: 121 }))
    assert.throws(() => pyReplToolInputSchema.parse({ code: 'pass', cwd: '../outside' }))
    assert.throws(() => pyReplToolInputSchema.parse({ code: 'pass', unexpected: 'not allowed' }))
  })

  it('rejects sandboxed contexts at construction', () => {
    assert.throws(
      () => createTool({ workspacePath: '/workspace', sandboxed: true }),
      /unavailable in sandboxed runs/u
    )
  })

  it('returns an immediate error when native process supervision is unavailable', async () => {
    const tool = trackTool(createTool({ workspacePath: '/workspace' }))
    const output = await tool.execute({ code: '1 + 1', title: 'calculate' })
    assert.equal(output.error, 'pyRepl process supervision is unavailable.')
    assert.deepEqual(output.details, {
      code: '1 + 1',
      title: 'calculate',
      error: 'pyRepl process supervision is unavailable.'
    })
    assert.equal(textOf(output), '[error]\npyRepl process supervision is unavailable.')
  })

  it('rejects an invalid cwd before provisioning the runtime', async () => {
    const workspacePath = temporaryDirectory('invalid-cwd')
    let ensured = false
    const tool = trackTool(
      createTool(
        { workspacePath },
        {
          ensureRuntime: async () => {
            ensured = true
            throw new Error('unexpected provisioning')
          }
        }
      )
    )
    const output = await tool.execute({ code: 'pass', cwd: 'missing' })
    assert.equal(ensured, false)
    assert.match(output.error ?? '', /directory does not exist/u)
    assert.equal(output.details.cwd, 'missing')
  })

  it('advertises only helpers backed by enabled non-REPL tools', () => {
    const rootPath = temporaryDirectory('description')
    const runtime = runtimeDouble(rootPath, async () => undefined)
    const kernel: KernelDouble = {
      execute: async () => executionResult(),
      dispose: async () => undefined
    }
    const tool = trackTool(
      createTool(
        { workspacePath: rootPath, enabledTools: ['write', 'pyRepl', 'read', 'jsRepl'] },
        {
          ensureRuntime: async () => runtime,
          createKernel: kernelFactory(kernel)
        }
      )
    )
    assert.match(tool.description ?? '', /read\(path, offset=1, limit=None\)/u)
    assert.match(tool.description ?? '', /write\(path, content\)/u)
    assert.doesNotMatch(tool.description ?? '', /jsRepl/u)
    assert.match(tool.description ?? '', /workspace root contains a valid CPython 3\.11\+ `.venv`/u)
    assert.match(tool.description ?? '', /`%pip` targets the selected environment/u)
  })
})

describe('pyRepl tool lifecycle', () => {
  it('initializes once, stages the runner, and forwards each cell contract exactly', async () => {
    const rootPath = temporaryDirectory('forwarding')
    const workspacePath = join(rootPath, 'workspace')
    const nestedPath = join(workspacePath, 'nested')
    mkdirSync(nestedPath, { recursive: true })
    let ensureCalls = 0
    let ensuredWorkspacePath: string | undefined
    let releaseCalls = 0
    let disposeCalls = 0
    const calls: PyReplKernelCall[] = []
    let kernelOptions: PyReplKernelOptions | undefined
    const runtime = runtimeDouble(rootPath, async () => {
      releaseCalls += 1
    })
    const kernel: KernelDouble = {
      execute: async (call) => {
        calls.push(call)
        return executionResult({
          events: [{ type: 'result', bundle: { 'text/plain': String(calls.length) } }]
        })
      },
      dispose: async () => {
        disposeCalls += 1
      }
    }
    const resolvedTool = { execute: async () => 'nested' }
    const context: AgentToolContext = {
      workspacePath,
      enabledTools: ['write', 'read', 'write', 'jsRepl', 'pyRepl']
    }
    const tool = trackTool(
      createTool(context, {
        ensureRuntime: async (options) => {
          ensureCalls += 1
          ensuredWorkspacePath = options.workspacePath
          return runtime
        },
        createKernel: kernelFactory(kernel, (options) => {
          kernelOptions = options
        }),
        resolveTool: (name) => (name === 'read' ? resolvedTool : undefined),
        listToolNames: () => ['write', 'read', 'write', 'jsRepl', 'pyRepl']
      })
    )
    const options: ToolExecutionOptions = { toolCallId: 'outer-call', messages: [] }

    const first = await tool.execute(
      { code: 'first', cwd: 'nested', timeout: 17, reset: true },
      options
    )
    const second = await tool.execute({ code: 'second' })

    assert.equal(ensureCalls, 1)
    assert.equal(ensuredWorkspacePath, workspacePath)
    assert.equal(kernelOptions?.runtime, runtime)
    assert.equal(kernelOptions?.initialCwd, workspacePath)
    assert.equal(
      kernelOptions?.runnerPath.startsWith(join(realpathSync(runtime.rootPath), 'runners')),
      true
    )
    assert.equal(existsSync(kernelOptions?.runnerPath ?? ''), true)
    assert.equal(kernelOptions?.bridge.constructor.name, 'PyReplToolBridge')
    assert.equal(calls.length, 2)
    assert.deepEqual(
      calls.map(({ code, cwd, availableTools, reset, timeoutMs }) => ({
        code,
        cwd,
        availableTools,
        reset,
        timeoutMs
      })),
      [
        {
          code: 'first',
          cwd: nestedPath,
          availableTools: ['read', 'write'],
          reset: true,
          timeoutMs: 17_000
        },
        {
          code: 'second',
          cwd: workspacePath,
          availableTools: ['read', 'write'],
          reset: false,
          timeoutMs: 60_000
        }
      ]
    )
    assert.equal(calls[0]?.executionOptions, options)
    assert.equal(calls[0]?.resolveTool('read'), resolvedTool)
    assert.match(calls[1]?.executionOptions.toolCallId ?? '', /^py-repl-/u)
    assert.equal(first.details.result, '1')
    assert.equal(second.details.result, '2')

    await tool.dispose()
    await tool.dispose()
    assert.equal(disposeCalls, 1)
    assert.equal(releaseCalls, 1)
  })

  it('shares one in-flight initialization across concurrent calls', async () => {
    const rootPath = temporaryDirectory('single-flight')
    let resolveRuntime!: (runtime: PythonRuntime) => void
    const pendingRuntime = new Promise<PythonRuntime>((resolve) => {
      resolveRuntime = resolve
    })
    let ensureCalls = 0
    let executions = 0
    const runtime = runtimeDouble(rootPath, async () => undefined)
    const kernel: KernelDouble = {
      execute: async () => {
        executions += 1
        return executionResult()
      },
      dispose: async () => undefined
    }
    const tool = trackTool(
      createTool(
        { workspacePath: rootPath },
        {
          ensureRuntime: async () => {
            ensureCalls += 1
            return await pendingRuntime
          },
          createKernel: kernelFactory(kernel)
        }
      )
    )

    const first = tool.execute({ code: 'first' })
    const second = tool.execute({ code: 'second' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(ensureCalls, 1)
    resolveRuntime(runtime)
    await Promise.all([first, second])
    assert.equal(executions, 2)
  })

  it('releases a prepared runtime when later initialization fails', async () => {
    const rootPath = temporaryDirectory('failed-init')
    let releases = 0
    const runtime = runtimeDouble(rootPath, async () => {
      releases += 1
    })
    const tool = trackTool(
      createTool(
        { workspacePath: rootPath },
        {
          ensureRuntime: async () => runtime,
          createKernel: (() => {
            throw new Error('kernel construction failed')
          }) as typeof createPyReplKernel
        }
      )
    )

    const output = await tool.execute({ code: 'pass' })
    assert.equal(output.error, 'kernel construction failed')
    assert.equal(releases, 1)
  })

  it('aborts initialization and settles execution when disposed before provisioning completes', async () => {
    const rootPath = temporaryDirectory('abort-init')
    let initializationStarted = false
    let initializationAborted = false
    const tool = trackTool(
      createTool(
        { workspacePath: rootPath },
        {
          ensureRuntime: async ({ signal }) => {
            initializationStarted = true
            return await new Promise<PythonRuntime>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  initializationAborted = true
                  reject(signal.reason)
                },
                { once: true }
              )
            })
          }
        }
      )
    )

    const execution = tool.execute({ code: 'pass' })
    while (!initializationStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await tool.dispose()
    const output = await execution
    assert.equal(initializationAborted, true)
    assert.match(output.error ?? '', /abort/u)
  })

  it('continues cleanup after a kernel disposal failure and reports all cleanup errors', async () => {
    const rootPath = temporaryDirectory('cleanup-errors')
    let releases = 0
    const runtime = runtimeDouble(rootPath, async () => {
      releases += 1
      throw new Error('runtime release failed')
    })
    const kernel: KernelDouble = {
      execute: async () => executionResult(),
      dispose: async () => {
        throw new Error('kernel disposal failed')
      }
    }
    const tool = trackTool(
      createTool(
        { workspacePath: rootPath },
        {
          ensureRuntime: async () => runtime,
          createKernel: kernelFactory(kernel)
        }
      )
    )
    await tool.execute({ code: 'pass' })

    await assert.rejects(
      tool.dispose(),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors.some((item) => String(item).includes('kernel disposal failed')) &&
        error.errors.some((item) => String(item).includes('runtime release failed'))
    )
    assert.equal(releases, 1)
  })
})

describe('pyRepl tool result shaping', () => {
  function toolForResult(
    result: PyReplExecutionResult,
    context: Partial<AgentToolContext> = {}
  ): TrackedPyReplTool {
    const rootPath = temporaryDirectory('result')
    const runtime = runtimeDouble(rootPath, async () => undefined)
    const kernel: KernelDouble = {
      execute: async () => result,
      dispose: async () => undefined
    }
    return trackTool(
      createTool(
        { workspacePath: rootPath, ...context },
        {
          ensureRuntime: async () => runtime,
          createKernel: kernelFactory(kernel)
        }
      )
    )
  }

  it('preserves event order while aggregating stdout, stderr, displays, and the result', async () => {
    const tool = toolForResult(
      executionResult({
        events: [
          { type: 'stdout', data: 'out-1' },
          { type: 'stderr', data: 'err' },
          { type: 'stdout', data: 'out-2' },
          { type: 'display', bundle: { 'text/plain': 'shown' } },
          { type: 'result', bundle: { 'text/plain': '42' } }
        ]
      })
    )
    const output = await tool.execute({ code: 'answer', title: 'inspect', cwd: '.' })

    assert.equal(
      textOf(output),
      '[stdout]\nout-1\n\n[stderr]\nerr\n\n[stdout]\nout-2\n\n[display 1]\nshown\n\n[result]\n42'
    )
    assert.deepEqual(output.details, {
      code: 'answer',
      title: 'inspect',
      stdout: 'out-1out-2',
      stderr: 'err',
      displayOutput: 'shown',
      result: '42',
      cwd: '.'
    })
    assert.deepEqual(output.metadata, {})
  })

  it('prefers JSON and appends distinct Markdown, LaTeX, and native images', async () => {
    const png = 'aGVsbG8='
    const jpeg = 'd29ybGQ='
    const tool = toolForResult(
      executionResult({
        events: [
          {
            type: 'result',
            bundle: {
              'application/json': { answer: 42 },
              'text/plain': 'plain fallback',
              'text/markdown': '**answer**',
              'text/latex': 'x^2',
              'image/png': png,
              'image/jpeg': jpeg
            }
          }
        ]
      })
    )
    const output = await tool.execute({ code: 'rich()' })

    assert.equal(
      output.details.result,
      '{\n  "answer": 42\n}\n\n[text/markdown]\n**answer**\n\n[text/latex]\nx^2\n\n[image/png, 5 bytes]\n\n[image/jpeg, 5 bytes]'
    )
    assert.doesNotMatch(output.details.result ?? '', /plain fallback/u)
    assert.deepEqual(output.content.slice(1), [
      { type: 'image-data', data: png, mediaType: 'image/png' },
      { type: 'image-data', data: jpeg, mediaType: 'image/jpeg' }
    ])
  })

  it('returns Python errors and an exact context-reset notice', async () => {
    const traceback = 'Traceback (most recent call last):\nValueError: bad\n'
    const tool = toolForResult(
      executionResult({
        status: 'error',
        contextReset: true,
        resetReason: 'Unsafe background work remained.',
        resetScope: 'after',
        events: [
          {
            type: 'error',
            ename: 'ValueError',
            evalue: 'bad',
            traceback: [traceback]
          }
        ]
      })
    )
    const output = await tool.execute({ code: 'raise ValueError("bad")' })

    assert.equal(output.error, traceback)
    assert.equal(output.details.error, traceback)
    assert.equal(output.details.contextReset, true)
    assert.equal(
      textOf(output),
      `[error]\n${traceback}\n\n[state]\nUnsafe background work remained. Bindings from earlier cells and this cell were discarded.`
    )
  })

  it('marks timeouts and bounds model and detail tails independently', async () => {
    const largeOutput = 'prefix-' + 'x'.repeat(MAX_REPL_MODEL_OUTPUT_CHARS + 1)
    const tool = toolForResult(
      executionResult({
        status: 'cancelled',
        cancelled: true,
        timedOut: true,
        contextReset: true,
        resetReason: 'Cell timed out.',
        resetScope: 'after',
        failureKind: 'timeout',
        events: [{ type: 'stdout', data: largeOutput }]
      })
    )
    const output = await tool.execute({ code: 'while True: pass' })

    assert.equal(textOf(output).length, MAX_REPL_MODEL_OUTPUT_CHARS)
    assert.equal(output.details.stdout?.length, MAX_REPL_DETAILS_OUTPUT_CHARS)
    assert.equal(output.details.stdout, largeOutput.slice(-MAX_REPL_DETAILS_OUTPUT_CHARS))
    assert.equal(output.details.timedOut, true)
    assert.equal(output.details.contextReset, true)
    assert.deepEqual(output.metadata, { timedOut: true, truncated: true })
  })

  it('describes images for a non-vision model and omits native image blocks', async () => {
    const describedUrls: string[] = []
    const tool = toolForResult(
      executionResult({
        events: [
          {
            type: 'result',
            bundle: {
              'text/plain': 'chart',
              'image/png': 'aGVsbG8=',
              'image/jpeg': 'd29ybGQ='
            }
          }
        ]
      }),
      {
        isModelImageCapable: false,
        imageToTextService: {
          describe: async (dataUrl) => {
            describedUrls.push(dataUrl)
            if (dataUrl.startsWith('data:image/png')) {
              return { imageHash: 'png', altText: 'a rising line chart' }
            }
            throw new Error('description failed')
          },
          inspect: async () => null
        }
      }
    )
    const output = await tool.execute({ code: 'plot()' })

    assert.equal(describedUrls.length, 2)
    assert.deepEqual(output.content, [
      {
        type: 'text',
        text: '[result]\nchart\n\n[image/png, 5 bytes]\n\n[image/jpeg, 5 bytes]\n\n[Image: a rising line chart]\n[Image: (image could not be described)]'
      }
    ])
    assert.match(output.details.result ?? '', /\[image\/png, 5 bytes\]/u)
  })

  it('renders a silent implicit None cell as no output', async () => {
    const tool = toolForResult(executionResult())
    const output = await tool.execute({ code: 'value = None' })
    assert.equal(textOf(output), '(no output)')
    assert.deepEqual(output.details, { code: 'value = None' })
  })
})
