import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolExecutionOptions } from 'ai'

import { createTool } from './useBrowserTool.ts'
import type { AgentToolContext } from './shared.ts'
import type { BrowserAutomationService } from '../../services/browserAutomation/electronBrowserAutomationService.ts'

const TOOL_EXECUTION_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tc-test',
  messages: []
}

const TOOL_INPUT_DEFAULTS = {
  timeoutMs: 15_000,
  maxRefs: 60
} as const

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

async function resolveToolOutput<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (isAsyncIterable<T>(value)) {
    let last: T | undefined
    for await (const item of value) {
      last = item
    }
    if (last === undefined) {
      throw new Error('Tool returned an empty async iterable.')
    }
    return last
  }

  return await value
}

function makeContext(overrides?: Partial<AgentToolContext>): AgentToolContext {
  return {
    workspacePath: '/tmp/yachiyo-use-browser',
    threadId: 'thread-1',
    ...overrides
  }
}

function makeService(overrides?: Partial<BrowserAutomationService>): BrowserAutomationService {
  return {
    open: async () => ({ url: 'https://example.com', title: 'Example' }),
    close: async () => {},
    getUrl: async () => 'https://example.com',
    getTitle: async () => 'Example',
    loadUrl: async ({ url }) => url,
    waitForFunction: async () => {},
    snapshot: async () => ({
      url: 'https://example.com',
      title: 'Example',
      refCount: 2,
      refs: [
        { ref: 'e1', tag: 'a', text: 'Link', href: 'https://example.com/link' },
        { ref: 'e2', tag: 'button', text: 'Submit' }
      ]
    }),
    click: async () => {},
    fill: async () => {},
    type: async () => {},
    select: async () => {},
    check: async () => {},
    press: async () => {},
    screenshot: async () => ({
      savedFileName: '.yachiyo/tool-result/browser.png',
      savedFilePath: '/tmp/yachiyo-use-browser/.yachiyo/tool-result/browser.png',
      bytesWritten: 10
    }),
    pdf: async () => ({
      savedFileName: '.yachiyo/tool-result/browser.pdf',
      savedFilePath: '/tmp/yachiyo-use-browser/.yachiyo/tool-result/browser.pdf',
      bytesWritten: 20
    }),
    ...overrides
  }
}

test('useBrowserTool: open includes finalUrl/title in details', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: makeService() })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'open', session: 's1', url: 'https://example.com', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.equal(result.error, undefined)
  assert.equal(result.details.kind, 'useBrowser')
  assert.equal(result.details.action, 'open')
  assert.equal(result.details.session, 's1')
  assert.equal(result.details.finalUrl, 'https://example.com')
  assert.equal(result.details.title, 'Example')
})

test('useBrowserTool: snapshot returns refs and refCount', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: makeService() })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'snapshot', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.equal(result.error, undefined)
  assert.equal(result.details.refCount, 2)
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
  assert.match(text, /@e1/)
  assert.match(text, /@e2/)
})

test('useBrowserTool: screenshot reports saved file', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: makeService() })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'screenshot', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.equal(result.error, undefined)
  assert.equal(result.details.savedFileName, '.yachiyo/tool-result/browser.png')
  assert.equal(result.details.bytesWritten, 10)
})

test('useBrowserTool: returns error when service is unavailable', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: undefined })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'open', session: 's1', url: 'https://example.com', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.ok(result.error)
})

test('useBrowserTool: returns error when threadId is missing', async () => {
  const tool = createTool(makeContext({ threadId: undefined }), {
    browserAutomationService: makeService()
  })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'open', session: 's1', url: 'https://example.com', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.ok(result.error)
})
