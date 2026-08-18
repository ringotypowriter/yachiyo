import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { DiscoveredApp, DiscoveredApps } from '@yachiyo/shared/discoveredApp'
import type { ResolveFileReferencesInput } from '@yachiyo/shared/protocol'
import { resolveExistingFileReferences } from '../../../../../packages/runtime/src/runtime/files/inlineCodeFileReferences.ts'
import { openFileUsingSelection, revealFileUsingSelection } from './fileHandlers.ts'

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

async function createWorkspaceLinkSwapFixture(t: TestContext): Promise<{
  workspacePath: string
  requestedPath: string
  verifiedPath: string
  resolveAfterReplacingLink: typeof resolveExistingFileReferences
}> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-workspace-operation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'workspace')
  const safeDirectory = join(workspacePath, 'safe')
  const linkedDirectory = join(workspacePath, 'artifacts')
  const outsideDirectory = join(root, 'outside')
  const requestedPath = join(linkedDirectory, 'report.md')
  const safePath = join(safeDirectory, 'report.md')
  await mkdir(safeDirectory, { recursive: true })
  await mkdir(outsideDirectory, { recursive: true })
  await writeFile(safePath, 'safe')
  await writeFile(join(outsideDirectory, 'report.md'), 'outside')
  await symlink(safeDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')

  return {
    workspacePath,
    requestedPath,
    verifiedPath: await realpath(safePath),
    resolveAfterReplacingLink: async (input: ResolveFileReferencesInput) => {
      const resolved = await resolveExistingFileReferences(input)
      await rm(linkedDirectory, { recursive: true, force: true })
      await symlink(
        outsideDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      return resolved
    }
  }
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

test('workspace-only open uses the verified real path after a link is replaced', async (t) => {
  const { workspacePath, requestedPath, verifiedPath, resolveAfterReplacingLink } =
    await createWorkspaceLinkSwapFixture(t)

  const openedPaths: string[] = []
  const openedContents: string[] = []
  await openFileUsingSelection(
    { path: requestedPath, workspacePath, workspaceOnly: true },
    {
      discoverApps: async () => discoveredApps,
      launchApp: async () => {},
      openPath: async (path) => {
        openedPaths.push(path)
        openedContents.push(await readFile(path, 'utf8'))
        return ''
      },
      resolveFileReferences: resolveAfterReplacingLink
    }
  )

  assert.deepEqual(openedPaths, [verifiedPath])
  assert.deepEqual(openedContents, ['safe'])
})

test('workspace-only reveal uses the verified real path after a link is replaced', async (t) => {
  const { workspacePath, requestedPath, verifiedPath, resolveAfterReplacingLink } =
    await createWorkspaceLinkSwapFixture(t)

  const revealedPaths: string[] = []
  await revealFileUsingSelection(
    { path: requestedPath, workspacePath, workspaceOnly: true },
    {
      revealPath: (path) => {
        revealedPaths.push(path)
      },
      resolveFileReferences: resolveAfterReplacingLink
    }
  )

  assert.deepEqual(revealedPaths, [verifiedPath])
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
