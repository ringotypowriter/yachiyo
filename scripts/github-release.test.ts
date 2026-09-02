import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { renderReleaseNotes } from './github-release.mjs'

const helper = resolve('scripts/github-release.mjs')

function commit(repository: string, subject: string, body = ''): string {
  const args = ['commit', '--quiet', '--allow-empty', '-m', subject]
  if (body) args.push('-m', body)
  execFileSync('git', args, { cwd: repository })
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8'
  }).trim()
}

function createRepository(): {
  repository: string
  refactorHash: string
  fixHash: string
} {
  const repository = mkdtempSync(join(tmpdir(), 'yachiyo-release-notes-'))
  execFileSync('git', ['init', '--quiet'], { cwd: repository })
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: repository })
  execFileSync('git', ['config', 'user.email', 'release-test@example.com'], { cwd: repository })

  commit(repository, 'feat: previous release')
  execFileSync('git', ['tag', 'v1.0.0'], { cwd: repository })
  const refactorHash = commit(
    repository,
    'refactor(core): reorganize runtime',
    'fix: this body text must not create a bug-fix entry'
  )
  const fixHash = commit(
    repository,
    'fix: repair updater',
    'fix: body details must not duplicate it'
  )
  commit(repository, 'docs: explain updater', 'fix: body-only matches must be ignored')
  execFileSync('git', ['tag', 'v1.1.0'], { cwd: repository })

  return { repository, refactorHash, fixHash }
}

function createGhStub(directory: string): string {
  const executable = join(directory, 'gh')
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "release view" ]; then
  exit "\${GH_VIEW_EXIT:-1}"
fi
cat > "$GH_NOTES"
`
  )
  chmodSync(executable, 0o755)
  return executable
}

test('release notes classify only conventional commit subject prefixes', () => {
  const notes = renderReleaseNotes({
    commits: [
      {
        hash: '0a1b2c3',
        subject: 'feat(ui)!: add release progress',
        body: 'fix: body text is not a bug-fix subject'
      },
      {
        hash: 'a1b2c3d',
        subject: 'refactor(core): reorganize runtime',
        body: 'fix: this body must not create another category'
      },
      {
        hash: 'd4e5f6a',
        subject: 'fix: repair updater',
        body: 'fix: body details must not duplicate it'
      },
      { hash: 'b7c8d9e', subject: 'docs: explain updater', body: 'fix: body-only match' },
      { hash: 'f0a1b2c', subject: 'fixture: unrelated prefix', body: '' }
    ],
    previousTag: 'v1.0.0',
    tag: 'v1.1.0',
    repository: 'ringotypowriter/yachiyo'
  })

  assert.equal(
    notes,
    '## Features\n- add release progress (0a1b2c3)\n\n## Bug Fixes\n- repair updater (d4e5f6a)\n\n## Refactors\n- reorganize runtime (a1b2c3d)\n'
  )
})

test('creates a missing tagged release with generated subject-only notes', () => {
  const { repository, refactorHash, fixHash } = createRepository()
  const bin = mkdtempSync(join(tmpdir(), 'yachiyo-gh-stub-'))
  createGhStub(bin)
  const log = join(bin, 'commands.log')
  const notes = join(bin, 'notes.md')

  const result = spawnSync(
    process.execPath,
    [helper, '--tag', 'v1.1.0', '--repository', 'ringotypowriter/yachiyo'],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GH_LOG: log,
        GH_NOTES: notes,
        GH_VIEW_EXIT: '1'
      }
    }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(log, 'utf8'),
    'release view v1.1.0\nrelease create v1.1.0 --verify-tag --title v1.1.0 --notes-file -\n'
  )
  assert.equal(
    readFileSync(notes, 'utf8'),
    `## Bug Fixes\n- repair updater (${fixHash})\n\n## Refactors\n- reorganize runtime (${refactorHash})\n`
  )
})

test('edits an existing release on rerun instead of trying to create it again', () => {
  const { repository } = createRepository()
  const bin = mkdtempSync(join(tmpdir(), 'yachiyo-gh-stub-'))
  createGhStub(bin)
  const log = join(bin, 'commands.log')
  const notes = join(bin, 'notes.md')

  const result = spawnSync(
    process.execPath,
    [helper, '--tag', 'v1.1.0', '--repository', 'ringotypowriter/yachiyo'],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GH_LOG: log,
        GH_NOTES: notes,
        GH_VIEW_EXIT: '0'
      }
    }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(log, 'utf8'),
    'release view v1.1.0\nrelease edit v1.1.0 --title v1.1.0 --notes-file -\n'
  )
})

test('creates a prerelease against HEAD when the nightly tag is not local', () => {
  const { repository } = createRepository()
  const bin = mkdtempSync(join(tmpdir(), 'yachiyo-gh-stub-'))
  createGhStub(bin)
  const log = join(bin, 'commands.log')
  const notes = join(bin, 'notes.md')

  const result = spawnSync(
    process.execPath,
    [
      helper,
      '--tag',
      'v1.2.0-beta.202607180000',
      '--target',
      'HEAD',
      '--prerelease',
      '--repository',
      'ringotypowriter/yachiyo'
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GH_LOG: log,
        GH_NOTES: notes,
        GH_VIEW_EXIT: '1'
      }
    }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(log, 'utf8'),
    'release view v1.2.0-beta.202607180000\nrelease create v1.2.0-beta.202607180000 --target HEAD --prerelease --title v1.2.0-beta.202607180000 --notes-file -\n'
  )
})
