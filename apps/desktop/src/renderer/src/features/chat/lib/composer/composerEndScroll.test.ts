import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveComposerCaretOverlayScrollTop,
  shouldSyncComposerEndScroll,
  syncComposerEndScroll
} from './composerEndScroll.ts'

test('waits for the new overlay before syncing, and leaves width-only updates alone', () => {
  assert.equal(shouldSyncComposerEndScroll('new draft', 'old draft', 'old draft'), false)
  assert.equal(shouldSyncComposerEndScroll('new draft', 'new draft', 'old draft'), true)
  assert.equal(shouldSyncComposerEndScroll('new draft', 'new draft', 'new draft'), false)
})

test('aligns the overlay after long multiline text changes, including an extra trailing line', () => {
  const textarea = { scrollHeight: 600, clientHeight: 220, scrollTop: 320 }
  const overlay = { scrollHeight: 623, clientHeight: 220, scrollTop: 320 }
  syncComposerEndScroll(textarea, overlay)
  assert.equal(textarea.scrollTop, 380)
  assert.equal(overlay.scrollTop, 403)
})

test('does not move a short composer with no overflow', () => {
  const textarea = { scrollHeight: 80, clientHeight: 80, scrollTop: 0 }
  const overlay = { scrollHeight: 80, clientHeight: 80, scrollTop: 0 }
  syncComposerEndScroll(textarea, overlay)
  assert.equal(textarea.scrollTop, 0)
  assert.equal(overlay.scrollTop, 0)
})

test('caret remeasurement retains the trailing-line offset without snapping manual scroll', () => {
  const metrics = { caretBottom: 580, viewportHeight: 220, contentHeight: 623, atEnd: true }
  assert.equal(
    resolveComposerCaretOverlayScrollTop({ ...metrics, previous: 403, textareaTop: 380 }),
    403
  )
  assert.equal(
    resolveComposerCaretOverlayScrollTop({ ...metrics, previous: 350, textareaTop: 350 }),
    360
  )
  assert.equal(
    resolveComposerCaretOverlayScrollTop({
      ...metrics,
      caretBottom: 560,
      previous: 350,
      textareaTop: 350
    }),
    350
  )
})
