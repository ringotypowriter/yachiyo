import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidElement, type ReactNode } from 'react'

import { linkifyText } from './linkifyText.tsx'

function simplify(nodes: ReactNode[]): Array<string | { url: string }> {
  return nodes.map((node) =>
    isValidElement(node) ? { url: (node.props as { url: string }).url } : String(node)
  )
}

test('linkifyText stops autolinks before adjacent Chinese text', () => {
  assert.deepEqual(simplify(linkifyText('看 https://example.com/path中文内容')), [
    '看 ',
    { url: 'https://example.com/path' },
    '中文内容'
  ])
})

test('linkifyText still keeps normal URL punctuation inside the link', () => {
  assert.deepEqual(simplify(linkifyText('open https://example.com/a?x=1&y=2#top now')), [
    'open ',
    { url: 'https://example.com/a?x=1&y=2#top' },
    ' now'
  ])
})
