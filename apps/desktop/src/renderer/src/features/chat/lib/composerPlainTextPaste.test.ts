import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPlainTextPasteValue, isPastePlainTextShortcut } from './composerPlainTextPaste.ts'

test('isPastePlainTextShortcut matches Shift+Cmd+V', () => {
  assert.equal(
    isPastePlainTextShortcut({
      altKey: false,
      code: 'KeyV',
      ctrlKey: false,
      key: 'V',
      metaKey: true,
      shiftKey: true
    }),
    true
  )
})

test('isPastePlainTextShortcut rejects nearby paste shortcuts', () => {
  assert.equal(
    isPastePlainTextShortcut({
      altKey: false,
      code: 'KeyV',
      ctrlKey: false,
      key: 'v',
      metaKey: true,
      shiftKey: false
    }),
    false
  )

  assert.equal(
    isPastePlainTextShortcut({
      altKey: false,
      code: 'KeyV',
      ctrlKey: false,
      key: 'v',
      metaKey: true,
      shiftKey: false
    }),
    false
  )

  assert.equal(
    isPastePlainTextShortcut({
      altKey: true,
      code: 'KeyV',
      ctrlKey: false,
      key: '√',
      metaKey: true,
      shiftKey: false
    }),
    false
  )
})

test('buildPlainTextPasteValue replaces the active textarea selection', () => {
  assert.deepEqual(
    buildPlainTextPasteValue({
      currentValue: 'Ask  please',
      pastedText: 'plain text',
      selectionEnd: 4,
      selectionStart: 4
    }),
    {
      caretOffset: 14,
      value: 'Ask plain text please'
    }
  )

  assert.deepEqual(
    buildPlainTextPasteValue({
      currentValue: 'Ask rich content',
      pastedText: 'plain',
      selectionEnd: 8,
      selectionStart: 4
    }),
    {
      caretOffset: 9,
      value: 'Ask plain content'
    }
  )
})
