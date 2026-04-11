import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import type { MessageRecord } from '../../../../shared/yachiyo/protocol.ts'
import {
  deriveDownloadFilename,
  replaceMarkdownImageUrl,
  rewriteMessageImageUrl
} from './remoteImageDomain.ts'

function makeAssistantMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'msg_1',
    threadId: 'thread_1',
    role: 'assistant',
    content: '',
    status: 'completed',
    createdAt: '2026-04-11T00:00:00.000Z',
    ...overrides
  }
}

describe('remoteImageDomain.replaceMarkdownImageUrl', () => {
  it('replaces a single matching image src, wrapping the replacement in angle brackets', () => {
    const input = 'Here: ![chart](https://ex.com/a.png) end.'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/local/a.png')
    assert.equal(out.content, 'Here: ![chart](</local/a.png>) end.')
    assert.equal(out.replaced, 1)
  })

  it('replaces multiple occurrences of the same URL', () => {
    const input = '![a](https://ex.com/x.png) and again ![b](https://ex.com/x.png)'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/x.png', '/local/x.png')
    assert.equal(out.content, '![a](</local/x.png>) and again ![b](</local/x.png>)')
    assert.equal(out.replaced, 2)
  })

  it('does not touch non-matching image URLs', () => {
    const input = '![a](https://ex.com/a.png) ![b](https://ex.com/b.png)'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/b.png', '/local/b.png')
    assert.equal(out.content, '![a](https://ex.com/a.png) ![b](</local/b.png>)')
    assert.equal(out.replaced, 1)
  })

  it('leaves regular markdown links alone even if they share the URL', () => {
    const input = '[click me](https://ex.com/a.png) not an image'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/local/a.png')
    assert.equal(out.content, input)
    assert.equal(out.replaced, 0)
  })

  it('returns zero replacements when the URL is absent', () => {
    const input = 'just some text'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/missing.png', '/local/x.png')
    assert.equal(out.content, 'just some text')
    assert.equal(out.replaced, 0)
  })

  it('handles URLs with balanced parentheses in the destination (CommonMark rule)', () => {
    const input = 'wiki: ![thumb](https://example.com/a_(1).png) end'
    const out = replaceMarkdownImageUrl(input, 'https://example.com/a_(1).png', '/local/a_1.png')
    assert.equal(out.content, 'wiki: ![thumb](</local/a_1.png>) end')
    assert.equal(out.replaced, 1)
  })

  it('handles URLs wrapped in angle brackets', () => {
    const input = 'see ![chart](<https://example.com/a.png>) here'
    const out = replaceMarkdownImageUrl(input, 'https://example.com/a.png', '/local/a.png')
    assert.equal(out.content, 'see ![chart](</local/a.png>) here')
    assert.equal(out.replaced, 1)
  })

  it('handles angle-bracketed URLs that contain spaces', () => {
    const input = 'see ![chart](<https://example.com/a b.png>) here'
    const out = replaceMarkdownImageUrl(input, 'https://example.com/a b.png', '/local/a.png')
    assert.equal(out.content, 'see ![chart](</local/a.png>) here')
    assert.equal(out.replaced, 1)
  })

  it('wraps local paths containing spaces and parens in angle brackets', () => {
    const input = '![x](https://ex.com/a.png)'
    const out = replaceMarkdownImageUrl(
      input,
      'https://ex.com/a.png',
      '/Users/me/My Photos/a (1).png'
    )
    assert.equal(out.content, '![x](</Users/me/My Photos/a (1).png>)')
    assert.equal(out.replaced, 1)
  })

  it('escapes angle-bracket terminators inside the replacement path', () => {
    const input = '![x](https://ex.com/a.png)'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/weird/<a>.png')
    assert.equal(out.content, '![x](</weird/\\<a\\>.png>)')
    assert.equal(out.replaced, 1)
  })

  it('handles alt text with nested balanced brackets', () => {
    // CommonMark allows balanced brackets inside link/image alt text.
    const input = '![plot [v2]](https://ex.com/a.png)'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/local/a.png')
    assert.equal(out.content, '![plot [v2]](</local/a.png>)')
    assert.equal(out.replaced, 1)
  })

  it('handles alt text with escaped closing brackets', () => {
    // `\]` is a backslash-escape, not the end of alt text.
    const input = '![see \\] inside](https://ex.com/a.png)'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/local/a.png')
    assert.equal(out.content, '![see \\] inside](</local/a.png>)')
    assert.equal(out.replaced, 1)
  })

  it('handles deeply nested brackets in alt text', () => {
    const input = '![a [b [c]] d](https://ex.com/a.png) tail'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/local/a.png')
    assert.equal(out.content, '![a [b [c]] d](</local/a.png>) tail')
    assert.equal(out.replaced, 1)
  })

  it('rejects images with unbalanced alt-text brackets', () => {
    // Unbalanced brackets are not a valid markdown image — the scanner
    // should skip it and not crash or mis-match later content.
    const input = '![oops [unclosed](https://ex.com/a.png)'
    const out = replaceMarkdownImageUrl(input, 'https://ex.com/a.png', '/local/a.png')
    assert.equal(out.content, input)
    assert.equal(out.replaced, 0)
  })
})

describe('remoteImageDomain.rewriteMessageImageUrl', () => {
  const URL = 'https://ex.com/a.png'
  const LOCAL = '/abs/a.png'
  const WRAPPED = `<${LOCAL}>`

  it('rewrites the top-level content field', () => {
    const message = makeAssistantMessage({ content: `![alt](${URL})` })
    const out = rewriteMessageImageUrl(message, URL, LOCAL)
    assert.equal(out.message.content, `![alt](${WRAPPED})`)
    assert.equal(out.replaced, 1)
  })

  it('rewrites URLs inside every textBlocks entry (the MessageTimeline bug)', () => {
    const message = makeAssistantMessage({
      content: `prelude ![alt](${URL}) end`,
      textBlocks: [
        { id: 'tb1', content: `intro ![alt](${URL})`, createdAt: 'x' },
        { id: 'tb2', content: 'no image here', createdAt: 'x' },
        { id: 'tb3', content: `again ![alt](${URL})`, createdAt: 'x' }
      ]
    })
    const out = rewriteMessageImageUrl(message, URL, LOCAL)
    assert.equal(out.message.content, `prelude ![alt](${WRAPPED}) end`)
    assert.equal(out.message.textBlocks?.[0].content, `intro ![alt](${WRAPPED})`)
    assert.equal(out.message.textBlocks?.[1].content, 'no image here')
    assert.equal(out.message.textBlocks?.[2].content, `again ![alt](${WRAPPED})`)
    assert.equal(out.replaced, 3)
  })

  it('rewrites visibleReply for external-channel messages', () => {
    const message = makeAssistantMessage({
      content: `wrapped ![alt](${URL})`,
      visibleReply: `clean ![alt](${URL})`
    })
    const out = rewriteMessageImageUrl(message, URL, LOCAL)
    assert.equal(out.message.visibleReply, `clean ![alt](${WRAPPED})`)
    assert.equal(out.replaced, 2)
  })

  it('leaves textBlocks array identity intact when no blocks match', () => {
    const blocks = [{ id: 'tb1', content: 'no image', createdAt: 'x' }]
    const message = makeAssistantMessage({
      content: `![alt](${URL})`,
      textBlocks: blocks
    })
    const out = rewriteMessageImageUrl(message, URL, LOCAL)
    // Unchanged blocks keep their reference — avoids spurious re-renders.
    assert.equal(out.message.textBlocks, blocks)
    assert.equal(out.replaced, 1)
  })

  it('reports zero replacements when the URL is nowhere in the message', () => {
    const message = makeAssistantMessage({
      content: 'just text',
      textBlocks: [{ id: 'tb1', content: 'also just text', createdAt: 'x' }],
      visibleReply: 'clean text'
    })
    const out = rewriteMessageImageUrl(message, URL, LOCAL)
    assert.equal(out.replaced, 0)
    assert.equal(out.message.content, 'just text')
  })
})

describe('remoteImageDomain.deriveDownloadFilename', () => {
  it('uses the last URL segment when it already has an image extension', () => {
    const name = deriveDownloadFilename('https://ex.com/path/photo.jpg', 'image/jpeg')
    assert.equal(name, 'photo.jpg')
  })

  it('rewrites a mismatched extension to the content-type extension', () => {
    const name = deriveDownloadFilename('https://ex.com/photo.xyz', 'image/png')
    assert.equal(name, 'photo.png')
  })

  it('handles URLs without a pathname', () => {
    const name = deriveDownloadFilename('https://ex.com', 'image/png')
    assert.equal(name, 'image.png')
  })

  it('sanitizes unsafe characters in the filename', () => {
    const name = deriveDownloadFilename('https://ex.com/cat%20face.png', 'image/png')
    assert.equal(name, 'cat_face.png')
  })

  it('falls back to .bin extension when content-type is unknown', () => {
    const name = deriveDownloadFilename('https://ex.com/mystery', 'application/octet-stream')
    assert.equal(name, 'mystery.bin')
  })

  it('falls back to "image" when the URL has no path segment', () => {
    const name = deriveDownloadFilename('https://ex.com', 'image/png')
    assert.equal(name, 'image.png')
  })
})
