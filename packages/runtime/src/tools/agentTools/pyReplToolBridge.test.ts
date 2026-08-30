import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'

import type { ToolExecutionOptions } from 'ai'

import {
  PyReplToolBridge,
  type PyReplBridgeCellContext,
  type PyReplBridgeEndpoint
} from './pyReplToolBridge.ts'

interface BridgeResponse {
  status: number
  headers: Headers
  body: { ok: boolean; value?: unknown; error?: string }
}

interface ActiveBridge {
  bridge: PyReplToolBridge
  endpoint: PyReplBridgeEndpoint
  controller: AbortController
}

function cellContext(
  controller: AbortController,
  overrides: Partial<PyReplBridgeCellContext> = {}
): PyReplBridgeCellContext {
  return {
    cellId: 'cell-1',
    cwd: '/workspace/nested',
    executionOptions: { toolCallId: 'parent', messages: [] },
    resolveTool: () => undefined,
    availableTools: [],
    signal: controller.signal,
    ...overrides
  }
}

async function createActiveBridge(
  overrides: Partial<PyReplBridgeCellContext> = {}
): Promise<ActiveBridge> {
  const bridge = new PyReplToolBridge()
  const endpoint = await bridge.endpoint()
  const controller = new AbortController()
  bridge.activateCell(cellContext(controller, overrides))
  return { bridge, endpoint, controller }
}

async function callBridge(
  endpoint: PyReplBridgeEndpoint,
  body: unknown,
  options: {
    method?: string
    path?: string
    token?: string | null
    contentType?: string | null
    rawBody?: BodyInit
  } = {}
): Promise<BridgeResponse> {
  const headers = new Headers()
  const token = options.token === undefined ? endpoint.token : options.token
  if (token !== null) headers.set('authorization', `Bearer ${token}`)
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType
  if (contentType !== null) headers.set('content-type', contentType)
  const response = await fetch(new URL(options.path ?? '/tool', endpoint.url), {
    method: options.method ?? 'POST',
    headers,
    body:
      (options.method ?? 'POST') === 'GET' ? undefined : (options.rawBody ?? JSON.stringify(body))
  })
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as BridgeResponse['body']
  }
}

async function rawRequest(
  endpoint: PyReplBridgeEndpoint,
  headers: Record<string, string>,
  body?: Buffer
): Promise<BridgeResponse> {
  return await new Promise<BridgeResponse>((resolve, reject) => {
    const request = httpRequest(
      endpoint.url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          'content-type': 'application/json',
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const encoded = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            headers: new Headers(
              Object.entries(response.headers).flatMap(([name, value]) =>
                value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]]
              )
            ),
            body: JSON.parse(encoded) as BridgeResponse['body']
          })
        })
      }
    )
    request.once('error', reject)
    request.end(body)
  })
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Condition was not reached.')
}

test('bridge enforces method, path, JSON media type, and bearer authentication', async (context) => {
  const active = await createActiveBridge()
  try {
    const cases = [
      {
        name: 'wrong method',
        options: { method: 'GET' },
        status: 404,
        error: 'Not found.'
      },
      {
        name: 'wrong path',
        options: { path: '/other' },
        status: 404,
        error: 'Not found.'
      },
      {
        name: 'missing authorization',
        options: { token: null },
        status: 401,
        error: 'Unauthorized.'
      },
      {
        name: 'wrong authorization',
        options: { token: '0'.repeat(64) },
        status: 401,
        error: 'Unauthorized.'
      },
      {
        name: 'wrong media type',
        options: { contentType: 'text/plain' },
        status: 415,
        error: 'Content-Type must be application/json.'
      },
      {
        name: 'missing media type',
        options: { contentType: null },
        status: 415,
        error: 'Content-Type must be application/json.'
      }
    ] as const

    for (const item of cases) {
      await context.test(item.name, async () => {
        const response = await callBridge(
          active.endpoint,
          { cellId: 'cell-1', tool: 'read', input: {} },
          item.options
        )
        assert.equal(response.status, item.status)
        assert.deepEqual(response.body, { ok: false, error: item.error })
        assert.equal(response.headers.get('cache-control'), 'no-store')
        if (item.status === 401) {
          assert.equal(response.headers.get('www-authenticate'), 'Bearer')
        }
      })
    }
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge rejects oversized, malformed, and non-strict JSON request bodies', async (context) => {
  const active = await createActiveBridge()
  try {
    await context.test('declared body over 32 MiB', async () => {
      const response = await rawRequest(active.endpoint, {
        'content-length': String(32 * 1024 * 1024 + 1)
      })
      assert.equal(response.status, 413)
      assert.match(response.body.error ?? '', /32 MiB limit/u)
    })

    const malformedCases: Array<{ name: string; body: BodyInit; message: RegExp }> = [
      {
        name: 'invalid UTF-8',
        body: new Uint8Array([0xff]),
        message: /not valid UTF-8 JSON/u
      },
      { name: 'malformed JSON', body: '{', message: /not valid UTF-8 JSON/u },
      {
        name: 'extra request field',
        body: JSON.stringify({ cellId: 'cell-1', tool: 'read', input: {}, extra: true }),
        message: /must contain exactly/u
      },
      {
        name: 'unsafe integer input',
        body: '{"cellId":"cell-1","tool":"read","input":{"value":9007199254740992}}',
        message: /strict JSON value/u
      }
    ]
    for (const item of malformedCases) {
      await context.test(item.name, async () => {
        const response = await callBridge(active.endpoint, undefined, { rawBody: item.body })
        assert.equal(response.status, 400)
        assert.match(response.body.error ?? '', item.message)
      })
    }
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge binds tool authority to the currently active cell id', async () => {
  const active = await createActiveBridge({
    availableTools: ['read'],
    resolveTool: () => ({ execute: async () => 'unexpected' })
  })
  try {
    const stale = await callBridge(active.endpoint, {
      cellId: 'stale-cell',
      tool: 'read',
      input: {}
    })
    assert.equal(stale.status, 409)
    assert.match(stale.body.error ?? '', /cell is not active/u)

    const unavailable = await callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'write',
      input: {}
    })
    assert.equal(unavailable.status, 403)
    assert.match(unavailable.body.error ?? '', /Tool "write" is not available/u)

    active.bridge.deactivateCell('cell-1')
    const inactive = await callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'read',
      input: {}
    })
    assert.equal(inactive.status, 409)
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge rewrites relative path inputs and preserves nested execution options', async () => {
  const executions: Array<{ input: unknown; options: ToolExecutionOptions; receiver: unknown }> = []
  const tool = {
    marker: 'receiver',
    async execute(input: unknown, options: ToolExecutionOptions): Promise<unknown> {
      executions.push({ input, options, receiver: this })
      return { received: input }
    }
  }
  const active = await createActiveBridge({
    availableTools: ['read'],
    resolveTool: (name) => (name === 'read' ? tool : undefined),
    executionOptions: { toolCallId: 'parent-call', messages: [] }
  })

  try {
    const response = await callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'read',
      input: { path: 'notes/input.txt', offset: 2 }
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
      ok: true,
      value: { received: { path: '/workspace/nested/notes/input.txt', offset: 2 } }
    })
    assert.equal(executions.length, 1)
    assert.equal(executions[0]?.receiver, tool)
    assert.match(executions[0]?.options.toolCallId ?? '', /^py-repl-/u)
    assert.deepEqual(executions[0]?.options.messages, [])
    assert.ok(executions[0]?.options.abortSignal instanceof AbortSignal)
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge prefixes bash commands with a safely quoted active cwd', async () => {
  let received: unknown
  const active = await createActiveBridge({
    cwd: "/workspace/team's files",
    availableTools: ['bash'],
    resolveTool: () => ({
      execute: async (input: unknown): Promise<string> => {
        received = input
        return 'done'
      }
    })
  })

  try {
    const response = await callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'bash',
      input: { command: 'pwd', timeout: 5 }
    })
    assert.deepEqual(response.body, { ok: true, value: 'done' })
    assert.deepEqual(received, {
      command: "cd '/workspace/team'\\''s files' && pwd",
      timeout: 5
    })
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge normalizes nested text, details, and image content into strict JSON', async () => {
  const active = await createActiveBridge({
    availableTools: ['inspect'],
    resolveTool: () => ({
      execute: () => ({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image-data', data: 'aGVsbG8=', mediaType: 'image/png' },
          { type: 'text', text: ' second' }
        ],
        details: { count: 2, nested: ['value'] },
        metadata: { ignored: true }
      })
    })
  })

  try {
    const response = await callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'inspect',
      input: null
    })
    assert.deepEqual(response.body, {
      ok: true,
      value: {
        text: 'first second',
        details: { count: 2, nested: ['value'] },
        images: [{ data: 'aGVsbG8=', mediaType: 'image/png' }]
      }
    })
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge consumes async-iterable tools through their final completion value', async () => {
  const active = await createActiveBridge({
    availableTools: ['stream'],
    resolveTool: () => ({
      execute: () =>
        (async function* (): AsyncGenerator<unknown> {
          yield { progress: 1 }
          yield { progress: 2, done: true }
        })()
    })
  })

  try {
    const response = await callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'stream',
      input: {}
    })
    assert.deepEqual(response.body, { ok: true, value: { progress: 2, done: true } })
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge rejects unsafe or otherwise non-serializable nested outputs', async (context) => {
  const nonStringKey = { value: 'ok' } as Record<PropertyKey, unknown>
  nonStringKey[Symbol('hidden')] = true
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const cases: Array<{ name: string; output: unknown }> = [
    { name: 'unsafe integer', output: 9_007_199_254_740_992 },
    { name: 'non-string property key', output: nonStringKey },
    { name: 'map', output: new Map([[1, 'value']]) },
    { name: 'bigint', output: 1n },
    { name: 'function', output: () => undefined },
    { name: 'date', output: new Date(0) },
    { name: 'cyclic object', output: cyclic },
    { name: 'non-finite number', output: Number.NaN }
  ]

  for (const item of cases) {
    await context.test(item.name, async () => {
      const active = await createActiveBridge({
        availableTools: ['unsafe'],
        resolveTool: () => ({ execute: async () => item.output })
      })
      try {
        const response = await callBridge(active.endpoint, {
          cellId: 'cell-1',
          tool: 'unsafe',
          input: {}
        })
        assert.equal(response.status, 200)
        assert.equal(response.body.ok, false)
        assert.match(response.body.error ?? '', /not a strict JSON value/u)
      } finally {
        await active.bridge.dispose()
      }
    })
  }
})

test('bridge propagates active-cell deactivation to an in-flight nested tool', async () => {
  let executionStarted = false
  let observedAbort = false
  const active = await createActiveBridge({
    availableTools: ['wait'],
    resolveTool: () => ({
      execute: async (_input: unknown, options: ToolExecutionOptions): Promise<never> => {
        executionStarted = true
        await new Promise<void>((_resolve, reject) => {
          const signal = options.abortSignal
          assert.ok(signal)
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true
              reject(new Error('nested tool aborted'))
            },
            { once: true }
          )
        })
        throw new Error('unreachable')
      }
    })
  })

  try {
    const responsePromise = callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'wait',
      input: {}
    })
    await waitUntil(() => executionStarted)
    active.bridge.deactivateCell('cell-1')
    const response = await responsePromise
    assert.equal(observedAbort, true)
    assert.deepEqual(response.body, { ok: false, error: 'nested tool aborted' })
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge isolates and completes concurrent nested calls', async () => {
  let started = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const active = await createActiveBridge({
    availableTools: ['parallelTool'],
    resolveTool: () => ({
      execute: async (input: unknown): Promise<unknown> => {
        started += 1
        await barrier
        return input
      }
    })
  })

  try {
    const first = callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'parallelTool',
      input: { index: 1 }
    })
    const second = callBridge(active.endpoint, {
      cellId: 'cell-1',
      tool: 'parallelTool',
      input: { index: 2 }
    })
    await waitUntil(() => started === 2)
    release()
    assert.deepEqual(
      (await Promise.all([first, second])).map((response) => response.body),
      [
        { ok: true, value: { index: 1 } },
        { ok: true, value: { index: 2 } }
      ]
    )
  } finally {
    await active.bridge.dispose()
  }
})

test('bridge rejects jsRepl and pyRepl recursively even when advertised and resolvable', async () => {
  let executions = 0
  const active = await createActiveBridge({
    availableTools: ['jsRepl', 'pyRepl'],
    resolveTool: () => ({
      execute: async (): Promise<string> => {
        executions += 1
        return 'unsafe recursion'
      }
    })
  })

  try {
    for (const tool of ['jsRepl', 'pyRepl']) {
      const response = await callBridge(active.endpoint, {
        cellId: 'cell-1',
        tool,
        input: { code: 'pass' }
      })
      assert.deepEqual(response.body, {
        ok: false,
        error: `Tool ${JSON.stringify(tool)} is not available.`
      })
    }
    assert.equal(executions, 0)
  } finally {
    await active.bridge.dispose()
  }
})
