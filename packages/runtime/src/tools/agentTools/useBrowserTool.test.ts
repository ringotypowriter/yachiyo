import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ToolExecutionOptions } from 'ai'

import { createTool } from './useBrowserTool.ts'
import type { AgentToolContext, UseBrowserToolOutput } from './shared.ts'
import type { BrowserAutomationToolBackend } from '../../services/browserAutomation/browserAutomationToolBackend.ts'

const TOOL_EXECUTION_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tc-test',
  messages: []
}

const TOOL_INPUT_DEFAULTS = {
  timeoutMs: 15_000,
  maxRefs: 60
} as const

function outputText(result: UseBrowserToolOutput): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

async function assertSpilled(
  result: UseBrowserToolOutput,
  workspacePath: string,
  fullText: string
): Promise<void> {
  assert.equal(result.error, undefined)
  assert.equal(result.metadata.truncated, true)
  assert.ok(outputText(result).length < 6_000)
  assert.match(outputText(result), /Use the read tool/)
  assert.match(result.details.savedFileName ?? '', /^\.yachiyo\/tool-result\/browser-.*\.txt$/)
  assert.equal(result.details.savedFilePath, join(workspacePath, result.details.savedFileName!))
  assert.ok(outputText(result).includes(result.details.savedFileName!))
  assert.equal(await readFile(result.details.savedFilePath!, 'utf8'), fullText)
  assert.equal(result.details.bytesWritten, Buffer.byteLength(fullText, 'utf8'))
}

for (const action of ['snapshot', 'eval'] as const) {
  for (const length of [19_999, 20_000, 20_001]) {
    test(`useBrowserTool: ${action} spills only above 20k (${length})`, async (t) => {
      const workspacePath = await mkdtemp(join(tmpdir(), 'browser-spill-'))
      t.after(() => rm(workspacePath, { recursive: true, force: true }))
      const fullText = '界'.repeat(length)
      const tool = createTool(makeContext({ workspacePath }), {
        browserAutomationService: makeService({
          snapshot: async () => ({
            url: fullText,
            title: '',
            pageText: { headings: [], snippets: [] },
            refs: [],
            refCount: 0
          }),
          evaluateScript: async () => ({ url: 'https://example.com', title: '', value: fullText })
        })
      })
      assert.ok(tool.execute)
      const result = await resolveToolOutput(
        tool.execute(
          { action, session: 's1', script: 'document.body.innerText', ...TOOL_INPUT_DEFAULTS },
          TOOL_EXECUTION_OPTIONS
        )
      )
      if (length > 20_000) {
        await assertSpilled(result, workspacePath, fullText)
        assert.ok(JSON.stringify(result.details).length < 12_000)
      } else {
        assert.equal(
          outputText(result),
          action === 'snapshot'
            ? fullText
            : `Evaluated: https://example.com\n\nResult:\n${fullText}`
        )
        assert.deepEqual(result.metadata, {})
        assert.equal(result.details.savedFilePath, undefined)
        assert.deepEqual(await readdir(workspacePath), [])
        if (action === 'snapshot') assert.equal(result.details.content, fullText)
      }
    })
  }

  test(`useBrowserTool: ${action} spill failure never returns full output`, async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'browser-spill-failure-'))
    t.after(() => rm(workspacePath, { recursive: true, force: true }))
    await writeFile(join(workspacePath, '.yachiyo'), 'not a directory')
    const fullText = 'private-large-output'.repeat(2_000)
    const tool = createTool(makeContext({ workspacePath }), {
      browserAutomationService: makeService({
        snapshot: async () => ({
          url: 'https://example.com',
          title: '',
          pageText: { headings: [], snippets: [], viewport: fullText },
          refs: [],
          refCount: 0
        }),
        evaluateScript: async () => ({ url: 'https://example.com', title: '', value: fullText })
      })
    })
    assert.ok(tool.execute)
    const result = await resolveToolOutput(
      tool.execute(
        { action, session: 's1', script: 'document.body.innerText', ...TOOL_INPUT_DEFAULTS },
        TOOL_EXECUTION_OPTIONS
      )
    )
    assert.ok(result.error)
    assert.ok(JSON.stringify(result).length < 6_000)
    assert.doesNotMatch(JSON.stringify(result), /private-large-output/)
    assert.equal(result.details.savedFilePath, undefined)
  })
}

for (const hugeField of ['href', 'ariaLabel'] as const) {
  test(`useBrowserTool: snapshot preview never splits a huge ${hugeField} ref`, async (t) => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'browser-spill-ref-'))
    t.after(() => rm(workspacePath, { recursive: true, force: true }))
    const hugeValue = `start\n${'界'.repeat(25_000)}\nend`
    const hugeLine =
      hugeField === 'href' ? `@e2 <a> — ${hugeValue}` : `@e2 <a> — aria="${hugeValue}"`
    const fullText = `Example\nhttps://example.com\n\n@e1 <button> — Submit\n${hugeLine}\n@e3 <button> — Next`
    const tool = createTool(makeContext({ workspacePath }), {
      browserAutomationService: makeService({
        snapshot: async () => ({
          url: 'https://example.com',
          title: 'Example',
          pageText: { headings: [], snippets: [] },
          refCount: 3,
          refs: [
            { ref: 'e1', tag: 'button', text: 'Submit' },
            { ref: 'e2', tag: 'a', [hugeField]: hugeValue },
            { ref: 'e3', tag: 'button', text: 'Next' }
          ]
        })
      })
    })
    assert.ok(tool.execute)
    const result = await resolveToolOutput(
      tool.execute(
        { action: 'snapshot', session: 's1', ...TOOL_INPUT_DEFAULTS },
        TOOL_EXECUTION_OPTIONS
      )
    )
    await assertSpilled(result, workspacePath, fullText)
    assert.match(outputText(result), /^@e1 <button> — Submit$/m)
    assert.doesNotMatch(outputText(result), /@e2|start|end/)
    assert.equal(result.details.content, outputText(result))
    assert.equal(result.details.refCount, 3)
    assert.ok(JSON.stringify(result.details).length < 6_000)
  })
}

test('useBrowserTool: long snapshot keeps only complete ref lines in preview', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'browser-spill-lines-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const refs = Array.from({ length: 500 }, (_, index) => ({
    ref: `e${index}`,
    tag: 'button',
    text: `Result ${index} ${'x'.repeat(50)}`
  }))
  const lines = refs.map((ref) => `@${ref.ref} <button> — ${ref.text}`)
  const fullText = `https://example.com\n\n${lines.join('\n')}`
  const tool = createTool(makeContext({ workspacePath }), {
    browserAutomationService: makeService({
      snapshot: async () => ({
        url: 'https://example.com',
        title: '',
        pageText: { headings: [], snippets: [] },
        refCount: refs.length,
        refs
      })
    })
  })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'snapshot', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  await assertSpilled(result, workspacePath, fullText)
  const previewRefs = outputText(result)
    .split('\n')
    .filter((line) => line.startsWith('@'))
  assert.ok(previewRefs.length > 0 && previewRefs.length < refs.length)
  assert.ok(previewRefs.every((line) => lines.includes(line)))
  assert.equal(result.details.content, outputText(result))
})

test('useBrowserTool: spilled eval bounds large page title and URL too', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'browser-spill-header-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const fullText = 'result'.repeat(5_000)
  const tool = createTool(makeContext({ workspacePath }), {
    browserAutomationService: makeService({
      evaluateScript: async () => ({
        url: 'https://example.com/' + 'u'.repeat(30_000),
        title: 't'.repeat(30_000),
        value: fullText
      })
    })
  })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'eval', session: 's1', script: 'document.body.innerText', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  await assertSpilled(result, workspacePath, fullText)
  assert.ok(JSON.stringify(result.details).length < 12_000)
})

test('useBrowserTool: short eval also bounds oversized page metadata without spilling', async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'browser-short-header-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  const tool = createTool(makeContext({ workspacePath }), {
    browserAutomationService: makeService({
      evaluateScript: async () => ({
        url: 'https://example.com/' + 'u'.repeat(30_000),
        title: 't'.repeat(30_000),
        value: 'short result'
      })
    })
  })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'eval', session: 's1', script: 'document.title', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.equal(result.error, undefined)
  assert.ok(outputText(result).length < 1_100)
  assert.match(outputText(result), /Result:\nshort result$/)
  assert.ok((result.details.finalUrl?.length ?? 0) <= 1_000)
  assert.ok((result.details.title?.length ?? 0) <= 1_000)
  assert.equal(result.details.result, 'short result')
  assert.equal(result.details.savedFilePath, undefined)
  assert.deepEqual(result.metadata, {})
  assert.deepEqual(await readdir(workspacePath), [])
})

test('useBrowserTool: eval preserves short JSON output and details', async () => {
  const tool = createTool(makeContext(), { browserAutomationService: makeService() })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      { action: 'eval', session: 's1', script: '({ answer: 42 })', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  assert.equal(
    outputText(result),
    'Evaluated: Evaluated\nhttps://example.com/eval\n\nResult:\n{\n  "answer": 42\n}'
  )
  assert.equal(result.details.result, '{\n  "answer": 42\n}')
  assert.deepEqual(result.metadata, {})
})

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

function makeService(
  overrides?: Partial<BrowserAutomationToolBackend>
): BrowserAutomationToolBackend {
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
    evaluateScript: async () => ({
      url: 'https://example.com/eval',
      title: 'Evaluated',
      value: { answer: 42 }
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

test('useBrowserTool: open retries transient navigation failures before succeeding', async () => {
  let attempts = 0
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      open: async () => {
        attempts += 1
        if (attempts < 5) {
          throw new Error('Navigation failed: ERR_CONNECTION_RESET')
        }
        return { url: 'https://example.com/recovered', title: 'Recovered' }
      }
    })
  })
  assert.ok(tool.execute)

  const result = await resolveToolOutput(
    tool.execute(
      { action: 'open', session: 's1', url: 'https://example.com', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(result.error, undefined)
  assert.equal(attempts, 5)
  assert.equal(result.details.finalUrl, 'https://example.com/recovered')
  assert.equal(result.details.attempts, 5)
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /after 5 attempts/)
})

test('useBrowserTool: loadUrl retries SSL navigation failures before succeeding', async () => {
  let attempts = 0
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      loadUrl: async ({ url }) => {
        attempts += 1
        if (attempts < 2) {
          throw new Error('Navigation failed: ERR_SSL_PROTOCOL_ERROR')
        }
        return url
      }
    })
  })
  assert.ok(tool.execute)

  const result = await resolveToolOutput(
    tool.execute(
      { action: 'loadUrl', session: 's1', url: 'https://example.com', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(result.error, undefined)
  assert.equal(attempts, 2)
  assert.equal(result.details.finalUrl, 'https://example.com')
  assert.equal(result.details.attempts, 2)
})

test('useBrowserTool: navigation retry keeps non-retryable errors single-attempt', async () => {
  let attempts = 0
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      open: async () => {
        attempts += 1
        throw new Error('Browser session "s1" was destroyed. Re-open it.')
      }
    })
  })
  assert.ok(tool.execute)

  const result = await resolveToolOutput(
    tool.execute(
      { action: 'open', session: 's1', url: 'https://example.com', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(attempts, 1)
  assert.ok(result.error)
  assert.equal(result.details.attempts, 1)
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

test('useBrowserTool: snapshot preserves every returned ref for the model and tool history', async () => {
  const refs = Array.from({ length: 40 }, (_, index) => ({
    ref: `e${index + 1}`,
    tag: 'button',
    text: `Result ${index + 1}`
  }))
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      snapshot: async () => ({
        url: 'https://example.com/results',
        title: 'Results',
        pageText: { headings: [], snippets: [] },
        refCount: refs.length,
        refs
      })
    })
  })
  assert.ok(tool.execute)

  const result = await resolveToolOutput(
    tool.execute(
      { action: 'snapshot', session: 's1', ...TOOL_INPUT_DEFAULTS },
      TOOL_EXECUTION_OPTIONS
    )
  )
  const content = result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')

  assert.equal(result.details.refCount, 40)
  assert.match(content, /^@e40 <button> — Result 40$/m)
  assert.doesNotMatch(content, /… \+10 more/)
  assert.ok('content' in result.details)
  assert.equal(result.details.content, content)
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

test('useBrowserTool: eval executes JavaScript and returns the result', async () => {
  let receivedInput: {
    threadId: string
    session: string
    script: string
    timeoutMs: number
  } | null = null
  const tool = createTool(makeContext(), {
    browserAutomationService: makeService({
      evaluateScript: async (input) => {
        receivedInput = input
        return {
          url: 'https://example.com/eval',
          title: 'Evaluated',
          value: { answer: 42 }
        }
      }
    })
  })
  assert.ok(tool.execute)
  const result = await resolveToolOutput(
    tool.execute(
      {
        action: 'eval',
        session: 's1',
        script: 'return document.title',
        ...TOOL_INPUT_DEFAULTS
      },
      TOOL_EXECUTION_OPTIONS
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(receivedInput, {
    threadId: 'thread-1',
    session: 's1',
    script: 'return document.title',
    timeoutMs: 15_000
  })
  assert.equal(result.details.action, 'eval')
  assert.equal(result.details.finalUrl, 'https://example.com/eval')
  assert.equal(result.details.title, 'Evaluated')
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /"answer": 42/)
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
