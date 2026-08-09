import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
          async getURL() {
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

test('BrowserSearchSession lets ordinary page tasks overlap and disposes each page once', async () => {
  const calls: string[] = []
  let releaseFirstTask: (() => void) | undefined
  const firstTaskComplete = new Promise<void>((resolve) => {
    releaseFirstTask = resolve
  })
  let firstTaskStarted: (() => void) | undefined
  const firstTaskStart = new Promise<void>((resolve) => {
    firstTaskStarted = resolve
  })

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
          async getURL() {
            return 'https://example.com'
          }
        }
      },
      async disposePage() {
        calls.push('dispose')
      }
    }
  })

  const first = session.withPage(async () => {
    calls.push('task:first:start')
    firstTaskStarted?.()
    await firstTaskComplete
    calls.push('task:first:end')
    return 'first'
  })

  await firstTaskStart
  let secondOverlapped = false
  const second = session.withPage(async () => {
    secondOverlapped = true
    calls.push('task:second')
    return 'second'
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  const overlappedBeforeFirstFinished = secondOverlapped

  releaseFirstTask?.()

  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
  assert.equal(overlappedBeforeFirstFinished, true)
  assert.deepEqual(calls, [
    'create:/tmp/yachiyo-browser-session',
    'task:first:start',
    'create:/tmp/yachiyo-browser-session',
    'task:second',
    'dispose',
    'task:first:end',
    'dispose'
  ])
})

test('BrowserSearchSession caps concurrent ordinary page tasks at four', async () => {
  let activeTasks = 0
  let maxActiveTasks = 0
  let startedTasks = 0
  let notifyFourStarted: (() => void) | undefined
  const fourStarted = new Promise<void>((resolve) => {
    notifyFourStarted = resolve
  })
  let releaseTasks: (() => void) | undefined
  const tasksReleased = new Promise<void>((resolve) => {
    releaseTasks = resolve
  })

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-browser-session',
    pageFactory: {
      async createPage() {
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
          async getURL() {
            return 'https://example.com'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })

  const tasks = Array.from({ length: 5 }, () =>
    session.withPage(async () => {
      activeTasks += 1
      startedTasks += 1
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks)
      if (startedTasks === 4) {
        notifyFourStarted?.()
      }
      await tasksReleased
      activeTasks -= 1
    })
  )

  await fourStarted
  await new Promise((resolve) => setTimeout(resolve, 0))
  const startedBeforeRelease = startedTasks
  const maxActiveBeforeRelease = maxActiveTasks

  releaseTasks?.()
  await Promise.all(tasks)

  assert.equal(startedBeforeRelease, 4)
  assert.equal(maxActiveBeforeRelease, 4)
  assert.equal(startedTasks, 5)
})

test('BrowserSearchSession exclusive access waits for active pages and blocks later pages', async () => {
  const calls: string[] = []
  let releaseFirstPage: (() => void) | undefined
  const firstPageComplete = new Promise<void>((resolve) => {
    releaseFirstPage = resolve
  })
  let firstPageStarted: (() => void) | undefined
  const firstPageStart = new Promise<void>((resolve) => {
    firstPageStarted = resolve
  })
  let releaseExclusive: (() => void) | undefined
  const exclusiveComplete = new Promise<void>((resolve) => {
    releaseExclusive = resolve
  })
  let exclusiveStarted: (() => void) | undefined
  const exclusiveStart = new Promise<void>((resolve) => {
    exclusiveStarted = resolve
  })

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-browser-session',
    pageFactory: {
      async createPage() {
        calls.push('create')
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
          async getURL() {
            return 'https://example.com'
          }
        }
      },
      async disposePage() {
        calls.push('dispose')
      }
    }
  })

  const first = session.withPage(async () => {
    calls.push('page:first:start')
    firstPageStarted?.()
    await firstPageComplete
    calls.push('page:first:end')
  })
  await firstPageStart

  const exclusive = session.withExclusiveAccess(async () => {
    calls.push('exclusive:start')
    exclusiveStarted?.()
    await exclusiveComplete
    calls.push('exclusive:end')
  })
  const later = session.withPage(async () => {
    calls.push('page:later')
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['create', 'page:first:start'])

  releaseFirstPage?.()
  await exclusiveStart
  assert.deepEqual(calls, [
    'create',
    'page:first:start',
    'page:first:end',
    'dispose',
    'exclusive:start'
  ])

  releaseExclusive?.()
  await Promise.all([first, exclusive, later])
  assert.deepEqual(calls, [
    'create',
    'page:first:start',
    'page:first:end',
    'dispose',
    'exclusive:start',
    'exclusive:end',
    'create',
    'page:later',
    'dispose'
  ])
})

test('copyBrowserProfileSessionData copies browser session storage into the dedicated target profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-browser-session-copy-'))
  const sourceProfilePath = join(root, 'chrome', 'Default')
  const targetProfilePath = join(root, 'target')

  try {
    await mkdir(join(sourceProfilePath, 'Local Storage'), { recursive: true })
    await mkdir(join(sourceProfilePath, 'IndexedDB'), { recursive: true })
    await writeFile(join(sourceProfilePath, 'Cookies'), 'cookie-db', 'utf8')
    await writeFile(join(sourceProfilePath, 'QuotaManager'), 'quota-db', 'utf8')
    await writeFile(join(sourceProfilePath, 'Local Storage', 'leveldb.txt'), 'local', 'utf8')

    await copyBrowserProfileSessionData(sourceProfilePath, targetProfilePath)

    assert.equal(await readFile(join(targetProfilePath, 'Cookies'), 'utf8'), 'cookie-db')
    assert.equal(await readFile(join(targetProfilePath, 'QuotaManager'), 'utf8'), 'quota-db')
    assert.equal(
      await readFile(join(targetProfilePath, 'Local Storage', 'leveldb.txt'), 'utf8'),
      'local'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('copyBrowserProfileSessionData ignores locked optional quota files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-browser-session-copy-'))
  const sourceProfilePath = join(root, 'chrome', 'Default')
  const targetProfilePath = join(root, 'target')
  try {
    await mkdir(join(sourceProfilePath, 'Local Storage'), { recursive: true })
    await writeFile(join(sourceProfilePath, 'Cookies'), 'cookie-db', 'utf8')
    await writeFile(join(sourceProfilePath, 'QuotaManager'), 'quota-db', 'utf8')
    await writeFile(join(sourceProfilePath, 'Local Storage', 'leveldb.txt'), 'local', 'utf8')

    const copy = async (sourcePath: string, targetPath: string): Promise<void> => {
      if (basename(sourcePath) === 'QuotaManager') {
        const error = new Error('file is locked') as Error & { code?: string }
        error.code = 'EBUSY'
        throw error
      }

      await cp(sourcePath, targetPath, {
        dereference: false,
        errorOnExist: false,
        force: true,
        recursive: true
      })
    }

    await copyBrowserProfileSessionData(sourceProfilePath, targetProfilePath, copy)

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
  const homeDir = join(tmpdir(), 'yachiyo-browser-path-home')
  const localAppData = join(homeDir, 'AppData', 'Local')
  const xdgConfigHome = join(homeDir, '.config-custom')

  assert.equal(
    resolveGoogleChromeDataPath({
      platform: 'darwin',
      homeDir
    }),
    join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
  )

  assert.equal(
    resolveGoogleChromeDataPath({
      platform: 'win32',
      env: {
        LOCALAPPDATA: localAppData
      } as NodeJS.ProcessEnv,
      homeDir
    }),
    join(localAppData, 'Google', 'Chrome', 'User Data')
  )

  assert.equal(
    resolveGoogleChromeDataPath({
      platform: 'linux',
      env: {
        XDG_CONFIG_HOME: xdgConfigHome
      } as NodeJS.ProcessEnv,
      homeDir
    }),
    join(xdgConfigHome, 'google-chrome')
  )
})
