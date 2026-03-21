import electron from 'electron'

import type { BrowserSearchPage, BrowserSearchPageFactory } from './browserSearchSession.ts'

const DEFAULT_WAIT_POLL_INTERVAL_MS = 100
const { BrowserWindow, session } = electron

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

export function createElectronBrowserSearchPageFactory(): BrowserSearchPageFactory {
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

      return new ElectronBrowserSearchPage(window)
    },
    async disposePage(page) {
      if (page instanceof ElectronBrowserSearchPage) {
        page.destroy()
      }
    }
  }
}
