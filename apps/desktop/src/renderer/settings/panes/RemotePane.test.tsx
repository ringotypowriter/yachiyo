import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'

import { DEFAULT_REMOTE_CONFIG, type SettingsConfig } from '@yachiyo/shared/protocol'
import { AppDialogContext } from '@renderer/components/AppDialogContext'
import { RemotePane } from './RemotePane'

test('Linux replaces a saved managed tunnel only after the user selects external ingress', async (t) => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  Object.assign(window, {
    api: {
      process: { platform: 'linux' },
      yachiyo: {
        getRemoteStatus: async () => null,
        listRemotePairings: async () => []
      }
    }
  })
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const changes: SettingsConfig[] = []
  const initial: SettingsConfig = {
    providers: [],
    remote: {
      ...DEFAULT_REMOTE_CONFIG,
      enabled: true,
      tunnel: 'named',
      namedHostname: 'saved.example.com',
      publicEndpoint: 'https://vm.example.com',
      port: 50000
    }
  }
  function Pane(): React.JSX.Element {
    const [draft, setDraft] = useState(initial)
    return (
      <AppDialogContext.Provider
        value={{
          alert: async () => undefined,
          confirm: async () => false,
          prompt: async () => null
        }}
      >
        <RemotePane
          draft={draft}
          onChange={(next) => {
            changes.push(next)
            setDraft(next)
          }}
        />
      </AppDialogContext.Provider>
    )
  }
  const root = createRoot(document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
  })
  await act(async () => root.render(<Pane />))
  assert.equal(changes.length, 0, 'viewing settings must not silently rewrite saved configuration')
  assert.equal(document.querySelector('[aria-haspopup="listbox"]'), null)
  assert.equal(
    document.querySelector('input'),
    null,
    'an unsupported named hostname is not editable'
  )
  const migrate = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Use external endpoint'
  )
  assert.ok(migrate)
  await act(async () => {
    migrate.click()
  })
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], { ...initial, remote: { ...initial.remote!, tunnel: 'none' } })
  assert.equal(document.querySelector('input')?.value, 'https://vm.example.com')
  assert.equal(document.querySelector('[aria-haspopup="listbox"]'), null)
  assert.equal(
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === 'Use external endpoint'
    ),
    false
  )
})
