import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useAvatarVisibility } from './useAvatarVisibility.ts'

test('only observed activity reveals the avatar; idle history mounts never replay it', async (t) => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = createRoot(document.getElementById('root')!)
  function Probe({ active, threadId }: { active: boolean; threadId: string }): React.JSX.Element {
    const visible = useAvatarVisibility(active, threadId)
    return React.createElement('span', null, String(visible))
  }
  const render = async (active: boolean, threadId = 'one'): Promise<void> => {
    await act(async () => root.render(React.createElement(Probe, { active, threadId })))
  }
  const tick = async (ms: number): Promise<void> => {
    await act(async () => t.mock.timers.tick(ms))
  }
  const visible = (): string | null => document.querySelector('span')!.textContent
  try {
    await render(false)
    assert.equal(visible(), 'false', 'initial historical mount stays hidden')
    await render(false)
    assert.equal(visible(), 'false', 'history updates stay hidden')
    await render(true)
    await tick(30_000)
    assert.equal(visible(), 'true')
    await render(false)
    await tick(9_999)
    assert.equal(visible(), 'true')
    await tick(1)
    assert.equal(visible(), 'false')
    await render(true)
    assert.equal(visible(), 'true')
    await render(false)
    await tick(9_000)
    await render(true)
    await tick(2_000)
    assert.equal(visible(), 'true')
    await render(false)
    await tick(10_000)
    assert.equal(visible(), 'false')
    await render(false, 'two')
    assert.equal(visible(), 'false', 'switching to history does not reveal the avatar')
    await render(true, 'two')
    await render(false, 'one')
    assert.equal(visible(), 'false', 'leaving a running conversation is not a completion')
    await render(true)
    await render(false)
    assert.equal(visible(), 'true')
    await act(async () => root.render(null))
    await render(false)
    assert.equal(visible(), 'false', 'idle remount does not restart the completion grace period')
    await tick(10_000)
    assert.equal(visible(), 'false')
  } finally {
    await act(async () => root.unmount())
    t.mock.timers.reset()
  }
})
