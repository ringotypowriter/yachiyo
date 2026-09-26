import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  releaseBrowserPreview,
  BROWSER_PREVIEW_INSPECTION_SCRIPT,
  inspectBrowserPreviewFrames
} from './browserPreviewRetention.ts'

test('pristine search inputs are discardable, but input events remain protected after SPA value reset', () => {
  class Input {
    localName = 'input'
    type = 'search'
    value = ''
    defaultValue = ''
    checked = false
    defaultChecked = false
  }
  const input = new Input()
  const listeners = new Map<string, () => void>()
  const context = {
    window: {},
    scrollX: 0,
    scrollY: 75,
    document: {
      readyState: 'complete',
      querySelectorAll: () => [input],
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback)
    },
    HTMLInputElement: Input,
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLMediaElement: class {}
  }
  assert.equal(runInNewContext(BROWSER_PREVIEW_INSPECTION_SCRIPT, context).safe, false)
  assert.equal(runInNewContext(BROWSER_PREVIEW_INSPECTION_SCRIPT, context).safe, true)
  input.value = 'unsent search'
  listeners.get('input')!()
  input.value = ''
  assert.equal(runInNewContext(BROWSER_PREVIEW_INSPECTION_SCRIPT, context).safe, false)
})

test('frame inspection requires every frame to be safe and rejects inaccessible or hung frames', async () => {
  const safe = { executeJavaScript: async () => ({ safe: true, scrollX: 0, scrollY: 75 }) }
  assert.equal(
    (
      await inspectBrowserPreviewFrames(
        [safe, { executeJavaScript: async () => ({ safe: false }) }],
        1
      )
    ).safe,
    false
  )
  assert.equal((await inspectBrowserPreviewFrames([], 1)).safe, false)
  await assert.rejects(
    inspectBrowserPreviewFrames(
      [
        safe,
        {
          executeJavaScript: async () => {
            throw new Error('frame inaccessible')
          }
        }
      ],
      1
    ),
    /inaccessible/
  )
  await assert.rejects(
    inspectBrowserPreviewFrames([{ executeJavaScript: () => new Promise(() => {}) }], 1, 5),
    /timed out/
  )
})

function fixture(): {
  state: {
    owned: boolean
    busy: boolean
    visible: boolean
    media: boolean
    downloads: number
    dirty: boolean
  }
  counts: () => { destroyed: number; detached: number }
  resource: Parameters<typeof releaseBrowserPreview>[0]
} {
  let destroyed = 0
  let detached = 0
  const state = {
    owned: true,
    busy: false,
    visible: false,
    media: false,
    downloads: 0,
    dirty: false
  }
  return {
    state,
    counts: () => ({ destroyed, detached }),
    resource: {
      protected: () =>
        !state.owned || state.busy || state.visible || state.media || state.downloads > 0,
      shared: () => !state.owned || state.busy,
      inspect: async () => ({
        safe: !state.dirty,
        reading: { webScrollX: 4, webScrollY: 500, webZoom: 1.25 }
      }),
      detach: () => {
        detached++
      },
      destroy: () => {
        destroyed++
      },
      current: () => true
    }
  }
}
test('ordinary owned pages release with lightweight reading state', async () => {
  const { resource, counts } = fixture()
  const result = await releaseBrowserPreview(resource, 'auto')
  assert.deepEqual(result, {
    released: true,
    reading: { webScrollX: 4, webScrollY: 500, webZoom: 1.25 }
  })
  assert.equal(counts().destroyed, 1)
})
for (const field of ['busy', 'visible', 'media', 'dirty'] as const) {
  test(`${field} pages defer automatic release`, async () => {
    const { resource, state, counts } = fixture()
    state[field] = true
    assert.equal((await releaseBrowserPreview(resource, 'auto')).released, false)
    assert.equal(counts().destroyed, 0)
  })
}
test('downloads and shared agent sessions are protected; explicit shared close only detaches', async () => {
  const { resource, state, counts } = fixture()
  state.downloads = 1
  assert.equal((await releaseBrowserPreview(resource, 'auto')).released, false)
  state.owned = false
  assert.equal((await releaseBrowserPreview(resource, 'close')).released, true)
  assert.deepEqual(counts(), { destroyed: 0, detached: 1 })
})
test('explicit close frees owned unsaved pages while failed inspection is fail-closed for auto discard', async () => {
  const { resource, state, counts } = fixture()
  state.dirty = true
  resource.inspect = async () => {
    throw new Error('unavailable frame')
  }
  assert.equal((await releaseBrowserPreview(resource, 'auto')).released, false)
  assert.equal((await releaseBrowserPreview(resource, 'close')).released, true)
  assert.equal(counts().destroyed, 1)
})
test('new agent use or visibility during inspection prevents destruction', async () => {
  const { resource, state, counts } = fixture()
  resource.inspect = async () => {
    state.busy = true
    return { safe: true, reading: { webScrollX: 0, webScrollY: 0, webZoom: 1 } }
  }
  assert.equal((await releaseBrowserPreview(resource, 'auto')).released, false)
  assert.equal(counts().destroyed, 0)
})
test('unavailable native protection state defers discard rather than rejecting the idle sweep', async () => {
  const { resource, counts } = fixture()
  resource.protected = () => {
    throw new Error('WebContents destroyed')
  }
  assert.equal((await releaseBrowserPreview(resource, 'auto')).released, false)
  assert.equal(counts().destroyed, 0)
})
