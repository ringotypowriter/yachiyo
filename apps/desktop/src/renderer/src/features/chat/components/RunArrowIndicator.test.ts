import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useAppStore, type AppState } from '@renderer/app/store/useAppStore'
import { RunArrowIndicator } from './RunArrowIndicator.tsx'

test('run arrows retain uploading, downloading, tool execution and idle states', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  })
  const host = document.getElementById('root')!
  const root = createRoot(host)
  const original = useAppStore.getState()
  const render = async (state: Partial<AppState>): Promise<string> => {
    await act(async () => {
      useAppStore.setState(
        { ...useAppStore.getInitialState(), activeThreadId: 't', ...state },
        true
      )
      root.render(React.createElement(RunArrowIndicator))
    })
    return host.innerHTML
  }
  const tool = {
    id: 'tool',
    runId: 'run',
    threadId: 't',
    toolName: 'read' as const,
    status: 'running' as const,
    inputSummary: '',
    startedAt: '2026-09-13T00:00:00Z'
  }
  try {
    assert.equal(await render({}), '')
    assert.match(
      await render({ runPhasesByThread: { t: 'preparing' } }),
      /data-run-arrow-phase="uploading"/
    )
    assert.match(
      await render({
        runPhasesByThread: { t: 'streaming' },
        receivingModelOutputByThread: { t: true }
      }),
      /data-run-arrow-phase="downloading"/
    )
    assert.match(
      await render({ runPhasesByThread: { t: 'streaming' }, toolCalls: { t: [tool] } }),
      /data-run-arrow-phase="toolcall"/
    )
    assert.match(
      await render({
        runPhasesByThread: { t: 'streaming' },
        toolCalls: { t: [{ ...tool, status: 'completed' }] }
      }),
      /data-run-arrow-phase="uploading"/
    )
    assert.match(
      await render({
        runPhasesByThread: { t: 'preparing' },
        activeRunIdsByThread: { t: 'run' },
        pendingAssistantMessages: {
          run: { threadId: 't', messageId: 'm', shouldStartNewTextBlock: true }
        },
        messages: {
          t: [
            {
              id: 'm',
              threadId: 't',
              role: 'assistant',
              status: 'streaming',
              content: '',
              reasoning: 'Thinking',
              createdAt: tool.startedAt
            }
          ]
        }
      }),
      /data-run-arrow-phase="downloading"/
    )
  } finally {
    await act(async () => root.unmount())
    useAppStore.setState(original, true)
  }
})
