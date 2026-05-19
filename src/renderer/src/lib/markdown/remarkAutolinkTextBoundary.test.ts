import assert from 'node:assert/strict'
import test from 'node:test'
import type { Link, Paragraph, Root, Text } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

import { remarkAutolinkTextBoundary } from './remarkAutolinkTextBoundary.ts'

async function parseMarkdown(markdown: string): Promise<Root> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown)
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkAutolinkTextBoundary)
    .run(tree, markdown) as Promise<Root>
}

test('remarkAutolinkTextBoundary stops literal autolinks before adjacent Chinese text', async () => {
  const tree = await parseMarkdown('https://example.com/path中文内容')
  const paragraph = tree.children[0] as Paragraph
  const link = paragraph.children[0] as Link
  const label = link.children[0] as Text
  const trailingText = paragraph.children[1] as Text

  assert.equal(link.type, 'link')
  assert.equal(link.url, 'https://example.com/path')
  assert.equal(label.value, 'https://example.com/path')
  assert.equal(trailingText.type, 'text')
  assert.equal(trailingText.value, '中文内容')
})

test('remarkAutolinkTextBoundary leaves explicit markdown links unchanged', async () => {
  const tree = await parseMarkdown('[example](https://example.com/path中文内容)')
  const paragraph = tree.children[0] as Paragraph
  const link = paragraph.children[0] as Link
  const label = link.children[0] as Text

  assert.equal(link.type, 'link')
  assert.equal(link.url, 'https://example.com/path中文内容')
  assert.equal(label.value, 'example')
})
