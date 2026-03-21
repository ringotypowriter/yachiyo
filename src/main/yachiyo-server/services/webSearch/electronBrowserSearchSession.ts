import electron from 'electron'

import type { BrowserSearchPage, BrowserSearchPageFactory } from './browserSearchSession.ts'

const DEFAULT_WAIT_POLL_INTERVAL_MS = 100
const { BrowserWindow, session } = electron

export interface BrowserSearchDiagnosticEvent {
  code?: number
  details?: Record<string, string | number | boolean | undefined>
  event: string
  profilePath: string
  url?: string
}

export interface ElectronBrowserSearchPageFactoryOptions {
  log?: (event: BrowserSearchDiagnosticEvent) => void
}

class ElectronBrowserSearchPage implements BrowserSearchPage {
  private readonly window: InstanceType<typeof BrowserWindow>

  constructor(window: InstanceType<typeof BrowserWindow>) {
    this.window = window
  }

  async evaluate<TResult>(script: string): Promise<TResult> {
    return this.window.webContents.executeJavaScript(script, true)
  }

  getURL(): string {
    return this.window.webContents.getURL()
  }

  async loadURL(url: string): Promise<void> {
    await this.window.loadURL(url)
  }

  async waitForFunction(input: {
    predicate: string
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<void> {
    const start = Date.now()
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS

    while (Date.now() - start < input.timeoutMs) {
      if (input.signal?.aborted) {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        throw error
      }

      const matched = await this.evaluate<boolean>(input.predicate)
      if (matched) {
        return
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(`Timed out after ${input.timeoutMs}ms waiting for page readiness.`)
  }

  destroy(): void {
    if (!this.window.isDestroyed()) {
      this.window.destroy()
    }
  }
}

export function createElectronBrowserSearchPageFactory(
  input: ElectronBrowserSearchPageFactoryOptions = {}
): BrowserSearchPageFactory {
  return {
    async createPage(profilePath) {
      const browserSession = session.fromPath(profilePath, { cache: true })
      const window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 960,
        webPreferences: {
          backgroundThrottling: false,
          sandbox: false,
          session: browserSession
        }
      })

      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          input.log?.({
            event: 'did-fail-load',
            profilePath,
            url: validatedURL,
            code: errorCode,
            details: {
              errorDescription,
              isMainFrame
            }
          })
        }
      )
      window.webContents.on('render-process-gone', (_event, details) => {
        input.log?.({
          event: 'render-process-gone',
          profilePath,
          url: window.webContents.getURL(),
          details: {
            reason: details.reason,
            exitCode: details.exitCode
          }
        })
      })

      return new ElectronBrowserSearchPage(window)
    },
    async disposePage(page) {
      if (page instanceof ElectronBrowserSearchPage) {
        page.destroy()
      }
    }
  }
}
