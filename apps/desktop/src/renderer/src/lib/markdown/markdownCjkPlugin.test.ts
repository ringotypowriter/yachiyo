import assert from 'node:assert/strict'
import test from 'node:test'
import type { Delete, Link, Paragraph, Root, Strong, Text } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

import { markdownCjkPlugin } from './markdownCjkPlugin.ts'

// Mirrors how Streamdown assembles remark plugins around the cjk slot:
// [...remarkPluginsBefore, remarkGfm, ...remarkPluginsAfter]
function parseMarkdown(markdown: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(markdownCjkPlugin.remarkPluginsBefore)
    .use(remarkGfm)
    .use(markdownCjkPlugin.remarkPluginsAfter)
  return processor.runSync(processor.parse(markdown), markdown) as Root
}

test('emphasis closes across full-width punctuation followed by CJK text', () => {
  const tree = parseMarkdown('**测试一步：**用最新版本验证')
  const paragraph = tree.children[0] as Paragraph
  const strong = paragraph.children[0] as Strong
  const label = strong.children[0] as Text
  const trailing = paragraph.children[1] as Text

  assert.equal(strong.type, 'strong')
  assert.equal(label.value, '测试一步：')
  assert.equal(trailing.value, '用最新版本验证')
})

test('strikethrough closes across full-width punctuation followed by CJK text', () => {
  const tree = parseMarkdown('~~旧方案：~~直接改用新流程')
  const paragraph = tree.children[0] as Paragraph
  const del = paragraph.children[0] as Delete
  const label = del.children[0] as Text

  assert.equal(del.type, 'delete')
  assert.equal(label.value, '旧方案：')
})

test('autolink boundary splitting still applies in the combined pipeline', () => {
  const tree = parseMarkdown('https://example.com/path中文内容')
  const paragraph = tree.children[0] as Paragraph
  const link = paragraph.children[0] as Link
  const trailing = paragraph.children[1] as Text

  assert.equal(link.type, 'link')
  assert.equal(link.url, 'https://example.com/path')
  assert.equal(trailing.value, '中文内容')
})
