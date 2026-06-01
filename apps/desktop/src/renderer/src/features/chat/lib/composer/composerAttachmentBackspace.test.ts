import assert from 'node:assert/strict'
import test from 'node:test'

import { selectComposerBackspaceAttachmentRemoval } from './composerAttachmentBackspace.ts'

const plainBackspace = {
  key: 'Backspace',
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 8
}

test('selects the rightmost file attachment from an empty composer', () => {
  assert.deepEqual(
    selectComposerBackspaceAttachmentRemoval({
      event: plainBackspace,
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
      images: [{ id: 'image-1' }],
      files: [{ id: 'file-1' }, { id: 'file-2' }]
    }),
    { kind: 'file', id: 'file-2' }
  )
})

test('selects the rightmost image when no file attachments are staged', () => {
  assert.deepEqual(
    selectComposerBackspaceAttachmentRemoval({
      event: plainBackspace,
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
      images: [{ id: 'image-1' }, { id: 'image-2' }],
      files: []
    }),
    { kind: 'image', id: 'image-2' }
  )
})

test('keeps attachments when the composer still has editable text', () => {
  assert.equal(
    selectComposerBackspaceAttachmentRemoval({
      event: plainBackspace,
      text: ' ',
      selectionStart: 1,
      selectionEnd: 1,
      images: [{ id: 'image-1' }],
      files: [{ id: 'file-1' }]
    }),
    null
  )
})

test('ignores Backspace variants that should keep their native text behavior', () => {
  assert.equal(
    selectComposerBackspaceAttachmentRemoval({
      event: { ...plainBackspace, metaKey: true },
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
      images: [{ id: 'image-1' }],
      files: [{ id: 'file-1' }]
    }),
    null
  )

  assert.equal(
    selectComposerBackspaceAttachmentRemoval({
      event: { ...plainBackspace, isComposing: true },
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
      images: [{ id: 'image-1' }],
      files: []
    }),
    null
  )
})
