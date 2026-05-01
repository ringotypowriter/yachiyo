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
    await mkdir(join(workspacePath, 'graphrag'), { recursive: true })
    await mkdir(join(workspacePath, 'src', 'components'), { recursive: true })
    await writeFile(join(workspacePath, 'graphrag', 'TECH-KG-REDESIGN.md'), '# Plan\n', 'utf8')
    await writeFile(join(workspacePath, 'README.md'), '# Readme\n', 'utf8')
    await writeFile(join(workspacePath, 'src', 'App.tsx'), 'export function App() {}\n', 'utf8')
    await writeFile(outsidePath, '# Outside\n', 'utf8')

    const resolved = await resolveExistingFileReferences({
      workspacePath,
      references: [
        'graphrag/TECH-KG-REDESIGN.md',
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
        reference: 'graphrag/TECH-KG-REDESIGN.md',
        path: join(workspacePath, 'graphrag', 'TECH-KG-REDESIGN.md')
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

test('resolveExistingFileReferences skips existing files with disallowed extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-inline-file-links-'))
  const workspacePath = join(root, 'workspace')

  try {
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(workspacePath, 'notes.md'), '# Notes\n', 'utf8')
    await writeFile(join(workspacePath, 'budget.xlsx'), 'not a real workbook\n', 'utf8')
    await writeFile(join(workspacePath, 'archive.zip'), 'not a real zip\n', 'utf8')
    await writeFile(join(workspacePath, 'payload.bin'), 'binary-ish\n', 'utf8')

    const resolved = await resolveExistingFileReferences({
      workspacePath,
      references: ['notes.md', 'budget.xlsx', 'archive.zip', 'payload.bin']
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
