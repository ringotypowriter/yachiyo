import assert from 'node:assert/strict'
import test from 'node:test'

import { extractInlineCodeFileReferences } from './inlineCodeFileReferences.ts'

test('extractInlineCodeFileReferences collects path-like inline code only', () => {
  const content = [
    '方案写好了，放在 `graphrag/TECH-KG-REDESIGN.md`。',
    'Also see `README.md:12` and `/workspace/project/src/App.tsx`.',
    'Skip `https://example.com`, `npm test`, and `gpt-5.1-codex`.',
    '```ts',
    'const ignored = `src/hidden.ts`',
    '```'
  ].join('\n')

  assert.deepEqual(extractInlineCodeFileReferences(content), [
    'graphrag/TECH-KG-REDESIGN.md',
    'README.md:12',
    '/workspace/project/src/App.tsx'
  ])
})

test('extractInlineCodeFileReferences preserves order while deduplicating references', () => {
  const content =
    'Open `docs/my notes/design doc.md`, `./package.json`, `docs/my notes/design doc.md`, and `src/main.tsx:8:2`.'

  assert.deepEqual(extractInlineCodeFileReferences(content), [
    'docs/my notes/design doc.md',
    './package.json',
    'src/main.tsx:8:2'
  ])
})

test('extractInlineCodeFileReferences only collects allowed file kinds', () => {
  const content = [
    'Keep `assets/logo.png`, `docs/report.pdf`, `src/server.ts`, and `.gitignore`.',
    'Skip `README`, `archive.zip`, `video.mp4`, `payload.bin`, `font.woff2`, and `packages/coding-agent`.'
  ].join('\n')

  assert.deepEqual(extractInlineCodeFileReferences(content), [
    'assets/logo.png',
    'docs/report.pdf',
    'src/server.ts',
    '.gitignore'
  ])
})

test('extractInlineCodeFileReferences collects office and related document suffixes', () => {
  const content = [
    'Docs: `docs/spec.docx`, `docs/spec.doc`, `sheets/budget.xlsx`, `sheets/budget.xls`, and `exports/table.csv`.',
    'Slides: `slides/roadmap.pptx`, `slides/roadmap.ppt`, `open/report.odt`, `open/data.ods`, `open/deck.odp`.',
    'iWork: `apple/report.pages`, `apple/data.numbers`, and `apple/deck.key`.'
  ].join('\n')

  assert.deepEqual(extractInlineCodeFileReferences(content), [
    'docs/spec.docx',
    'docs/spec.doc',
    'sheets/budget.xlsx',
    'sheets/budget.xls',
    'exports/table.csv',
    'slides/roadmap.pptx',
    'slides/roadmap.ppt',
    'open/report.odt',
    'open/data.ods',
    'open/deck.odp',
    'apple/report.pages',
    'apple/data.numbers',
    'apple/deck.key'
  ])
})
