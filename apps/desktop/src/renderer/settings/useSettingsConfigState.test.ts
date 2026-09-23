import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import React, { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import {
  DEFAULT_REMOTE_CONFIG,
  type SettingsConfig,
  type YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { useSettingsConfigState } from './useSettingsConfigState.ts'

const initial: SettingsConfig = {
  providers: [],
  remote: { ...DEFAULT_REMOTE_CONFIG }
}
const installed: SettingsConfig = {
  ...initial,
  remote: { ...initial.remote!, enabled: true, tunnel: 'quick' }
}

async function mount(t: TestContext): Promise<{
  state(): ReturnType<typeof useSettingsConfigState>
  rendered(): string | null
  update(config: SettingsConfig): Promise<void>
}> {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  Object.assign(window, {
    api: {
      yachiyo: {
        subscribe(listener: (event: YachiyoServerEvent) => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
  Object.assign(globalThis, {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true
  })
  let state!: ReturnType<typeof useSettingsConfigState>
  function Probe(): React.JSX.Element {
    const current = useSettingsConfigState()
    useEffect(() => {
      state = current
    }, [current])
    return React.createElement('span', null, String(current.draft?.remote?.enabled))
  }
  const root = createRoot(document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    assert.equal(listeners.size, 0, 'unmount releases event subscription')
  })
  await act(async () => root.render(React.createElement(Probe)))
  return {
    state: () => state,
    rendered: () => document.querySelector('span')!.textContent,
    update: async (config: SettingsConfig) => {
      await act(async () => {
        for (const listener of listeners) {
          listener({ type: 'settings.updated', config } as YachiyoServerEvent)
        }
      })
    }
  }
}

test('mounted settings receives CLI remote enable/tunnel changes without a window restart', async (t) => {
  const view = await mount(t)
  await act(async () => view.state().initializeConfig(initial))
  await view.update(installed)
  assert.equal(view.rendered(), 'true')
  assert.deepEqual(view.state().savedConfig, installed)
  assert.deepEqual(view.state().draft, installed)
  await view.update(initial)
  assert.equal(view.rendered(), 'false')
  assert.deepEqual(view.state().draft, initial)
})

test('external settings preserve unsaved edits while updating untouched fields and discard baseline', async (t) => {
  const view = await mount(t)
  await act(async () => view.state().initializeConfig(installed))
  await act(async () =>
    view.state().setDraft({
      ...installed,
      general: { language: 'en' },
      remote: { ...installed.remote!, port: 54321 }
    })
  )
  const uninstalled: SettingsConfig = {
    ...installed,
    remote: { ...installed.remote!, tunnel: 'none', port: 54322 }
  }
  await view.update(uninstalled)
  assert.equal(view.state().draft?.remote?.tunnel, 'none')
  assert.equal(view.state().draft?.remote?.port, 54321, 'conflicting local edit survives')
  assert.equal(view.state().draft?.general?.language, 'en')
  assert.deepEqual(view.state().savedConfig, uninstalled)
  await act(async () => view.state().setDraft(view.state().savedConfig))
  assert.deepEqual(view.state().draft, uninstalled, 'discard restores latest server config')
})

test('a settings event arriving before the initial read cannot be overwritten by stale initialization', async (t) => {
  const view = await mount(t)
  await view.update(installed)
  await act(async () => view.state().initializeConfig(initial))
  assert.deepEqual(view.state().savedConfig, installed)
  assert.deepEqual(view.state().draft, installed)
})

test('reinitialization on a locale effect rerun preserves an unsaved draft', async (t) => {
  const view = await mount(t)
  await act(async () => view.state().initializeConfig(initial))
  const draft: SettingsConfig = { ...initial, general: { language: 'en' } }
  await act(async () => view.state().setDraft(draft))
  await act(async () => view.state().initializeConfig(initial))
  assert.deepEqual(view.state().savedConfig, initial)
  assert.deepEqual(view.state().draft, draft)
})
