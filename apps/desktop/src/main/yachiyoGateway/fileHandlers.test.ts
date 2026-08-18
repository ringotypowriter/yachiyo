import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { DiscoveredApp, DiscoveredApps } from '@yachiyo/shared/discoveredApp'
import { resolveExistingFileReferences } from '../../../../../packages/runtime/src/runtime/files/inlineCodeFileReferences.ts'
import { openFileUsingSelection } from './fileHandlers.ts'

const obsidian: DiscoveredApp = {
  id: 'markdown:obsidian',
  name: 'Obsidian',
  executablePath: 'C:\\Program Files\\Obsidian\\Obsidian.exe',
  kind: 'markdown'
}

const discoveredApps: DiscoveredApps = {
  editors: [],
  terminals: [],
  markdownEditors: [obsidian]
}

test('configured Markdown open resolves the stable app id and launches without the shell', async () => {
  const openedPaths: string[] = []
  const launches: Array<{ app: DiscoveredApp; targetPath: string }> = []

  await openFileUsingSelection(
    {
      path: 'C:\\Users\\Yuki\\Notes & Plans\\README.md',
      appSelection: 'markdown:obsidian',
      appKind: 'markdown'
    },
    {
      discoverApps: async () => discoveredApps,
      launchApp: async (app, input) => {
        launches.push({ app, targetPath: input.targetPath })
      },
      openPath: async (path) => {
        openedPaths.push(path)
        return ''
      },
      resolveFileReferences: async () => []
    }
  )

  assert.deepEqual(openedPaths, [])
  assert.deepEqual(launches, [
    {
      app: obsidian,
      targetPath: 'C:\\Users\\Yuki\\Notes & Plans\\README.md'
    }
  ])
})

test('default file open continues to use shell.openPath and surfaces its error', async () => {
  const openedPaths: string[] = []

  await assert.rejects(
    () =>
      openFileUsingSelection(
        { path: 'C:\\Users\\Yuki\\Notes\\README.md' },
        {
          discoverApps: async () => discoveredApps,
          launchApp: async () => {},
          openPath: async (path) => {
            openedPaths.push(path)
            return 'No default application is registered.'
          },
          resolveFileReferences: async () => []
        }
      ),
    /No default application is registered/
  )

  assert.deepEqual(openedPaths, ['C:\\Users\\Yuki\\Notes\\README.md'])
})

test('workspace-only open rejects a file moved behind an escaping symlink before click', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-workspace-open-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'workspace')
  const linkedDirectory = join(workspacePath, 'artifacts')
  const outsideDirectory = join(root, 'outside')
  const targetPath = join(linkedDirectory, 'secret.md')
  await mkdir(linkedDirectory, { recursive: true })
  await mkdir(outsideDirectory, { recursive: true })
  await writeFile(targetPath, 'safe')
  await writeFile(join(outsideDirectory, 'secret.md'), 'outside')

  await rm(linkedDirectory, { recursive: true })
  await symlink(
    outsideDirectory,
    linkedDirectory,
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const openedPaths: string[] = []
  await assert.rejects(
    () =>
      openFileUsingSelection(
        { path: targetPath, workspacePath, workspaceOnly: true },
        {
          discoverApps: async () => discoveredApps,
          launchApp: async () => {},
          openPath: async (path) => {
            openedPaths.push(path)
            return ''
          },
          resolveFileReferences: resolveExistingFileReferences
        }
      ),
    /outside the workspace|no longer available/i
  )

  assert.deepEqual(openedPaths, [])
})

test('configured file open rejects a stale or wrong-kind app selection', async () => {
  await assert.rejects(
    () =>
      openFileUsingSelection(
        {
          path: 'C:\\Users\\Yuki\\Notes\\README.md',
          appSelection: 'markdown:obsidian',
          appKind: 'editor'
        },
        {
          discoverApps: async () => discoveredApps,
          launchApp: async () => {},
          openPath: async () => '',
          resolveFileReferences: async () => []
        }
      ),
    /not installed/
  )
})
