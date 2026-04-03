import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createSearchService } from '../services/search/searchService.ts'
import {
  parseFileMentions,
  resolveFileMentionsForUserQuery,
  searchWorkspaceFileMentionCandidates
} from './fileMentions.ts'

async function withWorkspace(
  fn: (input: {
    searchService: ReturnType<typeof createSearchService>
    workspacePath: string
  }) => Promise<void>
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-file-mentions-'))

  try {
    await mkdir(join(workspacePath, 'src', 'nested'), { recursive: true })
    await mkdir(join(workspacePath, 'src', 'components'), { recursive: true })
    await mkdir(join(workspacePath, 'src', 'components', 'nested'), { recursive: true })
    await mkdir(join(workspacePath, 'packages', 'app', 'dist'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'app.ts'), 'export const app = true\n', 'utf8')
    await writeFile(
      join(workspacePath, 'src', 'nested', 'tiny.ts'),
      ['export const tiny = true', 'export const answer = 42'].join('\n'),
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', 'Composer.tsx'),
      'export function Composer() { return null }\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', 'Compressor.ts'),
      'export const compressor = true\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', 'nested', 'deep.ts'),
      'export const deep = true\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', '.secret.ts'),
      'export const secret = true\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'packages', 'app', 'dist', 'ignored.js'),
      'console.log("ignored")\n',
      'utf8'
    )
    await writeFile(join(workspacePath, 'secret.txt'), 'top secret\n', 'utf8')
    await writeFile(join(workspacePath, '.gitignore'), 'secret.txt\n', 'utf8')
    await writeFile(join(workspacePath, 'packages', 'app', '.gitignore'), 'dist/\n', 'utf8')
    await writeFile(join(workspacePath, 'README.md'), '# Demo\n', 'utf8')
    await mkdir(join(workspacePath, 'docs', 'my notes'), { recursive: true })
    await writeFile(
      join(workspacePath, 'docs', 'my notes', 'design doc.md'),
      '# Design Doc\n',
      'utf8'
    )

    await fn({
      workspacePath,
      searchService: createSearchService({})
    })
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

test('parseFileMentions collects unique workspace-style @file tokens and skips @skills', () => {
  assert.deepEqual(parseFileMentions('Check @src/app.ts and @README.md with @skills:refactor'), [
    { raw: '@src/app.ts', query: 'src/app.ts' },
    { raw: '@README.md', query: 'README.md' }
  ])
})

test('parseFileMentions strips trailing sentence punctuation from @file tokens', () => {
  assert.deepEqual(parseFileMentions('Check @src/nested/tiny.ts. Then read @README.md,'), [
    { raw: '@src/nested/tiny.ts', query: 'src/nested/tiny.ts' },
    { raw: '@README.md', query: 'README.md' }
  ])
})

test('parseFileMentions supports quoted paths with spaces', () => {
  assert.deepEqual(parseFileMentions('Check @"docs/my notes/design doc.md" and @src/app.ts'), [
    { raw: '@"docs/my notes/design doc.md"', query: 'docs/my notes/design doc.md' },
    { raw: '@src/app.ts', query: 'src/app.ts' }
  ])
})

test('parseFileMentions supports @! with quoted paths', () => {
  assert.deepEqual(parseFileMentions('Read @!"secret path/file.txt"'), [
    { raw: '@!"secret path/file.txt"', query: 'secret path/file.txt', includeIgnored: true }
  ])
})

test('parseFileMentions keeps @! mentions and marks them to include ignored files', () => {
  assert.deepEqual(parseFileMentions('Check @!secret.txt and @src/app.ts'), [
    { raw: '@!secret.txt', query: 'secret.txt', includeIgnored: true },
    { raw: '@src/app.ts', query: 'src/app.ts' }
  ])
})

test('searchWorkspaceFileMentionCandidates finds workspace-relative matches with glob fallback', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'tiny.ts',
      workspacePath,
      searchService
    })

    assert.deepEqual(results, ['src/nested/tiny.ts'])
  })
})

test('searchWorkspaceFileMentionCandidates supports fuzzy basename matches', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'cmpsr.tsx',
      workspacePath,
      searchService
    })

    assert.deepEqual(results, ['src/components/Composer.tsx'])
  })
})

test('searchWorkspaceFileMentionCandidates supports fuzzy path-segment matches', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'src/cmp/cmpsr.tsx',
      workspacePath,
      searchService
    })

    assert.deepEqual(results, ['src/components/Composer.tsx'])
  })
})

test('searchWorkspaceFileMentionCandidates ranks the closest fuzzy match first', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'cmpsr',
      workspacePath,
      searchService
    })

    assert.equal(results[0], 'src/components/Composer.tsx')
    assert.equal(results.includes('src/components/Compressor.ts'), true)
  })
})

test('searchWorkspaceFileMentionCandidates prefers aligned path matches for path-like queries', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    await mkdir(join(workspacePath, 'docs'), { recursive: true })
    await mkdir(join(workspacePath, 'node_modules', 'jackspeak'), { recursive: true })
    await mkdir(join(workspacePath, 'node_modules', 'safe-compare'), { recursive: true })
    await writeFile(join(workspacePath, 'docs', 'ACP_CAPABILITY_GAP.md'), '# Gap\n', 'utf8')
    await writeFile(
      join(workspacePath, 'node_modules', 'jackspeak', 'package.json'),
      '{}\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'node_modules', 'safe-compare', 'index.js'),
      'export {}\n',
      'utf8'
    )

    const results = await searchWorkspaceFileMentionCandidates({
      query: 'doc/ACP',
      workspacePath,
      searchService,
      includeIgnored: true
    })

    assert.equal(results[0], 'docs/ACP_CAPABILITY_GAP.md')
  })
})

test('searchWorkspaceFileMentionCandidates scopes ignored path queries to the matching directory', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    await mkdir(join(workspacePath, 'docs'), { recursive: true })
    await mkdir(join(workspacePath, 'node_modules', 'pkg', 'docs'), { recursive: true })
    await writeFile(join(workspacePath, 'docs', 'ACP_CAPABILITY_GAP.md'), '# Gap\n', 'utf8')
    await writeFile(
      join(workspacePath, 'node_modules', 'pkg', 'docs', 'README.md'),
      '# Package\n',
      'utf8'
    )

    const results = await searchWorkspaceFileMentionCandidates({
      query: 'docs/',
      workspacePath,
      searchService,
      includeIgnored: true
    })

    assert.equal(results.includes('docs/ACP_CAPABILITY_GAP.md'), true)
    assert.equal(
      results.some((path) => path.includes('node_modules/pkg/docs/README.md')),
      false
    )
  })
})

test('searchWorkspaceFileMentionCandidates keeps visible scoped path hits under their parent directory', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'src/components/',
      workspacePath,
      searchService
    })

    assert.equal(results.includes('src/components/Composer.tsx'), true)
    assert.equal(results.includes('src/components/Compressor.ts'), true)
  })
})

test('searchWorkspaceFileMentionCandidates can return folders', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'src/components',
      workspacePath,
      searchService
    })

    assert.equal(results[0], 'src/components')
  })
})

test('searchWorkspaceFileMentionCandidates can fuzzy-match folders without an exact path hit', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'src/cmp',
      workspacePath,
      searchService
    })

    assert.equal(results[0], 'src/components')
  })
})

test('searchWorkspaceFileMentionCandidates returns default workspace files for an empty query', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: '',
      workspacePath,
      searchService
    })

    assert.ok(results.length > 0)
    assert.equal(results.includes('README.md'), true)
    assert.equal(results.includes('secret.txt'), false)
    assert.equal(results.includes('src'), false)
  })
})

test('searchWorkspaceFileMentionCandidates respects .gitignore by default', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'secret.txt',
      workspacePath,
      searchService
    })

    assert.deepEqual(results, [])
  })
})

test('searchWorkspaceFileMentionCandidates can include ignored files when requested', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'secret.txt',
      workspacePath,
      searchService,
      includeIgnored: true
    })

    assert.deepEqual(results, ['secret.txt'])
  })
})

test('searchWorkspaceFileMentionCandidates respects nested .gitignore files', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'ignored.js',
      workspacePath,
      searchService
    })

    assert.deepEqual(results, [])
  })
})

test('searchWorkspaceFileMentionCandidates can bypass nested .gitignore files with @!', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: 'ignored.js',
      workspacePath,
      searchService,
      includeIgnored: true
    })

    assert.deepEqual(results, ['packages/app/dist/ignored.js'])
  })
})

test('searchWorkspaceFileMentionCandidates reloads .gitignore rules between searches', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    await writeFile(join(workspacePath, '.gitignore'), '', 'utf8')

    const visibleBeforeIgnore = await searchWorkspaceFileMentionCandidates({
      query: 'secret.txt',
      workspacePath,
      searchService
    })
    assert.deepEqual(visibleBeforeIgnore, ['secret.txt'])

    await writeFile(join(workspacePath, '.gitignore'), 'secret.txt\n', 'utf8')

    const hiddenAfterIgnore = await searchWorkspaceFileMentionCandidates({
      query: 'secret.txt',
      workspacePath,
      searchService
    })
    assert.deepEqual(hiddenAfterIgnore, [])

    await writeFile(join(workspacePath, '.gitignore'), '', 'utf8')

    const visibleAfterUnignore = await searchWorkspaceFileMentionCandidates({
      query: 'secret.txt',
      workspacePath,
      searchService
    })
    assert.deepEqual(visibleAfterUnignore, ['secret.txt'])
  })
})

test('resolveFileMentionsForUserQuery resolves quoted paths with spaces', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const result = await resolveFileMentionsForUserQuery({
      content: 'Read @"docs/my notes/design doc.md"',
      workspacePath,
      searchService
    })

    assert.equal(result.mentions[0]?.kind, 'resolved')
    assert.equal(result.inlinedPath, 'docs/my notes/design doc.md')
    assert.match(result.augmentedUserQuery, /# Design Doc/)
  })
})

test('resolveFileMentionsForUserQuery inlines a single short file ahead of the user query', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const result = await resolveFileMentionsForUserQuery({
      content: 'Please inspect @src/nested/tiny.ts',
      workspacePath,
      searchService
    })

    assert.equal(result.mentions[0]?.kind, 'resolved')
    assert.equal(result.inlinedPath, 'src/nested/tiny.ts')
    assert.match(result.augmentedUserQuery, /<referenced_file path="src\/nested\/tiny\.ts">/)
    assert.match(result.augmentedUserQuery, /export const tiny = true/)
    assert.match(result.augmentedUserQuery, /Please inspect @src\/nested\/tiny\.ts$/)
  })
})

test('resolveFileMentionsForUserQuery inlines a shallow directory listing for folder mentions', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const result = await resolveFileMentionsForUserQuery({
      content: 'Inspect @src/components before editing.',
      workspacePath,
      searchService
    })

    assert.equal(result.mentions[0]?.kind, 'resolved')
    assert.equal(result.mentions[0]?.resolvedKind, 'directory')
    assert.equal(result.inlinedPath, 'src/components')
    assert.match(result.augmentedUserQuery, /<referenced_directory path="src\/components">/)
    assert.match(result.augmentedUserQuery, /Composer\.tsx/)
    assert.match(result.augmentedUserQuery, /Compressor\.ts/)
    assert.match(result.augmentedUserQuery, /nested\//)
    assert.doesNotMatch(result.augmentedUserQuery, /deep\.ts/)
    assert.doesNotMatch(result.augmentedUserQuery, /\.secret\.ts/)
    assert.match(result.augmentedUserQuery, /Inspect @src\/components before editing\.$/)
  })
})

test('resolveFileMentionsForUserQuery shows hidden directory entries only for @! folder mentions', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const hiddenResult = await resolveFileMentionsForUserQuery({
      content: 'Inspect @src/components',
      workspacePath,
      searchService
    })
    const bypassResult = await resolveFileMentionsForUserQuery({
      content: 'Inspect @!src/components',
      workspacePath,
      searchService
    })

    assert.doesNotMatch(hiddenResult.augmentedUserQuery, /\.secret\.ts/)
    assert.match(bypassResult.augmentedUserQuery, /\.secret\.ts/)
  })
})

test('resolveFileMentionsForUserQuery caps large directory listings before inlining them', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const crowdedPath = join(workspacePath, 'src', 'crowded')
    await mkdir(crowdedPath, { recursive: true })

    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        writeFile(
          join(crowdedPath, `item-${String(index).padStart(3, '0')}.ts`),
          'export {}\n',
          'utf8'
        )
      )
    )

    const result = await resolveFileMentionsForUserQuery({
      content: 'Inspect @src/crowded',
      workspacePath,
      searchService
    })

    assert.equal(result.mentions[0]?.resolvedKind, 'directory')
    assert.match(result.augmentedUserQuery, /<referenced_directory path="src\/crowded">/)
    assert.match(result.augmentedUserQuery, /\.\.\. \(\d+ more entries\)/)
    assert.match(result.augmentedUserQuery, /item-000\.ts/)
    assert.doesNotMatch(result.augmentedUserQuery, /item-119\.ts/)

    const renderedLines = result.augmentedUserQuery
      .split('\n')
      .filter((line) => line.startsWith('item-') || line.startsWith('... ('))
    assert.ok(renderedLines.length <= 81)

    const allChildren = await readdir(crowdedPath)
    assert.equal(allChildren.length, 120)
  })
})

test('resolveFileMentionsForUserQuery rejects mentions that resolve outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-file-mentions-outside-'))
  const workspacePath = join(root, 'workspace')
  const outsideFilePath = join(root, 'outside-secret.txt')

  try {
    await mkdir(workspacePath, { recursive: true })
    await writeFile(outsideFilePath, 'top secret\n', 'utf8')

    const result = await resolveFileMentionsForUserQuery({
      content: 'Do not read @../outside-secret.txt.',
      workspacePath,
      searchService: createSearchService({})
    })

    assert.equal(result.mentions[0]?.kind, 'missing')
    assert.equal(result.inlinedPath, undefined)
    assert.doesNotMatch(result.augmentedUserQuery, /top secret/)
    assert.match(result.augmentedUserQuery, /@\.\.\/outside-secret\.txt -> unresolved/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveFileMentionsForUserQuery records ambiguous and missing mentions without changing visible text', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    await writeFile(join(workspacePath, 'tiny-helper.ts'), 'export const root = true\n', 'utf8')

    const result = await resolveFileMentionsForUserQuery({
      content: 'Compare @tiny and @missing.ts',
      workspacePath,
      searchService
    })

    assert.equal(result.mentions[0]?.kind, 'ambiguous')
    assert.equal(result.mentions[1]?.kind, 'missing')
    assert.match(result.augmentedUserQuery, /@tiny -> ambiguous:/)
    assert.match(result.augmentedUserQuery, /@missing\.ts -> unresolved/)
    assert.match(result.augmentedUserQuery, /Compare @tiny and @missing\.ts$/)
  })
})

test('resolveFileMentionsForUserQuery hides ignored files unless @! is used', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const hiddenResult = await resolveFileMentionsForUserQuery({
      content: 'Inspect @secret.txt',
      workspacePath,
      searchService
    })
    const bypassResult = await resolveFileMentionsForUserQuery({
      content: 'Inspect @!secret.txt',
      workspacePath,
      searchService
    })

    assert.equal(hiddenResult.mentions[0]?.kind, 'missing')
    assert.match(hiddenResult.augmentedUserQuery, /@secret\.txt -> unresolved/)
    assert.equal(bypassResult.mentions[0]?.kind, 'resolved')
    assert.equal(bypassResult.inlinedPath, 'secret.txt')
    assert.match(bypassResult.augmentedUserQuery, /@!secret\.txt -> secret\.txt/)
    assert.match(bypassResult.augmentedUserQuery, /top secret/)
  })
})

test('resolveFileMentionsForUserQuery respects nested .gitignore files unless @! is used', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const hiddenResult = await resolveFileMentionsForUserQuery({
      content: 'Inspect @packages/app/dist/ignored.js',
      workspacePath,
      searchService
    })
    const bypassResult = await resolveFileMentionsForUserQuery({
      content: 'Inspect @!packages/app/dist/ignored.js',
      workspacePath,
      searchService
    })

    assert.equal(hiddenResult.mentions[0]?.kind, 'missing')
    assert.equal(bypassResult.mentions[0]?.kind, 'resolved')
    assert.equal(bypassResult.inlinedPath, 'packages/app/dist/ignored.js')
  })
})
