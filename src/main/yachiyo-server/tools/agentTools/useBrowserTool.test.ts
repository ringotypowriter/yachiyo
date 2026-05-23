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
    listSessions: () => [],
    showSessionView: () => ({
      threadId: 'thread-1',
      session: 's1',
      url: 'https://example.com',
      title: 'Example',
      viewport: { width: 1280, height: 960 },
      updatedAt: '2026-01-01T00:00:00.000Z'
    }),
    hideSessionView: () => {},
    setSessionViewBounds: () => ({
      threadId: 'thread-1',
      session: 's1',
      url: 'https://example.com',
      title: 'Example',
      viewport: { width: 1280, height: 960 },
      updatedAt: '2026-01-01T00:00:00.000Z'
    }),
    open: async () => ({ url: 'https://example.com', title: 'Example' }),
    close: async () => {},
    getUrl: async () => 'https://example.com',
    getTitle: async () => 'Example',
    loadUrl: async ({ url }) => url,
    waitForFunction: async () => {},
    snapshot: async () => ({
      url: 'https://example.com',
      title: 'Example',
      pageText: {
        headings: ['Example heading'],
        snippets: ['Example page text that helps the model understand the page.'],
        viewport: 'Example heading Example page text that helps the model understand the page.'
      },
      refCount: 2,
      refs: [
        {
          ref: 'e1',
          tag: 'a',
          text: 'Link',
          href: 'https://example.com/link',
          id: 'main-link',
          role: 'link',
          name: 'Link',
          testId: 'primary-link',
          selectorHint: '#main-link'
        },
        { ref: 'e2', tag: 'button', text: 'Submit' }
      ]
    }),
    scroll: async () => ({ url: 'https://example.com#after-scroll', title: 'Example' }),
    goBack: async () => ({ url: 'https://example.com/back', title: 'Back' }),
    goForward: async () => ({ url: 'https://example.com/forward', title: 'Forward' }),
    click: async () => ({ url: 'https://example.com', title: 'Example' }),
    fill: async () => ({ url: 'https://example.com', title: 'Example' }),
    type: async () => ({ url: 'https://example.com', title: 'Example' }),
    select: async () => ({ url: 'https://example.com', title: 'Example' }),
    check: async () => ({ url: 'https://example.com', title: 'Example' }),
    press: async () => ({ url: 'https://example.com', title: 'Example' }),
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
    dispose: () => {},
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
  assert.match(text, /Page text/)
  assert.match(text, /Example heading/)
  assert.match(text, /Viewport text/)
  assert.match(text, /Example heading Example page text/)
  assert.match(text, /id="main-link"/)
  assert.match(text, /data-testid="primary-link"/)
  assert.match(text, /@e2/)
})

test('useBrowserTool: scroll reports updated page state', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: makeService() })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'scroll', session: 's1', direction: 'down', amount: 720, ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(result.error, undefined)
  assert.equal(result.details.action, 'scroll')
  assert.equal(result.details.finalUrl, 'https://example.com#after-scroll')
  assert.equal(result.details.title, 'Example')
})

test('useBrowserTool: goBack and goForward report updated page state', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: makeService() })
  assert.ok(tool.execute)
  const back = await resolveToolOutput(
    tool.execute(
      { action: 'goBack', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  const forward = await resolveToolOutput(
    tool.execute(
      { action: 'goForward', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(back.error, undefined)
  assert.equal(back.details.finalUrl, 'https://example.com/back')
  assert.equal(back.details.title, 'Back')
  assert.equal(forward.error, undefined)
  assert.equal(forward.details.finalUrl, 'https://example.com/forward')
  assert.equal(forward.details.title, 'Forward')
})

test('useBrowserTool: click reports updated page state', async () => {
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      click: async () => ({ url: 'https://example.com/clicked', title: 'Clicked' })
    })
  })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'click', session: 's1', ref: 'e2', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(result.error, undefined)
  assert.equal(result.details.finalUrl, 'https://example.com/clicked')
  assert.equal(result.details.title, 'Clicked')
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

test('useBrowserTool: screenshot rejects empty saved files', async () => {
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      screenshot: async () => ({
        savedFileName: '.yachiyo/tool-result/empty.png',
        savedFilePath: '/tmp/yachiyo-use-browser/.yachiyo/tool-result/empty.png',
        bytesWritten: 0
      })
    })
  })
  assert.ok(tool.execute)

  const result = await resolveToolOutput(
    tool.execute(
      { action: 'screenshot', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.ok(result.error)
  assert.match(result.error, /empty screenshot/i)
  assert.equal(result.details.savedFileName, undefined)
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
