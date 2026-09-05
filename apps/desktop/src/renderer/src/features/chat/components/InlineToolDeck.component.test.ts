import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import type { ToolCall } from '@renderer/app/types'
import { InlineToolDeck } from './InlineToolDeck.tsx'

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
