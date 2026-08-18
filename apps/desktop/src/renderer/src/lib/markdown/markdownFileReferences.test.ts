import assert from 'node:assert/strict'
import test from 'node:test'

import { extractMarkdownFileReferences } from './markdownFileReferences.ts'

test('extractMarkdownFileReferences collects workspace artifact links', () => {
  const markdown = [
    '已整理成 Markdown 文件：',
    '',
    '[下载 pi-agent-compact-prompt.md](<pi-agent-compact-prompt.md>)',
    '[打开说明](docs/guide.md)',
    '[重复](docs/guide.md)'
  ].join('\n')

  assert.deepEqual(extractMarkdownFileReferences(markdown), [
    'pi-agent-compact-prompt.md',
    'docs/guide.md'
  ])
})

test('extractMarkdownFileReferences ignores non-file and non-link markdown', () => {
  const markdown = [
    '[网页](https://example.com/report.md)',
    '[文件协议](file:///tmp/report.md)',
    '![图片](diagram.png)',
    '`[伪链接](notes.md)`',
    '```md',
    '[代码块里的链接](draft.md)',
    '```'
  ].join('\n')

  assert.deepEqual(extractMarkdownFileReferences(markdown), [])
})
