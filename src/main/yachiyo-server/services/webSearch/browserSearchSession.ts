import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

import type {
  BrowserSearchImportSourceId,
  WebSearchBrowserImportSource
} from '../../../../shared/yachiyo/protocol.ts'

const CHROME_COPY_ENTRIES = [
  'Cookies',
  'Cookies-journal',
  'Network',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Shared Storage',
  'WebStorage'
] as const

export interface BrowserSearchPage {
  evaluate<TResult>(script: string): Promise<TResult>
  getURL(): string
  loadURL(url: string): Promise<void>
  waitForFunction(input: {
    predicate: string
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<void>
}

export interface BrowserSearchPageFactory {
  createPage(profilePath: string): Promise<BrowserSearchPage>
  disposePage(page: BrowserSearchPage): Promise<void>
}

export interface BrowserSearchSessionImportResult {
  importedAt: string
  sourceBrowser: BrowserSearchImportSourceId
  sourceProfileName: string
}

export interface BrowserSearchSessionImportService {
  importSession(input: {
    profilePath: string
    sourceBrowser: BrowserSearchImportSourceId
    sourceProfileName: string
  }): Promise<BrowserSearchSessionImportResult>
  listSources(): Promise<WebSearchBrowserImportSource[]>
}

export class BrowserSearchSession {
  readonly profilePath: string

  private readonly pageFactory: BrowserSearchPageFactory

  constructor(input: { pageFactory: BrowserSearchPageFactory; profilePath: string }) {
    this.profilePath = input.profilePath
    this.pageFactory = input.pageFactory
  }

  async withPage<TResult>(task: (page: BrowserSearchPage) => Promise<TResult>): Promise<TResult> {
    const page = await this.pageFactory.createPage(this.profilePath)

    try {
      return await task(page)
    } finally {
      await this.pageFactory.disposePage(page)
    }
  }
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  await cp(sourcePath, targetPath, {
    dereference: false,
    errorOnExist: false,
    force: true,
    recursive: true
  }).catch((error: unknown) => {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: string }).code : ''
    if (code !== 'ENOENT') {
      throw error
    }
  })
}

export async function copyBrowserProfileSessionData(
  sourceProfilePath: string,
  targetProfilePath: string
): Promise<void> {
  await rm(targetProfilePath, { force: true, recursive: true })
  await mkdir(targetProfilePath, { recursive: true })

  for (const entry of CHROME_COPY_ENTRIES) {
    await copyIfExists(join(sourceProfilePath, entry), join(targetProfilePath, entry))
  }
}

export async function listGoogleChromeImportSources(input: {
  chromeDataPath: string
  localState?: string
}): Promise<WebSearchBrowserImportSource[]> {
  const profileDirs = await readdir(input.chromeDataPath, { withFileTypes: true }).catch(() => [])
  const profiles = profileDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/u.test(name))
    .sort((left, right) => left.localeCompare(right))

  return profiles.map((profileName) => ({
    browserId: 'google-chrome',
    browserName: 'Google Chrome',
    profileName,
    profilePath: join(input.chromeDataPath, profileName)
  }))
}

export function resolveGoogleChromeDataPath(input: {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  platform?: NodeJS.Platform
} = {}): string {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const homeDir = input.homeDir ?? homedir()

  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
  }

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim()
    return localAppData && localAppData.length > 0
      ? join(localAppData, 'Google', 'Chrome', 'User Data')
      : join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  }

  const xdgConfigHome = env['XDG_CONFIG_HOME']?.trim()
  return xdgConfigHome && xdgConfigHome.length > 0
    ? join(xdgConfigHome, 'google-chrome')
    : join(homeDir, '.config', 'google-chrome')
}

export function createBrowserSearchSessionImportService(input: {
  chromeDataPath: string
  now?: () => Date
}): BrowserSearchSessionImportService {
  const now = input.now ?? (() => new Date())

  return {
    async listSources() {
      return listGoogleChromeImportSources({
        chromeDataPath: input.chromeDataPath
      })
    },
    async importSession(importInput) {
      if (importInput.sourceBrowser !== 'google-chrome') {
        throw new Error(`Unsupported browser import source: ${importInput.sourceBrowser}`)
      }

      const sources = await listGoogleChromeImportSources({
        chromeDataPath: input.chromeDataPath
      })
      const source = sources.find((entry) => entry.profileName === importInput.sourceProfileName)

      if (!source) {
        throw new Error(`Unknown Google Chrome profile: ${importInput.sourceProfileName}`)
      }

      await copyBrowserProfileSessionData(source.profilePath, importInput.profilePath)

      return {
        importedAt: now().toISOString(),
        sourceBrowser: source.browserId,
        sourceProfileName: source.profileName
      }
    }
  }
}

export function deriveBrowserSearchSessionProfileName(profilePath: string): string {
  return basename(profilePath)
}
