import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { resolveExistingFileReferences } from './inlineCodeFileReferences.ts'

test('resolveExistingFileReferences resolves exact relative and absolute files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-inline-file-links-'))
  const workspacePath = join(root, 'workspace')
  const outsidePath = join(root, 'outside.md')

  try {
    await mkdir(join(workspacePath, 'docs'), { recursive: true })
    await mkdir(join(workspacePath, 'src', 'components'), { recursive: true })
    await writeFile(join(workspacePath, 'docs', 'architecture.md'), '# Plan\n', 'utf8')
    await writeFile(join(workspacePath, 'README.md'), '# Readme\n', 'utf8')
    await writeFile(join(workspacePath, 'src', 'App.tsx'), 'export function App() {}\n', 'utf8')
    await writeFile(outsidePath, '# Outside\n', 'utf8')

    const resolved = await resolveExistingFileReferences({
      workspacePath,
      references: [
        'docs/architecture.md',
        'README.md:12',
        join(workspacePath, 'src', 'App.tsx'),
        outsidePath,
        'src/components',
        'missing.md',
        '../outside.md'
      ]
    })

    assert.deepEqual(resolved, [
      {
        reference: 'docs/architecture.md',
        path: join(workspacePath, 'docs', 'architecture.md')
      },
      {
        reference: 'README.md:12',
        path: join(workspacePath, 'README.md')
      },
      {
        reference: join(workspacePath, 'src', 'App.tsx'),
        path: join(workspacePath, 'src', 'App.tsx')
      },
      {
        reference: outsidePath,
        path: outsidePath
      }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveExistingFileReferences resolves absolute files without a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-inline-file-links-'))
  const absolutePath = join(root, 'walkthrough.md')

  try {
    await writeFile(absolutePath, '# Walkthrough\n', 'utf8')

    const resolved = await resolveExistingFileReferences({
      references: [absolutePath, 'relative.md']
    })

    assert.deepEqual(resolved, [
      {
        reference: absolutePath,
        path: absolutePath
      }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveExistingFileReferences resolves explicit folder references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-inline-file-links-'))
  const workspacePath = join(root, 'workspace')
  const resultsPath = join(workspacePath, 'results')
  const archivePath = join(workspacePath, 'archive', 'previous-results')
  const outsidePath = join(root, 'outside')

  try {
    await mkdir(resultsPath, { recursive: true })
    await mkdir(archivePath, { recursive: true })
    await mkdir(outsidePath, { recursive: true })

    const resolved = await resolveExistingFileReferences({
      workspacePath,
      references: [
        'results/',
        'archive/previous-results/',
        outsidePath + '/',
        'missing-folder/',
        '../outside/'
      ]
    })

    assert.deepEqual(resolved, [
      {
        reference: 'results/',
        path: resultsPath
      },
      {
        reference: 'archive/previous-results/',
        path: archivePath
      },
      {
        reference: outsidePath + '/',
        path: outsidePath
      }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveExistingFileReferences skips existing files with disallowed extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-inline-file-links-'))
  const workspacePath = join(root, 'workspace')

  try {
    await mkdir(workspacePath, { recursive: true })
    await mkdir(join(workspacePath, 'folder.md'), { recursive: true })
    await writeFile(join(workspacePath, 'notes.md'), '# Notes\n', 'utf8')
    await writeFile(join(workspacePath, 'budget.xlsx'), 'not a real workbook\n', 'utf8')
    await writeFile(join(workspacePath, 'archive.zip'), 'not a real zip\n', 'utf8')
    await writeFile(join(workspacePath, 'payload.bin'), 'binary-ish\n', 'utf8')

    const resolved = await resolveExistingFileReferences({
      workspacePath,
      references: ['notes.md', 'budget.xlsx', 'folder.md', 'archive.zip', 'payload.bin']
    })

    assert.deepEqual(resolved, [
      {
        reference: 'notes.md',
        path: join(workspacePath, 'notes.md')
      },
      {
        reference: 'budget.xlsx',
        path: join(workspacePath, 'budget.xlsx')
      }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
