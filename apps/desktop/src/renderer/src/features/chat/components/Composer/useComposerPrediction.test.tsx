import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useRef, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useComposerPrediction } from './useComposerPrediction'

// Exercise the hook against a real React input, with only the provider boundary faked.
test('predicts only for empty input, accepts whole instructions and rejects stale context', async (t) => {
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
  const requests: { threadId: string; resolve: (text: string) => void }[] = []
  Object.assign(window, {
    api: {
      yachiyo: {
        predictComposer: ({ threadId }: { threadId?: string }) => {
          if (!threadId) return Promise.resolve('')
          return new Promise<string>((resolve) => requests.push({ threadId, resolve }))
        }
      }
    }
  })
  let value = ''
  let threadId: string | null = 'thread-one'
  let enabled = true
  let contextKey = 'one'
  let hook!: ReturnType<typeof useComposerPrediction>
  function Input(): React.JSX.Element {
    const ref = useRef<HTMLTextAreaElement>(null)
    const result = useComposerPrediction({
      value,
      enabled,
      contextKey,
      threadId,
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
    assert.equal(requests[0].threadId, 'thread-one')
    value = 'My own instruction'
    await render()
    await act(async () => requests[0].resolve('Old suggestion'))
    assert.equal(hook.text, '')
    await act(async () => t.mock.timers.tick(1000))
    assert.equal(requests.length, 1, 'typing must never trigger continuation requests')
    value = ''
    await render()
    await act(async () => t.mock.timers.tick(500))
    await act(async () => requests[1].resolve('Add a regression test.'))
    assert.equal(hook.text, 'Add a regression test.')
    assert.equal(value, '', 'prediction is not yet draft text')
    await act(async () => {
      assert.equal(hook.handleKeyDown(key('ArrowRight')), true)
    })
    assert.equal(value, 'Add a regression test.')
    await render()
    value = ''
    contextKey = 'new-reply'
    await render()
    await act(async () => t.mock.timers.tick(500))
    await act(async () => requests[2].resolve('Run the focused tests.'))
    await act(async () => {
      hook.handleKeyDown(key('Escape'))
    })
    assert.equal(hook.text, '')
    value = 'Typing'
    await render()
    value = ''
    await render()
    await act(async () => t.mock.timers.tick(1000))
    assert.equal(requests.length, 3, 'dismissal lasts until the conversation changes')
    contextKey = 'newer-reply'
    await render()
    await act(async () => t.mock.timers.tick(500))
    threadId = 'thread-two'
    contextKey = 'other-thread'
    await render()
    await act(async () => requests[3].resolve('Wrong thread'))
    assert.equal(hook.text, '')
    await act(async () => t.mock.timers.tick(500))
    enabled = false
    await render()
    await act(async () => requests[4].resolve('While running'))
    assert.equal(hook.text, '')
    enabled = true
    threadId = null
    contextKey = 'new-chat'
    await render()
    await act(async () => t.mock.timers.tick(1000))
    assert.equal(requests.length, 5, 'new chats have no context to predict from')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
