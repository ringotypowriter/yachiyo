import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import { rewriteRelativeMarkdownLinks } from './skillContent.ts'

const fixturePath = process.platform === 'win32' ? win32 : posix
const fixtureRoot = process.platform === 'win32' ? 'C:\\' : '/'
const baseDirectory = fixturePath.join(fixtureRoot, 'base')
const skillsDirectory = fixturePath.join(fixtureRoot, 'Users', 'test', 'skills')
const skillDirectory = fixturePath.join(skillsDirectory, 'my-skill')
const markdownPath = (path: string): string => path.replace(/\\/gu, '/')

test('rewriteRelativeMarkdownLinks leaves external urls unchanged', () => {
  const content = `[a](http://example.com) [b](https://example.com) [c](mailto:a@b.com) [d](#anchor) [e](ftp://x) [f](data:text/plain,foo)`
  assert.equal(rewriteRelativeMarkdownLinks(content, baseDirectory), content)
})

test('rewriteRelativeMarkdownLinks leaves absolute paths unchanged', () => {
  const content = `[a](/absolute/path.md)`
  assert.equal(rewriteRelativeMarkdownLinks(content, baseDirectory), content)
})

test('rewriteRelativeMarkdownLinks resolves relative markdown links', () => {
  const content = `Read [guide](references/guide.md) for more.`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, skillDirectory),
    `Read [guide](${markdownPath(fixturePath.join(skillDirectory, 'references', 'guide.md'))}) for more.`
  )
})

test('rewriteRelativeMarkdownLinks resolves relative image references', () => {
  const content = `![diagram](assets/diagram.png)`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, skillDirectory),
    `![diagram](${markdownPath(fixturePath.join(skillDirectory, 'assets', 'diagram.png'))})`
  )
})

test('rewriteRelativeMarkdownLinks handles parent-directory references', () => {
  const content = `[up](../shared.md)`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, skillDirectory),
    `[up](${markdownPath(fixturePath.join(skillsDirectory, 'shared.md'))})`
  )
})

test('rewriteRelativeMarkdownLinks handles angle-bracket and quoted urls', () => {
  const content = `[a](<my file.md>) [b]("quoted.md") [c]('single.md')`
  assert.equal(
    rewriteRelativeMarkdownLinks(content, baseDirectory),
    `[a](${markdownPath(fixturePath.join(baseDirectory, 'my file.md'))}) [b](${markdownPath(fixturePath.join(baseDirectory, 'quoted.md'))}) [c](${markdownPath(fixturePath.join(baseDirectory, 'single.md'))})`
  )
})
