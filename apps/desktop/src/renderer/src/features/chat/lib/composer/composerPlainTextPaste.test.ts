import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPlainTextPasteValue,
  isPastePlainTextShortcut as isPastePlainTextShortcutForPlatform
} from './composerPlainTextPaste.ts'

const isPastePlainTextShortcut = (
  event: Parameters<typeof isPastePlainTextShortcutForPlatform>[0],
  platform = 'darwin'
): boolean => isPastePlainTextShortcutForPlatform(event, platform)

test('isPastePlainTextShortcut matches Shift+Cmd+V', () => {
  assert.equal(
    isPastePlainTextShortcut(
      {
        altKey: false,
        code: 'KeyV',
        ctrlKey: false,
        key: 'V',
        metaKey: true,
        shiftKey: true
      },
      'darwin'
    ),
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

test('isPastePlainTextShortcut uses Shift+Ctrl+V on Windows without ambiguous modifiers', () => {
  assert.equal(
    isPastePlainTextShortcut(
      {
        altKey: false,
        code: 'KeyV',
        ctrlKey: true,
        key: 'V',
        metaKey: false,
        shiftKey: true
      },
      'win32'
    ),
    true
  )
  assert.equal(
    isPastePlainTextShortcut(
      {
        altKey: false,
        code: 'KeyV',
        ctrlKey: true,
        key: 'V',
        metaKey: true,
        shiftKey: true
      },
      'win32'
    ),
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
