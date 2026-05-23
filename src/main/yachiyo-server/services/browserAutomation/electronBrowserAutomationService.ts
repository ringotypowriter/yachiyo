import electron from 'electron'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveElectronSessionProxyConfig } from '../webSearch/electronProxyConfig.ts'
import { createBrowserPointerOverlay, type BrowserPointerOverlay } from './browserPointerOverlay.ts'
import type {
  BrowserAutomationPointerState,
  BrowserAutomationSessionRecord,
  BrowserAutomationViewBounds,
  HideBrowserAutomationSessionInput,
  ListBrowserAutomationSessionsInput,
  SetBrowserAutomationSessionBoundsInput,
  ShowBrowserAutomationSessionInput
} from '../../../../shared/yachiyo/protocol.ts'

const DEFAULT_WAIT_POLL_INTERVAL_MS = 100
const { BrowserWindow, WebContentsView, session } = electron

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
  listSessions(input: ListBrowserAutomationSessionsInput): BrowserAutomationSessionRecord[]

  showSessionView(
    input: ShowBrowserAutomationSessionInput & { window: InstanceType<typeof BrowserWindow> }
  ): BrowserAutomationSessionRecord

  hideSessionView(input: HideBrowserAutomationSessionInput): void

  setSessionViewBounds(
    input: SetBrowserAutomationSessionBoundsInput
  ): BrowserAutomationSessionRecord

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

  dispose(): void
}

interface ThreadBrowserSessionState {
  view: InstanceType<typeof WebContentsView>
  refXpathById: Map<string, string>
  threadId: string
  session: string
  viewport: BrowserAutomationViewport
  url: string
  title?: string
  pointer: BrowserAutomationPointerState | null
  overlay: BrowserPointerOverlay | null
  attachedWindow: InstanceType<typeof BrowserWindow> | null
  updatedAt: string
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

function toViewBounds(bounds: BrowserAutomationViewBounds): BrowserAutomationViewBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

function timestamp(): string {
  return new Date().toISOString()
}

export function createElectronBrowserAutomationService(input: {
  profilePath: string
}): BrowserAutomationService {
  const threadSessions = new Map<string, Map<string, ThreadBrowserSessionState>>()
  let browserSession: ReturnType<typeof session.fromPath> | undefined
  let proxyReady: Promise<void> | undefined

  function getThreadMap(threadId: string): Map<string, ThreadBrowserSessionState> {
    const existing = threadSessions.get(threadId)
    if (existing) return existing
    const created = new Map<string, ThreadBrowserSessionState>()
    threadSessions.set(threadId, created)
    return created
  }

  function getBrowserSession(): ReturnType<typeof session.fromPath> {
    if (
      typeof session?.fromPath !== 'function' ||
      typeof BrowserWindow !== 'function' ||
      typeof WebContentsView !== 'function'
    ) {
      throw new Error('Browser automation is only available inside the Electron app.')
    }

    browserSession ??= session.fromPath(input.profilePath, { cache: true })
    return browserSession
  }

  async function ensureProxyReady(): Promise<ReturnType<typeof session.fromPath>> {
    const currentSession = getBrowserSession()
    if (!proxyReady) {
      proxyReady = currentSession.setProxy(resolveElectronSessionProxyConfig()).then(() => {
        currentSession.setCertificateVerifyProc((_request, callback) => callback(0))
      })
    }
    await proxyReady
    return currentSession
  }

  function requireSessionState(threadId: string, name: string): ThreadBrowserSessionState {
    const threadMap = threadSessions.get(threadId)
    const state = threadMap?.get(name)
    if (!state) {
      throw new Error(
        `No browser session "${name}" is open for this conversation. Call useBrowser({ action: "open", session: "${name}" }) first.`
      )
    }
    if (state.view.webContents.isDestroyed()) {
      destroySessionState(state)
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
    return state.view.webContents.executeJavaScript(script, true)
  }

  function updateSessionMetadata(
    state: ThreadBrowserSessionState,
    metadata: { url?: string; title?: string; viewport?: BrowserAutomationViewport } = {}
  ): void {
    state.url = metadata.url ?? state.view.webContents.getURL() ?? state.url
    const nextTitle = metadata.title ?? state.view.webContents.getTitle()
    if (nextTitle) {
      state.title = nextTitle
    }
    if (metadata.viewport) {
      state.viewport = metadata.viewport
    }
    state.updatedAt = timestamp()
  }

  function toSessionRecord(state: ThreadBrowserSessionState): BrowserAutomationSessionRecord {
    return {
      threadId: state.threadId,
      session: state.session,
      url: state.url,
      ...(state.title ? { title: state.title } : {}),
      viewport: state.viewport,
      ...(state.pointer ? { pointer: state.pointer } : {}),
      updatedAt: state.updatedAt
    }
  }

  function detachSessionView(state: ThreadBrowserSessionState): void {
    const attachedWindow = state.attachedWindow
    if (!attachedWindow || attachedWindow.isDestroyed()) {
      state.attachedWindow = null
      return
    }

    try {
      if (state.overlay) {
        state.overlay.detach()
      }
      attachedWindow.contentView.removeChildView(state.view)
    } catch {
      // Electron throws if a view is not currently attached; the desired state is detached.
    }
    state.attachedWindow = null
  }

  function destroySessionState(state: ThreadBrowserSessionState): void {
    detachSessionView(state)
    state.overlay?.destroy()
    state.overlay = null
    if (!state.view.webContents.isDestroyed()) {
      state.view.webContents.close()
    }
  }

  function setPointer(
    state: ThreadBrowserSessionState,
    pointer: Omit<BrowserAutomationPointerState, 'updatedAt'> | null
  ): void {
    state.pointer = pointer ? { ...pointer, updatedAt: timestamp() } : null
    state.updatedAt = timestamp()
    state.overlay?.updatePointer(state.pointer)
  }

  async function pointAtRef(
    state: ThreadBrowserSessionState,
    sessionName: string,
    ref: string
  ): Promise<string> {
    const xpath = state.refXpathById.get(ref)
    if (!xpath) {
      throw new Error(
        `Unknown ref "${ref}" for session "${sessionName}". Call useBrowser({ action: "snapshot" }) and use the latest refs.`
      )
    }

    const point = await evaluate<{ x: number; y: number }>(
      state,
      `(() => {
        const xpath = ${JSON.stringify(xpath)}
        const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        if (!(node instanceof Element)) throw new Error('Element not found for ref.')
        node.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = node.getBoundingClientRect()
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2)
        }
      })()`
    )
    setPointer(state, { x: point.x, y: point.y, visible: true, label: `Yachiyo's Cursor` })
    return xpath
  }

  function purgeDestroyedSessions(threadMap: Map<string, ThreadBrowserSessionState>): void {
    for (const [name, state] of threadMap) {
      if (state.view.webContents.isDestroyed()) {
        destroySessionState(state)
        threadMap.delete(name)
      }
    }
  }

  return {
    listSessions({ threadId }) {
      const threadMap = threadSessions.get(threadId)
      if (!threadMap) return []
      purgeDestroyedSessions(threadMap)
      return [...threadMap.values()].map(toSessionRecord)
    },

    showSessionView({ threadId, session: sessionName, bounds, overlay, window }) {
      const state = requireSessionState(threadId, sessionName)
      const viewBounds = toViewBounds(bounds)
      if (!state.overlay) {
        state.overlay = createBrowserPointerOverlay()
      }

      if (overlay?.theme) {
        state.overlay.updateTheme(overlay.theme)
      }

      if (state.attachedWindow !== window) {
        detachSessionView(state)
        window.contentView.addChildView(state.view)
        state.attachedWindow = window
      }

      state.view.setBounds(viewBounds)
      state.overlay.attachTo(window)
      state.overlay.setBounds(viewBounds)
      state.overlay.updatePointer(state.pointer)
      if (overlay && 'activityBubble' in overlay) {
        state.overlay.updateActivityBubble(overlay.activityBubble ?? null)
      }
      updateSessionMetadata(state, {
        viewport: { width: viewBounds.width, height: viewBounds.height }
      })
      return toSessionRecord(state)
    },

    hideSessionView(input) {
      const threadMap = threadSessions.get(input.threadId)
      const state = threadMap?.get(input.session)
      if (!state) return
      detachSessionView(state)
    },

    setSessionViewBounds({ threadId, session: sessionName, bounds, overlay }) {
      const state = requireSessionState(threadId, sessionName)
      const viewBounds = toViewBounds(bounds)
      state.view.setBounds(viewBounds)
      state.overlay?.setBounds(viewBounds)
      if (overlay?.theme) {
        state.overlay?.updateTheme(overlay.theme)
      }
      if (overlay && 'activityBubble' in overlay) {
        state.overlay?.updateActivityBubble(overlay.activityBubble ?? null)
      }
      updateSessionMetadata(state, {
        viewport: { width: viewBounds.width, height: viewBounds.height }
      })
      return toSessionRecord(state)
    },

    async open({ threadId, session: sessionName, url, viewport }) {
      const currentSession = await ensureProxyReady()
      const threadMap = getThreadMap(threadId)
      const existing = threadMap.get(sessionName)
      if (existing && !existing.view.webContents.isDestroyed()) {
        if (viewport) {
          existing.viewport = toViewport(viewport)
          if (!existing.attachedWindow) {
            existing.view.setBounds({ x: 0, y: 0, ...existing.viewport })
          }
        }
        if (url) {
          await existing.view.webContents.loadURL(url)
        }
        updateSessionMetadata(existing, { url: existing.view.webContents.getURL() || url || '' })
        return {
          url: existing.url,
          ...(existing.title ? { title: existing.title } : {})
        }
      }

      if (existing) {
        destroySessionState(existing)
        threadMap.delete(sessionName)
      }

      const viewportSize = toViewport(viewport)
      const view = new WebContentsView({
        webPreferences: {
          backgroundThrottling: false,
          sandbox: false,
          session: currentSession
        }
      })
      view.setBounds({ x: 0, y: 0, ...viewportSize })
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      const state: ThreadBrowserSessionState = {
        view,
        refXpathById: new Map<string, string>(),
        threadId,
        session: sessionName,
        viewport: viewportSize,
        url: '',
        pointer: null,
        overlay: null,
        attachedWindow: null,
        updatedAt: timestamp()
      }
      threadMap.set(sessionName, state)

      view.webContents.on('did-navigate', (_event, navigatedUrl) => {
        updateSessionMetadata(state, { url: navigatedUrl })
      })
      view.webContents.on('did-navigate-in-page', (_event, navigatedUrl) => {
        updateSessionMetadata(state, { url: navigatedUrl })
      })
      view.webContents.on('page-title-updated', (_event, title) => {
        updateSessionMetadata(state, { title })
      })
      view.webContents.once('destroyed', () => {
        threadMap.delete(sessionName)
      })

      if (url) {
        await view.webContents.loadURL(url)
      }

      updateSessionMetadata(state, { url: view.webContents.getURL() || url || '' })
      return { url: state.url, ...(state.title ? { title: state.title } : {}) }
    },

    async close({ threadId, session: sessionName }) {
      const threadMap = threadSessions.get(threadId)
      const state = threadMap?.get(sessionName)
      if (!state) return

      threadMap?.delete(sessionName)
      destroySessionState(state)
      if (threadMap && threadMap.size === 0) {
        threadSessions.delete(threadId)
      }
    },

    async getUrl({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      updateSessionMetadata(state)
      return state.url
    },

    async getTitle({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      updateSessionMetadata(state)
      return state.title ?? ''
    },

    async loadUrl({ threadId, session: sessionName, url }) {
      const state = requireSessionState(threadId, sessionName)
      await state.view.webContents.loadURL(url)
      updateSessionMetadata(state, { url: state.view.webContents.getURL() || url })
      return state.url
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
        if (matched) {
          updateSessionMetadata(state)
          return
        }

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

      updateSessionMetadata(state, { url: result.url, title: result.title })
      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        refCount: refs.length,
        refs
      }
    },

    async click({ threadId, session: sessionName, ref }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = await pointAtRef(state, sessionName, ref)
      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          ;(node).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          ;(node).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          ;(node).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          ;(node).dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })()`
      )
      updateSessionMetadata(state)
    },

    async fill({ threadId, session: sessionName, ref, text }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = await pointAtRef(state, sessionName, ref)
      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const value = ${JSON.stringify(text)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
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
      updateSessionMetadata(state)
    },

    async type({ threadId, session: sessionName, ref, text }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = await pointAtRef(state, sessionName, ref)
      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const value = ${JSON.stringify(text)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
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
      updateSessionMetadata(state)
    },

    async select({ threadId, session: sessionName, ref, value }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = await pointAtRef(state, sessionName, ref)
      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const value = ${JSON.stringify(value)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
          if (el instanceof HTMLSelectElement) {
            el.value = value
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          throw new Error('Ref is not a select element.')
        })()`
      )
      updateSessionMetadata(state)
    },

    async check({ threadId, session: sessionName, ref, checked }) {
      const state = requireSessionState(threadId, sessionName)
      const xpath = await pointAtRef(state, sessionName, ref)
      await evaluate<void>(
        state,
        `(() => {
          const xpath = ${JSON.stringify(xpath)}
          const checked = ${JSON.stringify(checked)}
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          if (!(node instanceof Element)) throw new Error('Element not found for ref.')
          const el = node
          if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
            el.checked = checked
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return
          }
          throw new Error('Ref is not a checkbox/radio input.')
        })()`
      )
      updateSessionMetadata(state)
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
      updateSessionMetadata(state)
    },

    async screenshot({ threadId, session: sessionName, workspacePath, fileName }) {
      const state = requireSessionState(threadId, sessionName)
      const pngName = ensureFileName(fileName ?? 'browser', 'png')
      const savedFileName = join('.yachiyo', 'tool-result', pngName)
      const savedFilePath = toolResultPath(workspacePath, pngName)

      await mkdir(dirname(savedFilePath), { recursive: true })
      const image = await state.view.webContents.capturePage()
      const buffer = image.toPNG()
      await writeFile(savedFilePath, buffer)
      updateSessionMetadata(state)

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

      const buffer = await state.view.webContents
        .printToPDF({
          printBackground: true
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) throw error
          throw error
        })

      await writeFile(savedFilePath, buffer)
      updateSessionMetadata(state)

      return {
        savedFileName,
        savedFilePath,
        bytesWritten: buffer.byteLength
      }
    },

    dispose() {
      for (const threadMap of threadSessions.values()) {
        for (const state of threadMap.values()) {
          destroySessionState(state)
        }
      }
      threadSessions.clear()
    }
  }
}
