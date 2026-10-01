import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import type { ToolCall } from '@renderer/app/types'
import { InlineToolDeck } from './InlineToolDeck.tsx'
import { AppDialogContext } from '@renderer/components/AppDialogContext'

test('established summaries stay static on mount and remount; only summary changes animate', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })
  const root = createRoot(document.getElementById('root')!)
  const tool: ToolCall = {
    id: 'read-1',
    threadId: 'thread',
    toolName: 'read',
    status: 'completed',
    inputSummary: '/workspace/example.ts',
    startedAt: '2026-09-05T00:00:00.000Z'
  }
  const render = async (toolCalls: ToolCall[]): Promise<void> => {
    await act(async () => root.render(React.createElement(InlineToolDeck, { toolCalls })))
  }
  const animates = (): boolean =>
    (document.querySelector('[data-tool-call-summary-id]') as HTMLElement).style.animation !==
    'none'
  try {
    await render([tool])
    assert.equal(animates(), false)
    await render([{ ...tool, outputSummary: 'Updated output' }])
    assert.equal(animates(), false, 'ordinary updates must not start an entrance animation')
    const nextTool = { ...tool, id: 'read-2', status: 'running' as const }
    await render([tool, nextTool])
    assert.equal(animates(), true, 'a new summary in a mounted deck should animate')
    await act(async () => root.render(null))
    await render([tool, nextTool])
    assert.equal(animates(), false, 'remounting even a running deck must not replay its entrance')
    assert.ok(document.querySelector('.yachiyo-running-pulse'))
    const question: ToolCall = {
      ...tool,
      id: 'ask-1',
      toolName: 'askUser',
      status: 'waiting-for-user',
      inputSummary: 'Continue?'
    }
    await render([tool, question])
    const detailsAnimation = (): string =>
      (document.querySelector('.yachiyo-detail-reveal') as HTMLElement).style.animation
    assert.notEqual(detailsAnimation(), 'none', 'a newly arriving question should reveal')
    await act(async () => root.render(null))
    await render([tool, question])
    assert.equal(animates(), false)
    assert.equal(detailsAnimation(), 'none', 'an existing question must not replay its reveal')
    const button = document.querySelector('[data-tool-call-id="ask-1"]')!
    await act(async () => button.dispatchEvent(new window.Event('click', { bubbles: true })))
    assert.equal(document.querySelector('.yachiyo-detail-reveal'), null)
    await act(async () => button.dispatchEvent(new window.Event('click', { bubbles: true })))
    assert.notEqual(detailsAnimation(), 'none', 'explicitly reopening details should still animate')
  } finally {
    await act(async () => root.unmount())
  }
})

test('mounting, remounting and updating a deck never scroll its ancestor conversation', async () => {
  const { window } = parseHTML(
    '<html><body><div id="viewport"><div id="root"></div></div></body></html>'
  )
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })
  const viewport = document.getElementById('viewport')!
  viewport.scrollTop = 900
  window.HTMLElement.prototype.scrollIntoView = () => {
    viewport.scrollTop = 123
  }
  const root = createRoot(document.getElementById('root')!)
  const tool: ToolCall = {
    id: 'read-1',
    threadId: 'thread',
    runId: 'run',
    toolName: 'read',
    status: 'completed',
    inputSummary: '/workspace/example.ts',
    startedAt: '2026-09-05T00:00:00.000Z',
    details: {
      path: '/workspace/example.ts',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      totalBytes: 12,
      truncated: false
    }
  }
  try {
    await act(async () => root.render(React.createElement(InlineToolDeck, { toolCalls: [tool] })))
    assert.equal(viewport.scrollTop, 900, 'overscanned decks must not bring themselves into view')
    await act(async () => root.render(null))
    await act(async () => root.render(React.createElement(InlineToolDeck, { toolCalls: [tool] })))
    assert.equal(viewport.scrollTop, 900, 'virtualizer remounts must not steal the viewport')
    await act(async () =>
      root.render(
        React.createElement(InlineToolDeck, { toolCalls: [tool, { ...tool, id: 'read-2' }] })
      )
    )
    assert.equal(
      viewport.scrollTop,
      900,
      'new tool output must respect a reader scrolled away from the bottom'
    )
  } finally {
    await act(async () => root.unmount())
  }
})

test('a live deck summary collapses tool icons without hiding a waiting question', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })
  const root = createRoot(document.getElementById('root')!)
  const first = {
    id: 'read-1',
    threadId: 'thread',
    toolName: 'read',
    status: 'completed' as const,
    inputSummary: '/workspace/example.ts',
    deckSummary: 'Reading the workspace files',
    startedAt: '2026-09-05T00:00:00.000Z'
  }
  const render = async (toolCalls: ToolCall[]): Promise<void> => {
    await act(async () => root.render(React.createElement(InlineToolDeck, { toolCalls })))
  }
  try {
    await render([first, { ...first, id: 'read-2', toolName: 'bash', status: 'running' }])
    const toggle = document.querySelector('[data-tool-deck-toggle]')!
    assert.equal(toggle.textContent?.includes('Reading the workspace files'), true)
    assert.equal((toggle as HTMLElement).style.background, 'transparent')
    assert.equal(toggle.textContent?.includes('Work'), false)
    assert.equal(toggle.querySelectorAll('[data-tool-deck-icons] svg').length, 2)
    assert.ok(toggle.classList.contains('items-center'))
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelector('[data-tool-call-id]'), null)
    await act(async () => toggle.dispatchEvent(new window.Event('click', { bubbles: true })))
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelectorAll('[data-tool-call-id]').length, 2)
    await render([
      { ...first, deckSummary: 'Reading and comparing workspace files' },
      { ...first, id: 'read-2', status: 'running' }
    ])
    assert.equal(
      toggle.getAttribute('aria-expanded'),
      'true',
      'refreshes preserve manual expansion'
    )
    await act(async () => toggle.dispatchEvent(new window.Event('click', { bubbles: true })))
    const question = {
      ...first,
      id: 'ask-1',
      toolName: 'askUser',
      status: 'waiting-for-user' as const
    }
    await render([first, question])
    assert.ok(document.querySelector('[data-tool-call-id="ask-1"]'))
    assert.ok(document.querySelector('.yachiyo-detail-reveal'))
  } finally {
    await act(async () => root.unmount())
  }
})

test('an arriving summary does not close tool details the reader opened', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })
  const root = createRoot(document.getElementById('root')!)
  const call: ToolCall = {
    id: 'read-1',
    threadId: 'thread',
    toolName: 'read',
    status: 'completed',
    inputSummary: '/workspace/example.ts',
    startedAt: '2026-09-05T00:00:00.000Z',
    details: {
      path: '/workspace/example.ts',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      totalBytes: 12,
      truncated: false
    }
  }
  try {
    await act(async () => root.render(React.createElement(InlineToolDeck, { toolCalls: [call] })))
    await act(async () =>
      document
        .querySelector('[data-tool-call-id]')!
        .dispatchEvent(new window.Event('click', { bubbles: true }))
    )
    assert.ok(document.querySelector('[data-tool-call-id]'))
    await act(async () =>
      root.render(
        React.createElement(InlineToolDeck, {
          toolCalls: [{ ...call, deckSummary: 'Reading the file' }]
        })
      )
    )
    assert.equal(
      document.querySelector('[data-tool-deck-toggle]')?.getAttribute('aria-expanded'),
      'true'
    )
    assert.ok(document.querySelector('[data-tool-call-id]'))
  } finally {
    await act(async () => root.unmount())
  }
})

for (const toolName of ['edit', 'applyPatch'] as const) {
  test(`${toolName} with raw input renders colored diff lines in expanded details`, async () => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window,
      document: window.document,
      HTMLElement: window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true
    })
    const root = createRoot(document.getElementById('root')!)
    const path = 'notes.txt'
    const diff = '--- notes.txt\n+++ notes.txt\n@@ -10 +10 @@\n-before\n+after'
    const tool: ToolCall = {
      id: 'change-1',
      threadId: 'thread',
      toolName,
      status: 'completed',
      inputSummary: path,
      startedAt: '2026-10-01T00:00:00.000Z',
      rawInput:
        toolName === 'edit'
          ? { path, mode: 'inline', oldText: 'before', newText: 'after' }
          : {
              patch:
                '*** Begin Patch\n*** Update File: notes.txt\n@@\n-before\n+after\n*** End Patch'
            },
      details:
        toolName === 'edit'
          ? { path, mode: 'inline', replacements: 1, firstChangedLine: 10, diff }
          : { operations: [{ path, operation: 'update', diff }] }
    }
    try {
      await act(async () =>
        root.render(
          React.createElement(
            AppDialogContext.Provider,
            {
              value: { alert: async () => {}, confirm: async () => false, prompt: async () => null }
            },
            React.createElement(InlineToolDeck, { toolCalls: [tool] })
          )
        )
      )
      await act(async () =>
        document
          .querySelector('[data-tool-call-id]')!
          .dispatchEvent(new window.Event('click', { bubbles: true }))
      )
      const panel = document.querySelector('.yachiyo-detail-reveal')!
      assert.ok(panel.textContent?.includes('diff: notes.txt'))
      const removed = Array.from(panel.querySelectorAll('div')).find(
        (element) => element.textContent === '10before'
      ) as HTMLElement | undefined
      const added = Array.from(panel.querySelectorAll('div')).find(
        (element) => element.textContent === '10after'
      ) as HTMLElement | undefined
      assert.ok(removed, 'the removed line must render with its original line number')
      assert.ok(added, 'the added line must render with its new line number')
      assert.notEqual(removed.style.background, added.style.background)
      assert.ok(removed.style.borderLeft.includes('2px solid'))
      assert.ok(added.style.borderLeft.includes('2px solid'))
      assert.ok(!panel.textContent?.includes('oldText'), 'changes must not be repeated as raw JSON')
      assert.ok(
        !panel.textContent?.includes('*** Begin Patch'),
        'changes must not be repeated as a raw patch'
      )
    } finally {
      await act(async () => root.unmount())
    }
  })
}
