import assert from 'node:assert/strict'
import test from 'node:test'

import type { DiscoveredApp, DiscoveredApps } from '@yachiyo/shared/discoveredApp'
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
      }
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
          }
        }
      ),
    /No default application is registered/
  )

  assert.deepEqual(openedPaths, ['C:\\Users\\Yuki\\Notes\\README.md'])
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
          openPath: async () => ''
        }
      ),
    /not installed/
  )
})
