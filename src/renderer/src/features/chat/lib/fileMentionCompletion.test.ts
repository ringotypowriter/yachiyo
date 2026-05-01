import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFileMentionCompletionCommands,
  paginateFileMentionMatches
} from './fileMentionCompletion.ts'

test('file mention completions keep backend-ranked fuzzy matches with spaced queries', () => {
  const commands = buildFileMentionCompletionCommands({
    matches: [
      { path: 'src/features/chat/components/Composer.tsx' },
      { path: 'src/features/chat/components/Compressor.ts' }
    ]
  })

  assert.deepEqual(
    commands.map((command) => command.label),
    ['src/features/chat/components/Composer.tsx', 'src/features/chat/components/Compressor.ts']
  )
})

test('file mention completions preserve ignored workspace candidates', () => {
  const commands = buildFileMentionCompletionCommands({
    matches: [{ path: 'dist/generated.js', includeIgnored: true }]
  })

  assert.deepEqual(commands, [
    {
      key: 'file:!dist/generated.js',
      label: '!dist/generated.js',
      description: 'Ignored workspace path',
      type: 'file'
    }
  ])
})

test('file mention pagination keeps JotDown visible instead of using it as the sentinel', () => {
  const matches = [
    ...Array.from({ length: 25 }, (_, index) => ({ path: `notes/jot-${index}.md` })),
    { path: 'JotDown', kind: 'jotdown' as const }
  ]

  const page = paginateFileMentionMatches({ matches, visibleLimit: 24 })

  assert.equal(page.hasMore, true)
  assert.equal(page.matches[0]?.path, 'JotDown')
  assert.equal(page.matches.length, 24)
  assert.equal(
    page.matches.some((match) => match.path === 'notes/jot-24.md'),
    false
  )
})
