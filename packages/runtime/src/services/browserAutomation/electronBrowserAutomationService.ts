import electron from 'electron'
import {
  BROWSER_PREVIEW_INSPECTION_SCRIPT,
  inspectBrowserPreviewFrames,
  releaseBrowserPreview
} from './browserPreviewRetention.ts'
import { createBrowserOperationLifecycle } from './browserOperationLifecycle.ts'
import { BROWSER_AUTOMATION_TOOL_METHODS } from './browserAutomationToolBackend.ts'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveElectronSessionProxyConfig } from '../webSearch/electronProxyConfig.ts'
import {
  normalizeBrowserAutomationScriptExecutionError,
  wrapBrowserAutomationPageEvalScript,
  unwrapBrowserAutomationPageScriptResult,
  wrapBrowserAutomationPageScript
} from './browserAutomationScriptEvaluation.ts'
import { loadUrlSettlingReplacementNavigation } from './browserNavigationSettlement.ts'
import { buildBrowserAutomationSnapshotScript } from './browserAutomationSnapshotScript.ts'
import type {
  BrowserAutomationPageState,
  BrowserAutomationPageText,
  BrowserAutomationRef,
  BrowserAutomationToolBackend,
  BrowserAutomationViewport
} from './browserAutomationToolBackend.ts'
import { assertNonEmptyScreenshotByteLength } from './browserCaptureValidation.ts'
import { createBrowserPointerOverlay, type BrowserPointerOverlay } from './browserPointerOverlay.ts'
import type {
  BrowserPreviewReadingState,
  ReleaseBrowserPreviewInput,
  ReleaseBrowserPreviewResult,
  BrowserAutomationPointerState,
  BrowserAutomationSessionRecord,
  BrowserAutomationViewBounds,
  HideBrowserAutomationSessionInput,
  ListBrowserAutomationSessionsInput,
  SetBrowserAutomationSessionBoundsInput,
  ShowBrowserAutomationSessionInput
} from '@yachiyo/shared/protocol'

const DEFAULT_WAIT_POLL_INTERVAL_MS = 100
const INTERACTION_SETTLE_MS = 250
const HISTORY_NAVIGATION_TIMEOUT_MS = 5_000
const IDLE_SESSION_TTL_MS = 30 * 60 * 1000
const IDLE_SESSION_SWEEP_MS = 5 * 60 * 1000

export type {
  BrowserAutomationEvaluationResult,
  BrowserAutomationPageState,
  BrowserAutomationPageText,
  BrowserAutomationPdfResult,
  BrowserAutomationRef,
  BrowserAutomationRefBox,
  BrowserAutomationScreenshotResult,
  BrowserAutomationScrollDirection,
  BrowserAutomationSnapshot,
  BrowserAutomationViewport
} from './browserAutomationToolBackend.ts'

/**
 * The full main-process service: the process-portable tool surface plus the
 * session-view UI surface, which handles live BrowserWindow/WebContentsView
 * objects and therefore never crosses a process boundary.
 */
export interface BrowserAutomationService extends BrowserAutomationToolBackend {
  openPreview(input: {
    threadId: string
    session: string
    url: string
    reading?: BrowserPreviewReadingState
  }): Promise<BrowserAutomationSessionRecord>
  releasePreview(input: ReleaseBrowserPreviewInput): Promise<ReleaseBrowserPreviewResult>
  listSessions(input: ListBrowserAutomationSessionsInput): BrowserAutomationSessionRecord[]

  showSessionView(
    input: ShowBrowserAutomationSessionInput & {
      window: InstanceType<typeof electron.BrowserWindow>
    }
  ): BrowserAutomationSessionRecord

  hideSessionView(input: HideBrowserAutomationSessionInput): void

  setSessionViewBounds(
    input: SetBrowserAutomationSessionBoundsInput
  ): BrowserAutomationSessionRecord

  dispose(): void
}

interface ThreadBrowserSessionState {
  previewOwned: boolean
  mediaPlaying: boolean
  downloads: number
  navigationVersion: number
  invalidated?: boolean
  view: InstanceType<typeof electron.WebContentsView>
  refXpathById: Map<string, string>
  refSummaryById: Map<string, string>
  threadId: string
  session: string
  viewport: BrowserAutomationViewport
  url: string
  title?: string
  pointer: BrowserAutomationPointerState | null
  overlay: BrowserPointerOverlay | null
  attachedWindow: InstanceType<typeof electron.BrowserWindow> | null
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pageState(state: ThreadBrowserSessionState): BrowserAutomationPageState {
  return { url: state.url, ...(state.title ? { title: state.title } : {}) }
}

function normalizeScrollAmount(amount: number | undefined): number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 720
}

function formatRefSummary(ref: BrowserAutomationRef): string {
  const bits = [
    ref.text,
    ref.ariaLabel ? `aria=${ref.ariaLabel}` : undefined,
    ref.placeholder ? `placeholder=${ref.placeholder}` : undefined,
    ref.href,
    ref.id ? `id=${ref.id}` : undefined,
    ref.role ? `role=${ref.role}` : undefined,
    ref.name ? `name=${ref.name}` : undefined,
    ref.testId ? `data-testid=${ref.testId}` : undefined,
    ref.selectorHint
  ].filter((bit): bit is string => Boolean(bit))
  return `<${ref.tag}>${bits.length > 0 ? ` ${bits.join(' | ')}` : ''}`
}

export function createElectronBrowserAutomationService(input: {
  profilePath: string
  /** Test seam: no Electron process is required for lifecycle tests. */
  electron?: typeof electron
  operationTimeoutMs?: number
}): BrowserAutomationService {
  const { BrowserWindow, WebContentsView, session } = input.electron ?? electron
  const lifecycle = createBrowserOperationLifecycle(({ threadId, session: name }) => {
    const map = threadSessions.get(threadId)
    const state = map?.get(name)
    if (state) {
      map?.delete(name)
      destroySessionState(state)
    }
  }, input.operationTimeoutMs)
  const threadSessions = new Map<string, Map<string, ThreadBrowserSessionState>>()
  let browserSession: ReturnType<typeof session.fromPath> | undefined
  let proxyReady: Promise<void> | undefined
  const previewOwners = new Set<string>()
  const agentOwners = new Set<string>()
  const previewOpening = new Set<string>()
  const discardedPreviews = new Map<
    string,
    { url: string; title?: string; reading?: BrowserPreviewReadingState }
  >()
  const sessionKey = (threadId: string, session: string): string =>
    JSON.stringify([threadId, session])
  const idleSweep = setInterval(() => {
    const now = Date.now()
    for (const [threadId, threadMap] of threadSessions) {
      for (const [name, state] of threadMap) {
        const updatedAt = Date.parse(state.updatedAt)
        if (state.attachedWindow || !Number.isFinite(updatedAt)) continue
        if (now - updatedAt <= IDLE_SESSION_TTL_MS) continue
        void service.releasePreview({ threadId, session: name, mode: 'auto' })
      }
      if (threadMap.size === 0) {
        threadSessions.delete(threadId)
      }
    }
  }, IDLE_SESSION_SWEEP_MS)
  idleSweep.unref?.()

  function getThreadMap(threadId: string): Map<string, ThreadBrowserSessionState> {
    const existing = threadSessions.get(threadId)
    if (existing) return existing
    const created = new Map<string, ThreadBrowserSessionState>()
    threadSessions.set(threadId, created)
    return created
  }

  function onDownload(
    _event: Electron.Event,
    item: Electron.DownloadItem,
    contents: Electron.WebContents
  ): void {
    for (const sessions of threadSessions.values())
      for (const state of sessions.values()) {
        if (state.view.webContents !== contents) continue
        state.downloads++
        item.once('done', () => {
          state.downloads--
        })
      }
  }

  function getBrowserSession(): ReturnType<typeof session.fromPath> {
    if (
      typeof session?.fromPath !== 'function' ||
      typeof BrowserWindow !== 'function' ||
      typeof WebContentsView !== 'function'
    ) {
      throw new Error('Browser automation is only available inside the Electron app.')
    }

    if (!browserSession) {
      browserSession = session.fromPath(input.profilePath, { cache: true })
      browserSession.on?.('will-download', onDownload)
    }
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
    lifecycle.assertCurrent()
    return currentSession
  }

  function requireSessionState(threadId: string, name: string): ThreadBrowserSessionState {
    lifecycle.assertCurrent()
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
    script: string,
    action?: string,
    wrapScript: (script: string) => string = wrapBrowserAutomationPageScript
  ): Promise<TResult> {
    assertStateCurrent(state)
    const url = state.url || state.view.webContents.getURL() || undefined
    const context = {
      ...(action ? { action } : {}),
      session: state.session,
      ...(url ? { url } : {})
    }

    let result: unknown
    try {
      const execution = state.view.webContents.executeJavaScript(wrapScript(script), true)
      result = await execution
    } catch (error) {
      throw normalizeBrowserAutomationScriptExecutionError(error, context)
    }

    assertStateCurrent(state)
    return unwrapBrowserAutomationPageScriptResult<TResult>(result, context)
  }

  function assertStateCurrent(state: ThreadBrowserSessionState): void {
    lifecycle.assertCurrent()
    if (state.invalidated)
      throw new Error(`Browser session "${state.session}" is invalidated. Re-open it.`)
  }

  function updateSessionMetadata(
    state: ThreadBrowserSessionState,
    metadata: { url?: string; title?: string; viewport?: BrowserAutomationViewport } = {}
  ): void {
    assertStateCurrent(state)
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
    if (state.invalidated) return
    state.invalidated = true
    previewOwners.delete(sessionKey(state.threadId, state.session))
    agentOwners.delete(sessionKey(state.threadId, state.session))
    lifecycle.invalidate(
      state,
      new Error(`Browser session "${state.session}" was destroyed. Re-open it.`)
    )
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
    assertStateCurrent(state)
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
      const summary = state.refSummaryById.get(ref)
      throw new Error(
        `Unknown ref "${ref}" for session "${sessionName}"${summary ? ` (${summary})` : ''}. Call useBrowser({ action: "snapshot" }) and use the latest refs.`
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
      })()`,
      'locate ref'
    )
    setPointer(state, { x: point.x, y: point.y, visible: true, label: `Yachiyo's Cursor` })
    return xpath
  }

  async function settleAndUpdate(
    state: ThreadBrowserSessionState
  ): Promise<BrowserAutomationPageState> {
    await sleep(INTERACTION_SETTLE_MS)
    updateSessionMetadata(state)
    return pageState(state)
  }

  async function waitForHistoryNavigation(
    state: ThreadBrowserSessionState,
    navigate: () => void
  ): Promise<BrowserAutomationPageState> {
    const webContents = state.view.webContents
    const initialUrl = webContents.getURL()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              `Timed out after ${HISTORY_NAVIGATION_TIMEOUT_MS}ms waiting for history navigation.`
            )
          ),
        HISTORY_NAVIGATION_TIMEOUT_MS
      )

      const cleanup = (): void => {
        webContents.off('did-navigate', onNavigated)
        webContents.off('did-navigate-in-page', onNavigated)
        webContents.off('did-fail-load', onFailed)
        webContents.off('did-stop-loading', onStoppedLoading)
        clearTimeout(timeout)
      }

      const finish = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const onNavigated = (): void => finish()
      const onStoppedLoading = (): void => {
        if (webContents.getURL() !== initialUrl) finish()
      }
      const onFailed = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedUrl: string,
        isMainFrame: boolean
      ): void => {
        if (!isMainFrame) return
        fail(new Error(`Navigation failed for ${validatedUrl}: ${errorDescription} (${errorCode})`))
      }

      webContents.on('did-navigate', onNavigated)
      webContents.on('did-navigate-in-page', onNavigated)
      webContents.on('did-fail-load', onFailed)
      webContents.on('did-stop-loading', onStoppedLoading)

      try {
        navigate()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })

    updateSessionMetadata(state)
    return pageState(state)
  }

  function purgeDestroyedSessions(threadMap: Map<string, ThreadBrowserSessionState>): void {
    for (const [name, state] of threadMap) {
      if (state.view.webContents.isDestroyed()) {
        destroySessionState(state)
        threadMap.delete(name)
      }
    }
  }

  const service: BrowserAutomationService = {
    async openPreview(args) {
      const key = sessionKey(args.threadId, args.session)
      const existing = threadSessions.get(args.threadId)?.get(args.session)
      if (existing && !existing.view.webContents.isDestroyed()) return toSessionRecord(existing)
      const saved = discardedPreviews.get(key)
      if (saved) args = { ...args, url: saved.url, reading: saved.reading }
      if (!agentOwners.has(key)) previewOwners.add(key)
      previewOpening.add(key)
      let created = false
      try {
        await lifecycle.run(args, async () => {
          const current = threadSessions.get(args.threadId)?.get(args.session)
          if (current && !current.invalidated) return pageState(current)
          created = true
          return openPreviewRaw(args)
        })
        const state = requireSessionState(args.threadId, args.session)
        const contents = state.view.webContents
        if (created && state.previewOwned && args.reading?.webZoom)
          contents.setZoomFactor(args.reading.webZoom)
        if (created && state.previewOwned && args.reading)
          await lifecycle.run(args, () =>
            contents.executeJavaScript(
              `window.scrollTo(${Number(args.reading?.webScrollX) || 0}, ${Number(args.reading?.webScrollY) || 0})`
            )
          )
        discardedPreviews.delete(key)
        return toSessionRecord(state)
      } finally {
        previewOpening.delete(key)
      }
    },
    async releasePreview(args) {
      const map = threadSessions.get(args.threadId)
      const state = map?.get(args.session)
      const key = sessionKey(args.threadId, args.session)
      if (args.mode === 'close') discardedPreviews.delete(key)
      if (!state) {
        if (args.mode === 'close' && previewOwners.has(key))
          lifecycle.invalidate(args, new Error('Browser preview closed'))
        previewOwners.delete(key)
        return { released: true }
      }
      const contents = state.view.webContents
      const metadata = { url: state.url, title: state.title }
      const revision = state.navigationVersion
      const result = await releaseBrowserPreview(
        {
          protected: () =>
            !state.previewOwned ||
            previewOpening.has(key) ||
            !!state.attachedWindow ||
            state.mediaPlaying ||
            state.downloads > 0 ||
            typeof browserSession?.on !== 'function' ||
            contents.isLoadingMainFrame(),
          shared: () => !state.previewOwned,
          current: () =>
            map?.get(args.session) === state &&
            !state.invalidated &&
            state.navigationVersion === revision,
          inspect: () =>
            inspectBrowserPreviewFrames(
              contents.mainFrame.framesInSubtree,
              contents.getZoomFactor()
            ),
          detach: () => detachSessionView(state),
          destroy: () => {
            map?.delete(args.session)
            destroySessionState(state)
          }
        },
        args.mode
      )
      if (result.released && args.mode === 'auto')
        discardedPreviews.set(key, { ...metadata, reading: result.reading })
      return { ...result, ...metadata }
    },
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
          const finalUrl = await loadUrlSettlingReplacementNavigation(
            existing.view.webContents,
            url
          )
          updateSessionMetadata(existing, { url: finalUrl })
        } else {
          updateSessionMetadata(existing)
        }
        return {
          url: existing.url,
          ...(existing.title ? { title: existing.title } : {})
        }
      }

      if (existing) {
        destroySessionState(existing)
        threadMap.delete(sessionName)
        // Destruction also invalidates this generation; do not create a zombie view.
        lifecycle.assertCurrent()
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
        previewOwned:
          previewOwners.has(sessionKey(threadId, sessionName)) &&
          !agentOwners.has(sessionKey(threadId, sessionName)),
        mediaPlaying: false,
        downloads: 0,
        navigationVersion: 0,
        view,
        refXpathById: new Map<string, string>(),
        refSummaryById: new Map<string, string>(),
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
      view.webContents.on('media-started-playing', () => {
        state.mediaPlaying = true
      })
      view.webContents.on('did-start-navigation', () => {
        state.navigationVersion++
      })
      view.webContents.on('frame-created', () => {
        state.navigationVersion++
      })
      view.webContents.on('media-paused', () => {
        state.mediaPlaying = false
      })
      const trackDirtyFrames = (): void => {
        if (!state.previewOwned || state.invalidated) return
        for (const frame of view.webContents.mainFrame?.framesInSubtree ?? []) {
          void frame.executeJavaScript(BROWSER_PREVIEW_INSPECTION_SCRIPT).catch(() => {})
        }
      }
      view.webContents.on('dom-ready', trackDirtyFrames)
      view.webContents.on('did-frame-finish-load', trackDirtyFrames)

      view.webContents.on('did-navigate', (_event, navigatedUrl) => {
        if (!state.invalidated) updateSessionMetadata(state, { url: navigatedUrl })
      })
      view.webContents.on('did-navigate-in-page', (_event, navigatedUrl) => {
        if (!state.invalidated) updateSessionMetadata(state, { url: navigatedUrl })
      })
      view.webContents.on('page-title-updated', (_event, title) => {
        if (!state.invalidated) updateSessionMetadata(state, { title })
      })
      view.webContents.once('render-process-gone', () => {
        if (threadMap.get(sessionName) === state) {
          lifecycle.invalidate(state, new Error('Browser renderer crashed. Re-open the session.'))
        }
      })
      view.webContents.once('destroyed', () => {
        if (threadMap.get(sessionName) === state) {
          threadMap.delete(sessionName)
          destroySessionState(state)
        }
      })

      if (url) {
        const finalUrl = await loadUrlSettlingReplacementNavigation(view.webContents, url)
        updateSessionMetadata(state, { url: finalUrl })
      } else {
        updateSessionMetadata(state)
      }

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
      const finalUrl = await loadUrlSettlingReplacementNavigation(state.view.webContents, url)
      updateSessionMetadata(state, { url: finalUrl })
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

        const matched = await evaluate<boolean>(state, predicate, 'wait predicate')
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
        pageText: BrowserAutomationPageText
        refs: Array<Omit<BrowserAutomationRef, 'ref'> & { xpath: string }>
      }>(state, buildBrowserAutomationSnapshotScript(limit), 'snapshot')

      assertStateCurrent(state)
      state.refXpathById.clear()
      state.refSummaryById.clear()
      const refs: BrowserAutomationRef[] = []
      for (let i = 0; i < result.refs.length; i++) {
        const ref = `e${i + 1}`
        const item = result.refs[i]!
        if (item.xpath) {
          state.refXpathById.set(ref, item.xpath)
        }
        const automationRef: BrowserAutomationRef = {
          ref,
          tag: item.tag,
          ...(item.text ? { text: item.text } : {}),
          ...(item.ariaLabel ? { ariaLabel: item.ariaLabel } : {}),
          ...(item.placeholder ? { placeholder: item.placeholder } : {}),
          ...(item.href ? { href: item.href } : {}),
          ...(item.id ? { id: item.id } : {}),
          ...(item.role ? { role: item.role } : {}),
          ...(item.name ? { name: item.name } : {}),
          ...(item.testId ? { testId: item.testId } : {}),
          ...(item.selectorHint ? { selectorHint: item.selectorHint } : {}),
          ...(item.box ? { box: item.box } : {})
        }
        state.refSummaryById.set(ref, formatRefSummary(automationRef))
        refs.push(automationRef)
      }

      updateSessionMetadata(state, { url: result.url, title: result.title })
      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        pageText: result.pageText,
        refCount: refs.length,
        refs
      }
    },

    async scroll({ threadId, session: sessionName, direction, amount, ref }) {
      const state = requireSessionState(threadId, sessionName)
      if (ref) {
        await pointAtRef(state, sessionName, ref)
      }
      const distance = normalizeScrollAmount(amount)
      const resolvedDirection = direction ?? 'down'
      await evaluate<void>(
        state,
        `(() => {
          const direction = ${JSON.stringify(resolvedDirection)}
          const amount = ${JSON.stringify(distance)}
          const delta = {
            up: { left: 0, top: -amount },
            down: { left: 0, top: amount },
            left: { left: -amount, top: 0 },
            right: { left: amount, top: 0 }
          }[direction] || { left: 0, top: amount }
          window.scrollBy({ ...delta, behavior: 'instant' })
        })()`,
        'scroll'
      )
      return settleAndUpdate(state)
    },

    async goBack({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      const webContents = state.view.webContents as typeof state.view.webContents & {
        canGoBack?: () => boolean
        goBack?: () => void
      }
      if (!webContents.canGoBack?.()) {
        updateSessionMetadata(state)
        return pageState(state)
      }
      return waitForHistoryNavigation(state, () => webContents.goBack?.())
    },

    async goForward({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      const webContents = state.view.webContents as typeof state.view.webContents & {
        canGoForward?: () => boolean
        goForward?: () => void
      }
      if (!webContents.canGoForward?.()) {
        updateSessionMetadata(state)
        return pageState(state)
      }
      return waitForHistoryNavigation(state, () => webContents.goForward?.())
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
        })()`,
        'click'
      )
      return settleAndUpdate(state)
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
        })()`,
        'fill'
      )
      return settleAndUpdate(state)
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
        })()`,
        'type'
      )
      return settleAndUpdate(state)
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
        })()`,
        'select'
      )
      return settleAndUpdate(state)
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
        })()`,
        'check'
      )
      return settleAndUpdate(state)
    },

    async press({ threadId, session: sessionName, key }) {
      const state = requireSessionState(threadId, sessionName)
      const parts = key
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean)
      const keyCode = parts.pop() ?? key
      const modifiers = parts
        .map((part) => part.toLowerCase())
        .map((part) => (part === 'ctrl' ? 'control' : part === 'cmd' ? 'meta' : part))
        .filter(
          (part): part is 'shift' | 'control' | 'alt' | 'meta' =>
            part === 'shift' || part === 'control' || part === 'alt' || part === 'meta'
        )
      state.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      state.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      return settleAndUpdate(state)
    },

    async evaluateScript({ threadId, session: sessionName, script }) {
      const state = requireSessionState(threadId, sessionName)
      const value = await evaluate<unknown>(
        state,
        script,
        'eval',
        wrapBrowserAutomationPageEvalScript
      )
      const result = await settleAndUpdate(state)
      return { ...result, value }
    },

    async screenshot({ threadId, session: sessionName, workspacePath, fileName }) {
      const state = requireSessionState(threadId, sessionName)
      const pngName = ensureFileName(fileName ?? 'browser', 'png')
      const savedFileName = join('.yachiyo', 'tool-result', pngName)
      const savedFilePath = toolResultPath(workspacePath, pngName)

      await mkdir(dirname(savedFilePath), { recursive: true })
      assertStateCurrent(state)
      const image = await state.view.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true
      })
      assertStateCurrent(state)
      const buffer = image.toPNG()
      assertNonEmptyScreenshotByteLength(buffer.byteLength)
      assertStateCurrent(state)
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

      assertStateCurrent(state)
      const buffer = await state.view.webContents
        .printToPDF({
          printBackground: true
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) throw error
          throw error
        })

      assertStateCurrent(state)
      await writeFile(savedFilePath, buffer)
      updateSessionMetadata(state)

      return {
        savedFileName,
        savedFilePath,
        bytesWritten: buffer.byteLength
      }
    },

    dispose() {
      lifecycle.dispose()
      clearInterval(idleSweep)
      browserSession?.removeListener?.('will-download', onDownload)
      for (const threadMap of threadSessions.values()) {
        for (const state of threadMap.values()) {
          destroySessionState(state)
        }
      }
      threadSessions.clear()
      discardedPreviews.clear()
      previewOwners.clear()
      agentOwners.clear()
    }
  }
  const openPreviewRaw = service.open.bind(service)
  for (const method of BROWSER_AUTOMATION_TOOL_METHODS) {
    const operation = service[method].bind(service) as (args: {
      threadId: string
      session: string
    }) => Promise<unknown>
    Object.assign(service, {
      [method]: (args: {
        threadId: string
        session: string
        timeoutMs?: number
        signal?: AbortSignal
      }) => {
        previewOwners.delete(sessionKey(args.threadId, args.session))
        agentOwners.add(sessionKey(args.threadId, args.session))
        const state = threadSessions.get(args.threadId)?.get(args.session)
        if (state) state.previewOwned = false
        if (method === 'close') {
          lifecycle.invalidate(args, new Error('Browser session closed. Re-open it.'))
          if (!state) agentOwners.delete(sessionKey(args.threadId, args.session))
          return operation(args)
        }
        // Allow healthy wait timeouts and eval's post-script interaction settlement.
        // Eval uses only the main deadline: a page-side race cannot stop user code.
        const deadlineInput =
          (method === 'waitForFunction' || method === 'evaluateScript') && args.timeoutMs
            ? { ...args, timeoutMs: args.timeoutMs + 1_000 }
            : args
        return lifecycle.run(deadlineInput, () => operation(args))
      }
    })
  }
  return service
}
