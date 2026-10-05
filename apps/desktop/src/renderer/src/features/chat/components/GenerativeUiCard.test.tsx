import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { GenerativeUiCard } from './GenerativeUiCard'
import type { ToolCall } from '@renderer/app/types'

test('Expand uses a dialog top layer inside transformed timeline without replacing iframe', async () => {
  const { window } = parseHTML(
    '<html><body><div id="root" style="transform: translateY(100px)"></div></body></html>'
  )
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    MutationObserver: class {
      observe(): void {
        return
      }
      disconnect(): void {
        return
      }
    },
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.assign(window, { api: { process: { versions: { electron: '1.0' } }, yachiyo: {} } })
  const root = createRoot(document.getElementById('root')!)
  const toolCall: ToolCall = {
    id: 'ui-1',
    threadId: 'thread-1',
    runId: 'run-1',
    toolName: 'renderUi',
    status: 'completed',
    inputSummary: 'demo',
    startedAt: '2026-01-01T00:00:00Z',
    details: {
      kind: 'renderUi',
      title: 'Demo',
      html: '<button>Counter: 1</button>',
      css: '',
      js: ''
    }
  }
  let modalOpens = 0
  try {
    await act(async () => root.render(React.createElement(GenerativeUiCard, { toolCall })))
    const frame = document.querySelector('iframe')!
    const dialog = document.querySelector('dialog')!
    assert.ok(dialog, 'the card must use a native dialog to escape the transformed row')
    Object.assign(dialog, {
      showModal: () => {
        modalOpens += 1
        dialog.setAttribute('open', '')
      },
      close: () => dialog.removeAttribute('open')
    })
    await act(async () =>
      (document.querySelector('[aria-label="Expand preview"]') as HTMLButtonElement).click()
    )
    assert.equal(modalOpens, 1)
    assert.equal(
      dialog.querySelector('iframe'),
      frame,
      'expanding preserves iframe browsing context and counter'
    )
    await act(async () =>
      (document.querySelector('[aria-label="Close preview"]') as HTMLButtonElement).click()
    )
    assert.equal(dialog.querySelector('iframe'), frame, 'closing preserves iframe browsing context')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
