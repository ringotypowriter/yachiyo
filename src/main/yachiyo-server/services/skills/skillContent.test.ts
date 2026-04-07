import assert from 'node:assert/strict'
import test from 'node:test'

import { rewriteRelativeMarkdownLinks } from './skillContent.ts'

test('rewriteRelativeMarkdownLinks leaves external urls unchanged', () => {
  const content = `[a](http://example.com) [b](https://example.com) [c](mailto:a@b.com) [d](#anchor) [e](ftp://x) [f](data:text/plain,foo)`
  assert.equal(rewriteRelativeMarkdownLinks(content, '/base'), content)
})

test('rewriteRelativeMarkdownLinks leaves absolute paths unchanged', () => {
  const content = `[a](/absolute/path.md)`
  assert.equal(rewriteRelativeMarkdownLinks(content, '/base'), content)
})

test('rewriteRelativeMarkdownLinks resolves relative markdown links', () => {
  const content = `Read [guide](references/guide.md) for more.`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, '/Users/test/skills/my-skill'),
    `Read [guide](/Users/test/skills/my-skill/references/guide.md) for more.`
  )
})

test('rewriteRelativeMarkdownLinks resolves relative image references', () => {
  const content = `![diagram](assets/diagram.png)`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, '/Users/test/skills/my-skill'),
    `![diagram](/Users/test/skills/my-skill/assets/diagram.png)`
  )
})

test('rewriteRelativeMarkdownLinks handles parent-directory references', () => {
  const content = `[up](../shared.md)`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, '/Users/test/skills/my-skill'),
    `[up](/Users/test/skills/shared.md)`
  )
})

test('rewriteRelativeMarkdownLinks handles angle-bracket and quoted urls', () => {
  const content = `[a](<my file.md>) [b]("quoted.md") [c]('single.md')`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, '/base'),
    `[a](/base/my file.md) [b](/base/quoted.md) [c](/base/single.md)`
  )
})
