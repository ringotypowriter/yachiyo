import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useRef, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useComposerPrediction } from './useComposerPrediction'

// Exercise the hook against a real React input, with only the provider boundary faked.
test('debounces, rejects stale responses, accepts right arrow and suppresses dismissed drafts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const requests: { text: string; resolve: (text: string) => void }[] = []
  Object.assign(window, {
    api: {
      yachiyo: {
        predictComposer: ({ text }: { text: string }) => {
          if (!text) return Promise.resolve('')
          return new Promise<string>((resolve) => requests.push({ text, resolve }))
        }
      }
    }
  })
  let value = 'Write'
  let enabled = true
  let contextKey = 'one'
  let hook!: ReturnType<typeof useComposerPrediction>
  function Input(): React.JSX.Element {
    const ref = useRef<HTMLTextAreaElement>(null)
    const result = useComposerPrediction({
      value,
      enabled,
      contextKey,
      textareaRef: ref,
      setValue: (next) => {
        value = next
      }
    })
    useLayoutEffect(() => {
      hook = result
    }, [result])
    return <textarea ref={ref} value={value} readOnly />
  }
  const root = createRoot(document.getElementById('root')!)
  const render = async (): Promise<void> => {
    await act(async () => root.render(<Input />))
    const textarea = document.querySelector('textarea')!
    Object.assign(textarea, { value, selectionStart: value.length, selectionEnd: value.length })
    await act(async () => hook.refreshSelection())
  }
  const key = (name: string): Parameters<typeof hook.handleKeyDown>[0] =>
    ({
      key: name,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 },
      currentTarget: document.querySelector('textarea'),
      preventDefault: () => {}
    }) as Parameters<typeof hook.handleKeyDown>[0]
  try {
    await render()
    await act(async () => t.mock.timers.tick(499))
    assert.equal(requests.length, 0)
    await act(async () => t.mock.timers.tick(1))
    assert.equal(requests[0].text, 'Write')
    value = 'Read'
    await render()
    await act(async () => requests[0].resolve(' stale'))
    assert.equal(hook.text, '')
    await act(async () => t.mock.timers.tick(500))
    await act(async () => requests[1].resolve(' a book'))
    assert.equal(hook.text, ' a book')
    await act(async () => {
      assert.equal(hook.handleKeyDown(key('ArrowRight')), true)
    })
    assert.equal(value, 'Read a book')
    await render()
    await act(async () => t.mock.timers.tick(500))
    await act(async () => requests[2].resolve(' today'))
    await act(async () => {
      hook.handleKeyDown(key('Escape'))
    })
    assert.equal(hook.text, '')
    await render()
    await act(async () => t.mock.timers.tick(1000))
    assert.equal(requests.length, 3)
    value = 'Draft'
    await render()
    await act(async () => t.mock.timers.tick(500))
    enabled = false
    await render()
    await act(async () => requests[3].resolve(' hidden'))
    assert.equal(hook.text, '')
    enabled = true
    contextKey = 'two'
    await render()
    await act(async () => t.mock.timers.tick(500))
    contextKey = 'three'
    await render()
    await act(async () => requests[4].resolve(' wrong thread'))
    assert.equal(hook.text, '')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
