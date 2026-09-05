import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getFilePreviewKind, decodePreviewText } from './filePreview.ts'

test('classifies supported documents and images without treating executable HTML as a page', () => {
  assert.equal(getFilePreviewKind('/work/REPORT.MD'), 'markdown')
  assert.equal(getFilePreviewKind('/work/report.pdf'), 'pdf')
  assert.equal(getFilePreviewKind('/work/cover.png'), 'image')
  assert.equal(getFilePreviewKind('/work/index.html'), 'text')
  assert.equal(getFilePreviewKind('/work/app.tsx'), 'text')
  assert.equal(getFilePreviewKind('/work/report.docx'), null)
  assert.equal(getFilePreviewKind('/work/archive.zip'), null)
})

test('text preview rejects binary and malformed UTF-8 rather than displaying corrupt content', () => {
  assert.equal(decodePreviewText(new TextEncoder().encode('Hello 京都')), 'Hello 京都')
  assert.throws(() => decodePreviewText(new Uint8Array([65, 0, 66])))
  assert.throws(() => decodePreviewText(new Uint8Array([0xff])))
})
