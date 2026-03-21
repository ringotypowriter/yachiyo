import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  BrowserSearchSession,
  copyBrowserProfileSessionData,
  createBrowserSearchSessionImportService,
  listGoogleChromeImportSources,
  resolveGoogleChromeDataPath
} from './browserSearchSession.ts'

test('BrowserSearchSession reuses a persistent profile path while bounding page lifetime', async () => {
  const calls: string[] = []
  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-browser-session',
    pageFactory: {
      async createPage(profilePath) {
        calls.push(`create:${profilePath}`)
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            return 'ok' as TResult
          },
          getURL() {
            return 'https://example.com'
          }
        }
      },
      async disposePage() {
        calls.push('dispose')
      }
    }
  })

  const value = await session.withPage(async (page) => page.evaluate<string>('1'))

  assert.equal(value, 'ok')
  assert.deepEqual(calls, ['create:/tmp/yachiyo-browser-session', 'dispose'])
})

test('copyBrowserProfileSessionData copies browser session storage into the dedicated target profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-browser-session-copy-'))
  const sourceProfilePath = join(root, 'chrome', 'Default')
  const targetProfilePath = join(root, 'target')

  try {
    await mkdir(join(sourceProfilePath, 'Local Storage'), { recursive: true })
    await writeFile(join(sourceProfilePath, 'Cookies'), 'cookie-db', 'utf8')
    await writeFile(join(sourceProfilePath, 'Local Storage', 'leveldb.txt'), 'local', 'utf8')

    await copyBrowserProfileSessionData(sourceProfilePath, targetProfilePath)

    assert.equal(await readFile(join(targetProfilePath, 'Cookies'), 'utf8'), 'cookie-db')
    assert.equal(
      await readFile(join(targetProfilePath, 'Local Storage', 'leveldb.txt'), 'utf8'),
      'local'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser session import service lists Chrome profiles and records imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-browser-session-import-'))
  const chromeDataPath = join(root, 'Google', 'Chrome')
  const targetProfilePath = join(root, 'target')

  try {
    await mkdir(join(chromeDataPath, 'Default', 'Local Storage'), { recursive: true })
    await mkdir(join(chromeDataPath, 'Profile 1'), { recursive: true })
    await writeFile(join(chromeDataPath, 'Default', 'Cookies'), 'cookies', 'utf8')

    const sources = await listGoogleChromeImportSources({
      chromeDataPath
    })
    assert.deepEqual(
      sources.map((source) => source.profileName),
      ['Default', 'Profile 1']
    )

    const service = createBrowserSearchSessionImportService({
      chromeDataPath,
      now: () => new Date('2026-03-21T12:00:00.000Z')
    })
    const imported = await service.importSession({
      profilePath: targetProfilePath,
      sourceBrowser: 'google-chrome',
      sourceProfileName: 'Default'
    })

    assert.equal(imported.sourceProfileName, 'Default')
    assert.equal(imported.importedAt, '2026-03-21T12:00:00.000Z')
    assert.equal(await readFile(join(targetProfilePath, 'Cookies'), 'utf8'), 'cookies')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveGoogleChromeDataPath resolves platform-specific Chrome profile roots', () => {
  assert.equal(
    resolveGoogleChromeDataPath({
      platform: 'darwin',
      homeDir: '/Users/yachiyo'
    }),
    '/Users/yachiyo/Library/Application Support/Google/Chrome'
  )

  assert.equal(
    resolveGoogleChromeDataPath({
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\Yachiyo\\AppData\\Local'
      } as NodeJS.ProcessEnv,
      homeDir: 'C:\\Users\\Yachiyo'
    }),
    'C:\\Users\\Yachiyo\\AppData\\Local/Google/Chrome/User Data'
  )

  assert.equal(
    resolveGoogleChromeDataPath({
      platform: 'linux',
      env: {
        XDG_CONFIG_HOME: '/home/yachiyo/.config-custom'
      } as NodeJS.ProcessEnv,
      homeDir: '/home/yachiyo'
    }),
    '/home/yachiyo/.config-custom/google-chrome'
  )
})
