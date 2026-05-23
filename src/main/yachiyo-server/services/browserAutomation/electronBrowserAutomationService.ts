import electron from 'electron'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveElectronSessionProxyConfig } from '../webSearch/electronProxyConfig.ts'

const DEFAULT_WAIT_POLL_INTERVAL_MS = 100
const { BrowserWindow, session } = electron

export interface BrowserAutomationViewport {
  width: number
  height: number
}

export interface BrowserAutomationRefBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAutomationRef {
  ref: string
  tag: string
  text?: string
  ariaLabel?: string
  placeholder?: string
  href?: string
  box?: BrowserAutomationRefBox
}

export interface BrowserAutomationSnapshot {
  url: string
  title?: string
  refCount: number
  refs: BrowserAutomationRef[]
}

export interface BrowserAutomationPdfResult {
  savedFileName: string
  savedFilePath: string
  bytesWritten: number
}

export interface BrowserAutomationScreenshotResult {
  savedFileName: string
  savedFilePath: string
  bytesWritten: number
}

export interface BrowserAutomationService {
  open(input: {
    threadId: string
    session: string
    url?: string
    viewport?: BrowserAutomationViewport
  }): Promise<{ url: string; title?: string }>

  close(input: { threadId: string; session: string }): Promise<void>

  getUrl(input: { threadId: string; session: string }): Promise<string>
  getTitle(input: { threadId: string; session: string }): Promise<string>

  loadUrl(input: { threadId: string; session: string; url: string }): Promise<string>

  waitForFunction(input: {
    threadId: string
    session: string
    predicate: string
    timeoutMs: number
    pollIntervalMs?: number
    signal?: AbortSignal
  }): Promise<void>

  snapshot(input: {
    threadId: string
    session: string
    maxRefs?: number
  }): Promise<BrowserAutomationSnapshot>

  click(input: { threadId: string; session: string; ref: string }): Promise<void>
  fill(input: { threadId: string; session: string; ref: string; text: string }): Promise<void>
  type(input: { threadId: string; session: string; ref: string; text: string }): Promise<void>
  select(input: { threadId: string; session: string; ref: string; value: string }): Promise<void>
  check(input: { threadId: string; session: string; ref: string; checked: boolean }): Promise<void>
  press(input: { threadId: string; session: string; key: string }): Promise<void>

  screenshot(input: {
    threadId: string
    session: string
    workspacePath: string
    fileName?: string
  }): Promise<BrowserAutomationScreenshotResult>

  pdf(input: {
    threadId: string
    session: string
    workspacePath: string
    fileName?: string
  }): Promise<BrowserAutomationPdfResult>
}

interface ThreadBrowserSessionState {
  window: InstanceType<typeof BrowserWindow>
  refXpathById: Map<string, string>
}

function toViewport(input?: BrowserAutomationViewport): BrowserAutomationViewport {
  const width = input?.width ?? 1280
  const height = input?.height ?? 960
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1280,
    height: Number.isFinite(height) && height > 0 ? height : 960
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function ensureFileName(fileName: string, ext: string): string {
  const trimmed = fileName.trim()
  if (!trimmed) return `browser.${ext}`
  return trimmed.endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`
}

function toolResultPath(workspacePath: string, fileName: string): string {
  return join(workspacePath, '.yachiyo', 'tool-result', fileName)
}

export function createElectronBrowserAutomationService(input: {
  profilePath: string
}): BrowserAutomationService {
  const threadSessions = new Map<string, Map<string, ThreadBrowserSessionState>>()
  const browserSession = session.fromPath(input.profilePath, { cache: true })
  let proxyReady: Promise<void> | undefined

  function getThreadMap(threadId: string): Map<string, ThreadBrowserSessionState> {
    const existing = threadSessions.get(threadId)
    if (existing) return existing
    const created = new Map<string, ThreadBrowserSessionState>()
    threadSessions.set(threadId, created)
    return created
  }

  async function ensureProxyReady(): Promise<void> {
    if (!proxyReady) {
      proxyReady = browserSession.setProxy(resolveElectronSessionProxyConfig()).then(() => {
        browserSession.setCertificateVerifyProc((_request, callback) => callback(0))
      })
    }
    await proxyReady
  }

  function requireSessionState(threadId: string, name: string): ThreadBrowserSessionState {
    const threadMap = threadSessions.get(threadId)
    const state = threadMap?.get(name)
    if (!state) {
      throw new Error(
        `No browser session "${name}" is open for this conversation. Call useBrowser({ action: "open", session: "${name}" }) first.`
      )
    }
    if (state.window.isDestroyed()) {
      threadMap?.delete(name)
      throw new Error(
        `Browser session "${name}" was destroyed. Re-open it with useBrowser({ action: "open", session: "${name}" }).`
      )
    }
    return state
  }

  async function evaluate<TResult>(
    state: ThreadBrowserSessionState,
    script: string
  ): Promise<TResult> {
    return state.window.webContents.executeJavaScript(script, true)
  }

  return {
    async open({ threadId, session: sessionName, url, viewport }) {
      await ensureProxyReady()
      const threadMap = getThreadMap(threadId)
      const existing = threadMap.get(sessionName)
      if (existing && !existing.window.isDestroyed()) {
        if (url) {
          await existing.window.loadURL(url)
        }
        return {
          url: existing.window.webContents.getURL() || url || '',
          title: existing.window.getTitle()
        }
      }

      const { width, height } = toViewport(viewport)
      const window = new BrowserWindow({
        show: false,
        width,
        height,
        webPreferences: {
          backgroundThrottling: false,
          sandbox: false,
          session: browserSession
        }
      })

      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      threadMap.set(sessionName, {
        window,
        refXpathById: new Map<string, string>()
      })

      if (url) {
        await window.loadURL(url)
      }

      return { url: window.webContents.getURL() || url || '', title: window.getTitle() }
    },

    async close({ threadId, session: sessionName }) {
      const threadMap = threadSessions.get(threadId)
      const state = threadMap?.get(sessionName)
      if (!state) return

      threadMap?.delete(sessionName)
      if (!state.window.isDestroyed()) {
        state.window.destroy()
      }
    },

    async getUrl({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      return state.window.webContents.getURL()
    },

    async getTitle({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      return state.window.getTitle()
    },

    async loadUrl({ threadId, session: sessionName, url }) {
      const state = requireSessionState(threadId, sessionName)
      await state.window.loadURL(url)
      return state.window.webContents.getURL() || url
    },

    async waitForFunction({
      threadId,
      session: sessionName,
      predicate,
      timeoutMs,
      pollIntervalMs,
      signal
    }) {
      const state = requireSessionState(threadId, sessionName)
      const start = Date.now()
      const poll = pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS

      while (Date.now() - start < timeoutMs) {
        if (signal?.aborted) {
          const error = new Error('Aborted')
          error.name = 'AbortError'
          throw error
        }

        const matched = await evaluate<boolean>(state, predicate)
        if (matched) return

        await new Promise((resolve) => setTimeout(resolve, poll))
      }

      throw new Error(`Timed out after ${timeoutMs}ms waiting for predicate.`)
    },

    async snapshot({ threadId, session: sessionName, maxRefs }) {
      const state = requireSessionState(threadId, sessionName)
      const limit = typeof maxRefs === 'number' && maxRefs > 0 ? Math.min(maxRefs, 200) : 60

      const result = await evaluate<{
        url: string
        title?: string
        refs: Array<Omit<BrowserAutomationRef, 'ref'> & { xpath: string }>
      }>(
        state,
        `(() => {
          const limit = ${JSON.stringify(limit)}
          const isVisible = (el) => {
            if (!(el instanceof Element)) return false
            const style = window.getComputedStyle(el)
            if (!style || style.visibility === 'hidden' || style.display === 'none') return false
            const rect = el.getBoundingClientRect()
            return rect.width > 1 && rect.height > 1
          }

          const elementText = (el) => {
            const raw = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
            return raw.length > 120 ? raw.slice(0, 117) + '...' : raw
          }

          const toXpath = (el) => {
            if (!(el instanceof Element)) return ''
            if (el.id) return '//*[@id=' + JSON.stringify(el.id) + ']'
            const parts = []
            let node = el
            while (node && node.nodeType === 1 && parts.length < 32) {
              const tag = node.tagName.toLowerCase()
              let index = 1
              let sibling = node.previousElementSibling
              while (sibling) {
                if (sibling.tagName === node.tagName) index++
                sibling = sibling.previousElementSibling
              }
              parts.unshift(tag + '[' + index + ']')
              node = node.parentElement
            }
            return '/' + parts.join('/')
          }

          const selector = [
            'a[href]',
            'button',
            'input:not([type="hidden"])',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[contenteditable="true"]'
          ].join(',')

          const nodes = Array.from(document.querySelectorAll(selector))
            .filter(isVisible)
            .slice(0, limit)

          const refs = nodes.map((el) => {
            const rect = el.getBoundingClientRect()
            return {
              tag: el.tagName.toLowerCase(),
              text: elementText(el) || undefined,
              ariaLabel: (el.getAttribute('aria-label') || '').trim() || undefined,
              placeholder: (el.getAttribute('placeholder') || '').trim() || undefined,
              href: (el instanceof HTMLAnchorElement ? el.href : (el.getAttribute('href') || '').trim()) || undefined,
              box: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              xpath: toXpath(el)
            }
          })

          return {
            url: location.href,
            title: document.title || undefined,
            refs
          }
        })()`
      )

      state.refXpathById.clear()
      const refs: BrowserAutomationRef[] = []
      for (let i = 0; i < result.refs.length; i++) {
        const ref = `e${i + 1}`
        const item = result.refs[i]!
        if (item.xpath) {
          state.refXpathById.set(ref, item.xpath)
        }
        refs.push({
          ref,
          tag: item.tag,
          ...(item.text ? { text: item.text } : {}),
          ...(item.ariaLabel ? { ariaLabel: item.ariaLabel } : {}),
          ...(item.placeholder ? { placeholder: item.placeholder } : {}),
          ...(item.href ? { href: item.href } : {}),
          ...(item.box ? { box: item.box } : {})
        })
      }

      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        refCount: refs.length,
        refs
      }
    },

    async click({ threadId, session: sessionName, ref }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = state.refXpathById.get(ref)
      if (!xpath) {
        throw new Error(
          `Unknown ref "${ref}" for session "${sessionName}". Call useBrowser({ action: "snapshot" }) and use the latest refs.`
        )
      }

      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          node.scrollIntoView({ block: 'center', inline: 'center' })
          ;(node).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          ;(node).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          ;(node).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          ;(node).dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })()`
      )
    },

    async fill({ threadId, session: sessionName, ref, text }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = state.refXpathById.get(ref)
      if (!xpath) {
        throw new Error(
          `Unknown ref "${ref}" for session "${sessionName}". Call useBrowser({ action: "snapshot" }) and use the latest refs.`
        )
      }

      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const value = ${JSON.stringify(text)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
          el.scrollIntoView({ block: 'center', inline: 'center' })
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
            setter?.call(el, value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          if ((el).isContentEditable) {
            el.textContent = value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          throw new Error('Ref is not fillable.')
        })()`
      )
    },

    async type({ threadId, session: sessionName, ref, text }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = state.refXpathById.get(ref)
      if (!xpath) {
        throw new Error(
          `Unknown ref "${ref}" for session "${sessionName}". Call useBrowser({ action: "snapshot" }) and use the latest refs.`
        )
      }

      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const value = ${JSON.stringify(text)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
          el.scrollIntoView({ block: 'center', inline: 'center' })
          if (el instanceof HTMLElement) el.focus()
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = (el.value || '') + value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          if ((el).isContentEditable) {
            el.textContent = (el.textContent || '') + value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          throw new Error('Ref is not typable.')
        })()`
      )
    },

    async select({ threadId, session: sessionName, ref, value }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = state.refXpathById.get(ref)
      if (!xpath) {
        throw new Error(
          `Unknown ref "${ref}" for session "${sessionName}". Call useBrowser({ action: "snapshot" }) and use the latest refs.`
        )
      }

      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const value = ${JSON.stringify(value)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
          el.scrollIntoView({ block: 'center', inline: 'center' })
          if (el instanceof HTMLSelectElement) {
            el.value = value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          throw new Error('Ref is not a select element.')
        })()`
      )
    },

    async check({ threadId, session: sessionName, ref, checked }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = state.refXpathById.get(ref)
      if (!xpath) {
        throw new Error(
          `Unknown ref "${ref}" for session "${sessionName}". Call useBrowser({ action: "snapshot" }) and use the latest refs.`
        )
      }

      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const checked = ${JSON.stringify(checked)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
          el.scrollIntoView({ block: 'center', inline: 'center' })
          if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
            el.checked = checked
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          throw new Error('Ref is not a checkbox/radio input.')
        })()`
      )
    },

    async press({ threadId, session: sessionName, key }) {
      const state = requireSessionState(threadId, sessionName)
      await evaluate<void>(
        state,
        `(() => {
          const key = ${JSON.stringify(key)}
          const el = document.activeElement
          if (!(el instanceof Element)) return
          el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
        })()`
      )
    },

    async screenshot({ threadId, session: sessionName, workspacePath, fileName }) {
      const state = requireSessionState(threadId, sessionName)
      const pngName = ensureFileName(fileName ?? 'browser', 'png')
      const savedFileName = join('.yachiyo', 'tool-result', pngName)
      const savedFilePath = toolResultPath(workspacePath, pngName)

      await mkdir(dirname(savedFilePath), { recursive: true })
      const image = await state.window.webContents.capturePage()
      const buffer = image.toPNG()
      await writeFile(savedFilePath, buffer)

      return {
        savedFileName,
        savedFilePath,
        bytesWritten: buffer.byteLength
      }
    },

    async pdf({ threadId, session: sessionName, workspacePath, fileName }) {
      const state = requireSessionState(threadId, sessionName)
      const pdfName = ensureFileName(fileName ?? 'browser', 'pdf')
      const savedFileName = join('.yachiyo', 'tool-result', pdfName)
      const savedFilePath = toolResultPath(workspacePath, pdfName)

      await mkdir(dirname(savedFilePath), { recursive: true })

      const buffer = await state.window.webContents
        .printToPDF({
          printBackground: true
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) throw error
          throw error
        })

      await writeFile(savedFilePath, buffer)

      return {
        savedFileName,
        savedFilePath,
        bytesWritten: buffer.byteLength
      }
    }
  }
}
