import assert from 'node:assert/strict'
import test from 'node:test'
import { captureResponseShare, type ShareCaptureDependencies } from './responseShareCapture.ts'

function fixture(): {
  controller: AbortController
  dependencies: ShareCaptureDependencies
  events: string[]
  blobs: Blob[]
} {
  const controller = new AbortController()
  const events: string[] = []
  const blobs = [
    new Blob(['first'], { type: 'image/png' }),
    new Blob(['second'], { type: 'image/png' })
  ]
  const pages = [200, 300].map(
    (height) => ({ getBoundingClientRect: () => ({ height }) }) as HTMLElement
  )
  let index = 0
  const dependencies: ShareCaptureDependencies = {
    prepare: async () => ({
      pages,
      dispose: () => {
        events.push('dispose')
      }
    }),
    loadEngine: async () => ({
      getFontEmbedCSS: async (_page, options) => {
        assert.equal(options?.includeQueryParams, true)
        events.push('fonts')
        return 'embedded-fonts'
      },
      toBlob: async (_page, options) => {
        const current = index++
        events.push(`start${current}`)
        assert.equal(options?.width, 720)
        assert.equal(options?.pixelRatio, 2)
        assert.equal(options?.fontEmbedCSS, 'embedded-fonts')
        assert.equal(options?.includeQueryParams, true)
        await Promise.resolve()
        events.push(`end${current}`)
        return blobs[current]!
      }
    })
  }
  return { controller, dependencies, events, blobs }
}

test('embeds fonts once, serial captures, returns the exact PNG bytes and releases DOM', async () => {
  const f = fixture()
  const result = await captureResponseShare(
    {} as HTMLElement,
    { layout: 'pages', signal: f.controller.signal },
    f.dependencies
  )
  assert.equal(result[0], f.blobs[0])
  assert.equal(result[1], f.blobs[1])
  assert.deepEqual(f.events.slice(0, 5), ['fonts', 'start0', 'end0', 'start1', 'end1'])
  assert.ok(f.events.includes('dispose'))
})

test('obsolete generation cannot return an already captured first page', async () => {
  const f = fixture()
  const load = f.dependencies.loadEngine
  f.dependencies.loadEngine = async () => {
    const engine = await load()
    const capture = engine.toBlob
    engine.toBlob = async (page, options) => {
      const blob = await capture(page, options)
      f.controller.abort()
      return blob
    }
    return engine
  }
  await assert.rejects(
    captureResponseShare(
      {} as HTMLElement,
      { layout: 'pages', signal: f.controller.signal },
      f.dependencies
    ),
    { name: 'AbortError' }
  )
  assert.ok(!f.events.includes('start1'))
  assert.ok(f.events.includes('dispose'))
})

test('null PNG fails the batch and releases DOM', async () => {
  const f = fixture()
  f.dependencies.loadEngine = async () => ({
    getFontEmbedCSS: async () => '',
    toBlob: async () => null
  })
  await assert.rejects(
    captureResponseShare(
      {} as HTMLElement,
      { layout: 'auto', signal: f.controller.signal },
      f.dependencies
    ),
    /PNG generation failed/
  )
  assert.ok(f.events.includes('dispose'))
})

test('timeout stops export and late preparation is disposed', async () => {
  const f = fixture()
  let release!: () => void
  f.dependencies.prepare = async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      pages: [],
      dispose: () => {
        f.events.push('late-dispose')
      }
    }
  }
  await assert.rejects(
    captureResponseShare(
      {} as HTMLElement,
      { layout: 'auto', signal: f.controller.signal, timeoutMs: 5 },
      f.dependencies
    ),
    /timed out/
  )
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(f.events.includes('late-dispose'))
  assert.ok(!f.events.includes('fonts'))
})

test('already aborted capture never starts preparation or produces unhandled work', async () => {
  const f = fixture()
  f.controller.abort()
  await assert.rejects(
    captureResponseShare(
      {} as HTMLElement,
      { layout: 'auto', signal: f.controller.signal },
      f.dependencies
    ),
    { name: 'AbortError' }
  )
  assert.deepEqual(f.events, [])
})

test('font embedding failure cannot export partial pages', async () => {
  const f = fixture()
  f.dependencies.loadEngine = async () => ({
    getFontEmbedCSS: async () => {
      throw new Error('font unavailable')
    },
    toBlob: async () => {
      throw new Error('must not capture')
    }
  })
  await assert.rejects(
    captureResponseShare(
      {} as HTMLElement,
      { layout: 'auto', signal: f.controller.signal },
      f.dependencies
    ),
    /font unavailable/
  )
  assert.ok(f.events.includes('dispose'))
})
