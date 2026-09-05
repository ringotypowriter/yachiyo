import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import type { ToolCall } from '@renderer/app/types'
import { InlineToolDeck } from './InlineToolDeck.tsx'

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
