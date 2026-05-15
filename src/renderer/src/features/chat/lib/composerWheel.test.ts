import assert from 'node:assert/strict'
import test from 'node:test'
import { forwardComposerWheelToTimeline, resolveComposerWheelDestination } from './composerWheel.ts'

test('composer wheel stays local while the textarea can scroll vertically', () => {
  assert.equal(
    resolveComposerWheelDestination({
      deltaX: 0,
      deltaY: 24,
      overAttachmentStrip: false,
      overTextarea: true,
      popupOpen: false,
      textarea: { scrollOffset: 10, viewportSize: 100, contentSize: 200 },
      attachmentStrip: null
    }),
    'local'
  )
})

test('composer wheel forwards textarea boundary scroll to the timeline', () => {
  assert.equal(
    resolveComposerWheelDestination({
      deltaX: 0,
      deltaY: 24,
      overAttachmentStrip: false,
      overTextarea: true,
      popupOpen: false,
      textarea: { scrollOffset: 100, viewportSize: 100, contentSize: 200 },
      attachmentStrip: null
    }),
    'timeline'
  )
})

test('composer wheel turns vertical wheel over attachments into horizontal attachment scrolling', () => {
  assert.equal(
    resolveComposerWheelDestination({
      deltaX: 0,
      deltaY: 24,
      overAttachmentStrip: true,
      overTextarea: false,
      popupOpen: false,
      textarea: null,
      attachmentStrip: { scrollOffset: 0, viewportSize: 200, contentSize: 360 }
    }),
    'attachments'
  )
})

test('composer wheel forwards ordinary composer wheel movement to the timeline', () => {
  assert.equal(
    resolveComposerWheelDestination({
      deltaX: 0,
      deltaY: -24,
      overAttachmentStrip: false,
      overTextarea: false,
      popupOpen: false,
      textarea: null,
      attachmentStrip: null
    }),
    'timeline'
  )
})

test('composer wheel does not steal horizontal wheel gestures or popup scroll', () => {
  assert.equal(
    resolveComposerWheelDestination({
      deltaX: 40,
      deltaY: 4,
      overAttachmentStrip: true,
      overTextarea: false,
      popupOpen: false,
      textarea: null,
      attachmentStrip: { scrollOffset: 0, viewportSize: 200, contentSize: 360 }
    }),
    'none'
  )

  assert.equal(
    resolveComposerWheelDestination({
      deltaX: 0,
      deltaY: 24,
      overAttachmentStrip: false,
      overTextarea: false,
      popupOpen: true,
      textarea: null,
      attachmentStrip: null
    }),
    'none'
  )
})

test('forwarded composer wheel reaches timeline wheel listeners before scrolling', () => {
  const calls: string[] = []
  const timeline = {
    dispatchEvent(event: Event): boolean {
      calls.push(`wheel:${(event as WheelEvent).deltaY}`)
      assert.equal(event.type, 'wheel')
      assert.equal((event as WheelEvent).deltaX, 0)
      assert.equal((event as WheelEvent).deltaY, -18)
      assert.equal((event as WheelEvent).deltaMode, 0)
      return true
    },
    scrollBy(options: ScrollToOptions): void {
      calls.push(`scroll:${options.top}`)
    }
  }

  forwardComposerWheelToTimeline(timeline, {
    altKey: false,
    ctrlKey: false,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -18,
    metaKey: false,
    shiftKey: false
  })

  assert.deepEqual(calls, ['wheel:-18', 'scroll:-18'])
})
