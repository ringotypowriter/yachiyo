import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractBase64DataUrlPayload,
  hasMessagePayload,
  normalizeMessageImages,
  stripMarkdown,
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

test('stripMarkdown removes headings', () => {
  assert.equal(stripMarkdown('# Hello'), 'Hello')
  assert.equal(stripMarkdown('## Sub heading'), 'Sub heading')
  assert.equal(stripMarkdown('### Deep'), 'Deep')
})

test('stripMarkdown removes bold and italic markers', () => {
  assert.equal(stripMarkdown('**bold**'), 'bold')
  assert.equal(stripMarkdown('__bold__'), 'bold')
  assert.equal(stripMarkdown('*italic*'), 'italic')
  assert.equal(stripMarkdown('_italic_'), 'italic')
  assert.equal(stripMarkdown('***both***'), 'both')
  assert.equal(stripMarkdown('~~struck~~'), 'struck')
})

test('stripMarkdown unwraps inline code', () => {
  assert.equal(stripMarkdown('use `foo()` here'), 'use foo() here')
})

test('stripMarkdown strips fenced code blocks', () => {
  assert.equal(stripMarkdown('```ts\nconst x = 1\n```'), 'const x = 1')
  assert.equal(stripMarkdown('```\nplain\n```'), 'plain')
})

test('stripMarkdown extracts link text', () => {
  assert.equal(stripMarkdown('[click here](https://example.com)'), 'click here')
  assert.equal(stripMarkdown('![alt text](image.png)'), 'alt text')
})

test('stripMarkdown removes blockquote markers', () => {
  assert.equal(stripMarkdown('> quoted text'), 'quoted text')
  assert.equal(stripMarkdown('>> nested'), 'nested')
})

test('stripMarkdown removes list markers', () => {
  assert.equal(stripMarkdown('- item one\n- item two'), 'item one item two')
  assert.equal(stripMarkdown('* star item'), 'star item')
  assert.equal(stripMarkdown('1. numbered'), 'numbered')
})

test('stripMarkdown removes horizontal rules', () => {
  assert.equal(stripMarkdown('above\n---\nbelow'), 'above below')
  assert.equal(stripMarkdown('above\n***\nbelow'), 'above below')
})

test('stripMarkdown collapses whitespace', () => {
  assert.equal(stripMarkdown('hello\n\n\nworld'), 'hello world')
  assert.equal(stripMarkdown('  spaced  out  '), 'spaced out')
})

test('stripMarkdown handles plain text passthrough', () => {
  assert.equal(stripMarkdown('just plain text'), 'just plain text')
  assert.equal(stripMarkdown(''), '')
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
