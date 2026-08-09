import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSearchBinaries } from './searchBinaries.ts'

test('Windows search resolver selects bundled rg.exe and fd.exe in development', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-search-win-'))
  const binaryDir = join(root, 'apps', 'desktop', 'resources', 'bin', 'win-x64')
  await mkdir(binaryDir, { recursive: true })
  await writeFile(join(binaryDir, 'rg.exe'), 'fixture')
  await writeFile(join(binaryDir, 'fd.exe'), 'fixture')

  try {
    assert.deepEqual(
      resolveSearchBinaries({
        platform: 'win32',
        arch: 'x64',
        projectRoot: root,
        resourcesPath: undefined
      }),
      {
        rg: join(binaryDir, 'rg.exe'),
        fd: join(binaryDir, 'fd.exe')
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing Windows search binaries preserve the TypeScript fallback contract', () => {
  assert.deepEqual(
    resolveSearchBinaries({
      platform: 'win32',
      arch: 'x64',
      projectRoot: '/missing',
      resourcesPath: undefined
    }),
    { rg: undefined, fd: undefined }
  )
})
