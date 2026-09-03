import assert from 'node:assert/strict'
import test from 'node:test'

import { extractMarkdownFileReferences } from './markdownFileReferences.ts'
import { rewriteWorkspaceFileLinksForHarden } from './workspaceFileLinkRehypePlugin.ts'

function linkNode(href: string): {
  type: string
  tagName: string
  properties: Record<string, unknown>
  children: never[]
} {
  return { type: 'element', tagName: 'a', properties: { href }, children: [] }
}

function linksTo(href: string, existingFiles: string[]): boolean {
  const node = linkNode(href)
  rewriteWorkspaceFileLinksForHarden(node as never, new Set(existingFiles))
  return node.tagName === 'span'
}

test('an encoded destination is asked about under both readings', () => {
  // The resolver only knows about the strings it is given, so the decoded
  // reading has to be one of them or the link can never resolve.
  assert.deepEqual(extractMarkdownFileReferences('[x](a%23b.md)'), ['a#b.md', 'a%23b.md'])
})

test('a file whose name contains the decoded character now links', () => {
  // This is the whole point: before, the destination was only ever compared
  // against the encoded string, so a file named "a#b.md" was unreachable.
  assert.equal(linksTo('a%23b.md', ['a#b.md']), true)
  assert.equal(linksTo('a%3Fb.md', ['a?b.md']), true)
  assert.equal(linksTo('docs%2Fnotes.md', ['docs/notes.md']), true)
  assert.equal(linksTo('a%20b.md', ['a b.md']), true)
})

test('a file literally named with percent escapes still links', () => {
  assert.equal(linksTo('a%23b.md', ['a%23b.md']), true)
  assert.equal(linksTo('50%.md', ['50%.md']), true)
})

test('when both files exist the decoded reading wins', () => {
  const node = linkNode('a%23b.md')
  rewriteWorkspaceFileLinksForHarden(node as never, new Set(['a#b.md', 'a%23b.md']))

  assert.equal(node.properties.dataYachiyoWorkspaceFileReference, 'a#b.md')
})

test('a destination that resolves to neither reading stays an ordinary link', () => {
  assert.equal(linksTo('a%23b.md', ['something-else.md']), false)
})

test('the reference cap counts what is sent and keeps the preferred reading', () => {
  // Two candidates per link, so a cap of 3 must not cut a link's preferred
  // reading in favour of another link's fallback.
  const markdown = '[a](a%23b.md) [b](c%23d.md)'

  assert.deepEqual(extractMarkdownFileReferences(markdown, 3), ['a#b.md', 'a%23b.md', 'c#d.md'])
  assert.deepEqual(extractMarkdownFileReferences(markdown, 1), ['a#b.md'])
})
