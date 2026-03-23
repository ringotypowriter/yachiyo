import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    await writeFile(join(workspacePath, 'src', 'app.ts'), 'export const app = true\n', 'utf8')
    await writeFile(
      join(workspacePath, 'src', 'nested', 'tiny.ts'),
      ['export const tiny = true', 'export const answer = 42'].join('\n'),
      'utf8'
    )
    await writeFile(join(workspacePath, 'README.md'), '# Demo\n', 'utf8')

    await fn({
      workspacePath,
      searchService: createSearchService({
        capabilities: {
          grep: { preferred: 'typescript', backends: {} },
          fileDiscovery: { preferred: 'typescript', backends: {} }
        }
      })
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

test('searchWorkspaceFileMentionCandidates returns default workspace files for an empty query', async () => {
  await withWorkspace(async ({ searchService, workspacePath }) => {
    const results = await searchWorkspaceFileMentionCandidates({
      query: '',
      workspacePath,
      searchService
    })

    assert.ok(results.length > 0)
    assert.equal(results.includes('README.md'), true)
    assert.equal(results.includes('src'), false)
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
      searchService: createSearchService({
        capabilities: {
          grep: { preferred: 'typescript', backends: {} },
          fileDiscovery: { preferred: 'typescript', backends: {} }
        }
      })
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
