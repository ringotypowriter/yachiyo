import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractBase64DataUrlPayload,
  hasMessagePayload,
  normalizeMessageImages,
  summarizeMessageInput
} from './messageContent.ts'

test('normalizeMessageImages filters invalid entries', () => {
  assert.deepEqual(normalizeMessageImages(undefined), [])
  assert.deepEqual(normalizeMessageImages([]), [])
  assert.deepEqual(normalizeMessageImages([{ dataUrl: '', mediaType: 'image/png' }]), [])
  assert.deepEqual(normalizeMessageImages([{ dataUrl: '   ', mediaType: 'image/png' }]), [])
  assert.deepEqual(
    normalizeMessageImages([{ dataUrl: 'data:image/png;base64,abc', mediaType: '' }]),
    []
  )
})

test('normalizeMessageImages trims and preserves valid fields', () => {
  const images = normalizeMessageImages([
    {
      dataUrl: '  data:image/png;base64,abc  ',
      mediaType: '  image/png  ',
      filename: '  photo.png  '
    }
  ])

  assert.equal(images.length, 1)
  assert.equal(images[0].dataUrl, 'data:image/png;base64,abc')
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].filename, 'photo.png')
})

test('normalizeMessageImages preserves workspacePath and altText', () => {
  const images = normalizeMessageImages([
    {
      dataUrl: 'data:image/png;base64,abc',
      mediaType: 'image/png',
      filename: 'photo.png',
      workspacePath: '/tmp/photo.png',
      altText: 'A photo'
    }
  ])

  assert.equal(images.length, 1)
  assert.equal(images[0].workspacePath, '/tmp/photo.png')
  assert.equal(images[0].altText, 'A photo')
})

test('normalizeMessageImages omits empty optional fields', () => {
  const images = normalizeMessageImages([
    { dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' }
  ])

  assert.equal(images[0].filename, undefined)
  assert.equal(images[0].workspacePath, undefined)
  assert.equal(images[0].altText, undefined)
})

test('extractBase64DataUrlPayload parses valid data URLs', () => {
  const result = extractBase64DataUrlPayload('data:image/png;base64,SGVsbG8=')
  assert.deepEqual(result, { mediaType: 'image/png', base64: 'SGVsbG8=' })
})

test('extractBase64DataUrlPayload returns null for invalid inputs', () => {
  assert.equal(extractBase64DataUrlPayload('not-a-data-url'), null)
  assert.equal(extractBase64DataUrlPayload('data:image/png;base64,'), null)
  assert.equal(extractBase64DataUrlPayload('data:text/plain,hello'), null)
})

test('hasMessagePayload detects content, images, and attachments', () => {
  assert.equal(hasMessagePayload({ content: 'Hello' }), true)
  assert.equal(hasMessagePayload({ content: '' }), false)
  assert.equal(
    hasMessagePayload({
      content: '',
      images: [{ dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' }]
    }),
    true
  )
  assert.equal(
    hasMessagePayload({
      content: '',
      attachments: [{ filename: 'file.txt', mediaType: 'text/plain' }]
    }),
    true
  )
})

test('summarizeMessageInput returns text or image summary', () => {
  assert.equal(summarizeMessageInput({ content: 'Hello' }), 'Hello')
  assert.equal(
    summarizeMessageInput({
      content: '',
      images: [{ dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' }]
    }),
    'Shared an image'
  )
  assert.equal(
    summarizeMessageInput({
      content: '',
      images: [
        { dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png' },
        { dataUrl: 'data:image/jpeg;base64,def', mediaType: 'image/jpeg' }
      ]
    }),
    'Shared 2 images'
  )
  assert.equal(summarizeMessageInput({ content: '' }), '')
})
