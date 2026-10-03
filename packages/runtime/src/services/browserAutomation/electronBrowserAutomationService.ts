import electron from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { buildBrowserAnnotationScript } from './browserAnnotation.ts'
import {
  collectBrowserFrameSnapshots,
  executeBrowserFrameScript,
  framePointToMain,
  type BrowserFrameSnapshotCollection
} from './browserFrameAutomation.ts'
type FrameContext = Omit<BrowserFrameSnapshotCollection['frames'][number], 'snapshot'>
import {
  browserCdp,
  browserRefExpression,
  browserTargetScript,
  clickBrowserPoint,
  pressBrowserKey
} from './browserPageInput.ts'
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
  BrowserAutomationRef,
  BrowserAutomationSnapshot,
  BrowserAutomationToolBackend,
  BrowserAutomationViewport
} from './browserAutomationToolBackend.ts'
import { assertNonEmptyScreenshotByteLength } from './browserCaptureValidation.ts'
import { createBrowserPointerOverlay, type BrowserPointerOverlay } from './browserPointerOverlay.ts'
import type {
  ControlBrowserAutomationSessionInput,
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

const snapshotNamespace = randomUUID().slice(0, 12)
let snapshotSequence = 0

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
  controlSession(
    input: ControlBrowserAutomationSessionInput
  ): Promise<BrowserAutomationSessionRecord>

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
  controlledBy: 'agent' | 'user'
  controlVersion: number
  annotationToken?: string
  annotation?: BrowserAutomationSessionRecord['annotation']
  dialog?: BrowserAutomationSessionRecord['dialog']
  download?: BrowserAutomationSessionRecord['download']
  error?: string
  previewOwned: boolean
  mediaPlaying: boolean
  downloads: number
  navigationVersion: number
  invalidated?: boolean
  view: InstanceType<typeof electron.WebContentsView>
  backgroundWindow: InstanceType<typeof electron.BrowserWindow>
  refSummaryById: Map<string, string>
  refFrames: Map<string, FrameContext>
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
  const mutationContext = new AsyncLocalStorage<{ version: number }>()
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
        const updateDownload = (
          status: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
        ): void => {
          state.download = {
            fileName: item.getFilename(),
            state: status,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes()
          }
          state.updatedAt = timestamp()
        }
        updateDownload('progressing')
        item.on('updated', (_event, status) => updateDownload(status))
        item.once('done', (_event, status) => {
          state.downloads--
          updateDownload(status)
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
      const execution =
        action === 'eval' || action === 'wait predicate'
          ? state.view.webContents.executeJavaScript(wrapScript(script), true)
          : state.view.webContents.executeJavaScriptInIsolatedWorld(
              999,
              [{ code: wrapScript(script) }],
              true
            )
      result = await execution
    } catch (error) {
      throw normalizeBrowserAutomationScriptExecutionError(error, context)
    }

    assertStateCurrent(state)
    return unwrapBrowserAutomationPageScriptResult<TResult>(result, context)
  }

  function assertStateCurrent(state: ThreadBrowserSessionState): void {
    lifecycle.assertCurrent()
    const mutation = mutationContext.getStore()
    if (mutation && (state.controlledBy === 'user' || mutation.version !== state.controlVersion))
      throw new Error('Browser control is paused for the user. Resume and observe the page again.')
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
      controlledBy: state.controlledBy,
      canGoBack: state.view.webContents.navigationHistory?.canGoBack() ?? false,
      canGoForward: state.view.webContents.navigationHistory?.canGoForward() ?? false,
      loading: state.view.webContents.isLoadingMainFrame(),
      ...(state.error ? { error: state.error } : {}),
      ...(state.annotation ? { annotation: state.annotation } : {}),
      ...(state.dialog ? { dialog: state.dialog } : {}),
      ...(state.download ? { download: state.download } : {}),
      threadId: state.threadId,
      session: state.session,
      url: state.url,
      ...(state.title ? { title: state.title } : {}),
      viewport: state.viewport,
      ...(state.pointer ? { pointer: state.pointer } : {}),
      updatedAt: state.updatedAt
    }
  }

  function detachSessionView(state: ThreadBrowserSessionState, park = true): void {
    const parent = state.attachedWindow ?? state.backgroundWindow
    state.overlay?.detach()
    if (!parent.isDestroyed()) parent.contentView.removeChildView(state.view)
    state.attachedWindow = null
    if (park && !state.invalidated && !state.backgroundWindow.isDestroyed()) {
      state.backgroundWindow.contentView.addChildView(state.view)
      state.view.setBounds({ x: 0, y: 0, ...state.viewport })
    }
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
    if (!state.backgroundWindow.isDestroyed()) state.backgroundWindow.destroy()
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

  async function evaluateRef<T>(
    state: ThreadBrowserSessionState,
    ref: string,
    script: string,
    action: string
  ): Promise<T> {
    assertStateCurrent(state)
    const frame = state.refFrames.get(ref)
    if (!frame) return evaluate<T>(state, script, action)
    const result = await executeBrowserFrameScript(state.view.webContents, frame, script)
    assertStateCurrent(state)
    return result as T
  }

  async function pointAtRef(
    state: ThreadBrowserSessionState,
    sessionName: string,
    ref: string,
    editable = false
  ): Promise<{ x: number; y: number; checked?: boolean }> {
    if (!state.refSummaryById.has(ref))
      throw new Error(`Stale ref "${ref}" for session "${sessionName}". Take a new snapshot.`)
    const deadline = Date.now() + 1_000
    while (true) {
      try {
        const point = await evaluateRef<{ x: number; y: number; checked?: boolean }>(
          state,
          ref,
          browserTargetScript(ref, editable),
          'locate ref'
        )
        const frame = state.refFrames.get(ref)
        const mapped = frame
          ? { ...point, ...(await framePointToMain(state.view.webContents, frame, point)) }
          : point
        setPointer(state, { x: mapped.x, y: mapped.y, visible: true, label: `Yachiyo's Cursor` })
        return mapped
      } catch (error) {
        if (
          Date.now() >= deadline ||
          !(error instanceof Error) ||
          !/covered|not visible/.test(error.message)
        )
          throw error
        await sleep(50)
        assertStateCurrent(state)
      }
    }
  }

  async function enablePageEvents(state: ThreadBrowserSessionState): Promise<void> {
    const contents = state.view.webContents
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    contents.debugger.on('message', (_event, method, parameters) => {
      if (state.invalidated) return
      if (method === 'Page.javascriptDialogOpening') {
        state.dialog = {
          type: String(parameters.type),
          message: String(parameters.message),
          defaultPrompt: String(parameters.defaultPrompt ?? '')
        }
        state.controlledBy = 'user'
        state.controlVersion++
        lifecycle.interrupt(state, new Error('Browser dialog is waiting for the user.'))
      } else if (method === 'Page.javascriptDialogClosed') state.dialog = undefined
      else if (method === 'Runtime.consoleAPICalled' && state.annotationToken) {
        const args = parameters.args as Array<{ value?: unknown }> | undefined
        if (args?.[0]?.value !== state.annotationToken || typeof args[1]?.value !== 'string') return
        try {
          const annotation = JSON.parse(args[1].value) as NonNullable<
            BrowserAutomationSessionRecord['annotation']
          >
          if (
            typeof annotation.text !== 'string' ||
            ![annotation.x, annotation.y, annotation.width, annotation.height].every(
              Number.isFinite
            )
          )
            return
          state.annotation = { ...annotation, text: annotation.text.slice(0, 500) }
          state.annotationToken = undefined
        } catch {
          /* Page-provided annotation payloads are untrusted. */
        }
      }
      state.updatedAt = timestamp()
    })
    await browserCdp(contents, 'Page.enable')
    await browserCdp(contents, 'Runtime.enable')
    // Chromium otherwise drops mouse input for some hidden, newly created pages.
    // This changes page focus only; it never activates a native window.
    await browserCdp(contents, 'Emulation.setFocusEmulationEnabled', {
      enabled: state.controlledBy === 'agent'
    })
  }

  function createPage(
    threadId: string,
    sessionName: string,
    viewport: BrowserAutomationViewport | undefined,
    currentSession: ReturnType<typeof session.fromPath>,
    preferences?: Electron.WebPreferences,
    contents?: Electron.WebContents
  ): ThreadBrowserSessionState {
    const threadMap = getThreadMap(threadId)
    const viewportSize = toViewport(viewport)
    const view = new WebContentsView({
      ...(contents ? { webContents: contents } : {}),
      webPreferences: {
        ...preferences,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        sandbox: true,
        session: currentSession
      }
    })
    view.setBounds({ x: 0, y: 0, ...viewportSize })

    // An unattached WebContentsView has a zero-sized renderer viewport. Keep
    // the same page hosted when its conversation panel is not on screen.
    const backgroundWindow = new BrowserWindow({
      show: false,
      width: viewportSize.width,
      height: viewportSize.height,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { backgroundThrottling: false, sandbox: true }
    })
    backgroundWindow.contentView.addChildView(view)

    const state: ThreadBrowserSessionState = {
      controlledBy: 'agent',
      controlVersion: 0,
      previewOwned:
        previewOwners.has(sessionKey(threadId, sessionName)) &&
        !agentOwners.has(sessionKey(threadId, sessionName)),
      mediaPlaying: false,
      downloads: 0,
      navigationVersion: 0,
      view,
      backgroundWindow,
      refSummaryById: new Map<string, string>(),
      refFrames: new Map(),
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
    view.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      state.navigationVersion++
      if (isMainFrame !== false) {
        state.annotation = undefined
        state.annotationToken = undefined
        state.refSummaryById.clear()
        state.refFrames.clear()
      }
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

    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) state.error = description
    })
    view.webContents.on('did-finish-load', () => {
      state.error = undefined
    })
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

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!/^(https?:|about:blank$)/.test(url)) return { action: 'deny' }
      return {
        action: 'allow',
        createWindow: (options) => {
          let childName: string
          do {
            childName = `tab-${++snapshotSequence}`
          } while (threadMap.has(childName))
          const child = createPage(
            threadId,
            childName,
            state.viewport,
            currentSession,
            options.webPreferences,
            (
              options as Electron.BrowserWindowConstructorOptions & {
                webContents?: Electron.WebContents
              }
            ).webContents
          )
          child.controlledBy = state.controlledBy
          void enablePageEvents(child).catch((error) => {
            child.error = String(error)
          })
          return child.view.webContents
        }
      }
    })
    return state
  }

  async function installAnnotation(state: ThreadBrowserSessionState): Promise<void> {
    state.annotationToken = randomUUID()
    await evaluate(state, buildBrowserAnnotationScript(state.annotationToken), 'annotate')
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
        detachSessionView(state, false)
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

    async controlSession(args) {
      const state = requireSessionState(args.threadId, args.session)
      if (
        state.dialog &&
        !['takeOver', 'close', 'acceptDialog', 'dismissDialog'].includes(args.action)
      )
        throw new Error('Handle the pending browser dialog before resuming or navigating.')
      if (args.action === 'takeOver' || args.action === 'resume') {
        state.controlledBy = args.action === 'takeOver' ? 'user' : 'agent'
        state.controlVersion++
        state.refSummaryById.clear()
        lifecycle.interrupt(
          args,
          new Error('Browser control changed; pending automation is paused.')
        )
        if (!state.dialog)
          await browserCdp(state.view.webContents, 'Emulation.setFocusEmulationEnabled', {
            enabled: state.controlledBy === 'agent'
          })
        setPointer(state, null)
        if (args.action === 'resume' && state.annotationToken) {
          state.annotationToken = undefined
          await lifecycle.run(args, () =>
            evaluate(state, 'globalThis.__yachiyoCancelAnnotation?.()', 'cancel annotation')
          )
        }
        return toSessionRecord(state)
      }
      if (args.action === 'close') {
        const record = toSessionRecord(state)
        lifecycle.invalidate(args, new Error('Browser session closed by user.'))
        await rawOperations.close(args)
        return record
      }
      if (args.action === 'acceptDialog' || args.action === 'dismissDialog') {
        await browserCdp(state.view.webContents, 'Page.handleJavaScriptDialog', {
          accept: args.action === 'acceptDialog',
          promptText: args.text ?? ''
        })
        state.dialog = undefined
        return toSessionRecord(state)
      }
      state.controlledBy = 'user'
      state.controlVersion++
      lifecycle.interrupt(args, new Error('Browser control changed; pending automation is paused.'))
      return lifecycle.run(args, async () => {
        if (args.action === 'navigate') {
          const url = new URL(args.url ?? '')
          if (!['http:', 'https:'].includes(url.protocol))
            throw new Error('Browser address must use HTTP or HTTPS.')
          await rawOperations.loadUrl({ ...args, url: url.href })
        } else if (args.action === 'reload') {
          await rawOperations.loadUrl({ ...args, url: state.view.webContents.getURL() })
        } else if (args.action === 'back') await rawOperations.goBack(args)
        else if (args.action === 'forward') await rawOperations.goForward(args)
        else if (args.action === 'annotate') {
          state.annotation = undefined
          await installAnnotation(state)
        }
        updateSessionMetadata(state)
        return toSessionRecord(state)
      })
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

      const state = createPage(threadId, sessionName, viewport, currentSession)
      const view = state.view
      await view.webContents.loadURL('about:blank')
      await enablePageEvents(state)

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

    async snapshot({ threadId, session: sessionName, maxRefs, query, scopeRef }) {
      const state = requireSessionState(threadId, sessionName)
      if (state.dialog)
        return {
          url: state.url,
          title: state.title,
          refs: [],
          refCount: 0,
          pageText: {
            headings: [],
            snippets: [`Waiting for user: ${state.dialog.type}: ${state.dialog.message}`]
          }
        }
      const limit = typeof maxRefs === 'number' && maxRefs > 0 ? Math.min(maxRefs, 200) : 60
      const generation = `s${snapshotNamespace}-${++snapshotSequence}`
      const scopedFrame = scopeRef ? state.refFrames.get(scopeRef) : undefined
      const script = buildBrowserAutomationSnapshotScript(limit, { generation, query, scopeRef })
      const result = scopedFrame
        ? await evaluateRef<BrowserAutomationSnapshot>(state, scopeRef!, script, 'snapshot')
        : await evaluate<BrowserAutomationSnapshot>(state, script, 'snapshot')
      assertStateCurrent(state)
      state.refSummaryById.clear()
      state.refFrames.clear()
      if (scopedFrame) for (const ref of result.refs) state.refFrames.set(ref.ref, scopedFrame)
      else if (result.inaccessibleFrames && result.refs.length < limit) {
        try {
          const frames = await collectBrowserFrameSnapshots(state.view.webContents, {
            generation,
            maxRefs: limit - result.refs.length,
            query
          })
          assertStateCurrent(state)
          for (const frame of frames.frames) {
            for (const ref of frame.snapshot.refs.slice(0, limit - result.refs.length)) {
              result.refs.push(ref)
              state.refFrames.set(ref.ref, frame)
            }
            result.pageText.snippets.push(
              ...frame.snapshot.pageText.headings,
              ...frame.snapshot.pageText.snippets
            )
          }
          result.inaccessibleFrames = frames.unavailableFrames.length
          if (frames.frames.length)
            result.pageText.viewport = result.pageText.viewport?.replace(
              /\[Cross-origin frames inaccessible:[^\]]*\]\s*/,
              ''
            )
          if (frames.unavailableFrames.length)
            result.pageText.snippets.push(
              `${frames.unavailableFrames.length} embedded frame(s) could not be inspected.`
            )
          result.pageText.snippets = result.pageText.snippets.slice(0, 24)
        } catch (error) {
          assertStateCurrent(state)
          result.pageText.snippets.push(
            `Embedded frame observation unavailable: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      for (const ref of result.refs) state.refSummaryById.set(ref.ref, formatRefSummary(ref))
      if (scopedFrame) {
        result.url = state.view.webContents.getURL()
        result.title = state.view.webContents.getTitle()
      }
      updateSessionMetadata(state, { url: result.url, title: result.title })
      return {
        ...result,
        refCount: result.refs.length,
        tabs: service
          .listSessions({ threadId })
          .map(({ session, url, title }) => ({ session, url, title }))
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
      const webContents = state.view.webContents.navigationHistory
      if (!webContents?.canGoBack()) {
        updateSessionMetadata(state)
        return pageState(state)
      }
      return waitForHistoryNavigation(state, () => webContents.goBack?.())
    },

    async goForward({ threadId, session: sessionName }) {
      const state = requireSessionState(threadId, sessionName)
      const webContents = state.view.webContents.navigationHistory
      if (!webContents?.canGoForward()) {
        updateSessionMetadata(state)
        return pageState(state)
      }
      return waitForHistoryNavigation(state, () => webContents.goForward?.())
    },

    async click({ threadId, session: sessionName, ref }) {
      const state = requireSessionState(threadId, sessionName)
      const point = await pointAtRef(state, sessionName, ref)
      await clickBrowserPoint(
        state.view.webContents,
        { x: point.x, y: point.y },
        () => assertStateCurrent(state),
        () => pointAtRef(state, sessionName, ref)
      )
      return settleAndUpdate(state)
    },

    async fill({ threadId, session: sessionName, ref, text }) {
      const state = requireSessionState(threadId, sessionName)
      await pointAtRef(state, sessionName, ref, true)
      const semantic = await evaluateRef<boolean>(
        state,
        ref,
        `(() => {
        const node = ${browserRefExpression(ref)}
        node.focus()
        if (node.tagName === 'INPUT') {
          const value = ${JSON.stringify(text)}
          if (['date','time','month','week','datetime-local','color','range'].includes(node.type)) {
            const view = node.ownerDocument.defaultView
            Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype,'value').set.call(node,value)
            if (node.value !== value) throw new Error('Input rejected the requested value or format.')
            node.dispatchEvent(new view.Event('input',{bubbles:true})); node.dispatchEvent(new view.Event('change',{bubbles:true}))
            return true
          }
          if (['file','checkbox','radio','button','submit','reset','image','hidden'].includes(node.type)) throw new Error('Input does not accept text filling.')
        }
        if (typeof node.select === 'function') node.select()
        else { const range = node.ownerDocument.createRange(); range.selectNodeContents(node); const selection = node.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range) }
        return false
      })()`,
        'select input'
      )
      if (!semantic) await browserCdp(state.view.webContents, 'Input.insertText', { text })
      return settleAndUpdate(state)
    },

    async type({ threadId, session: sessionName, ref, text }) {
      const state = requireSessionState(threadId, sessionName)
      await pointAtRef(state, sessionName, ref, true)
      await evaluateRef(
        state,
        ref,
        `(() => { const node = ${browserRefExpression(ref)}; node.focus(); if (typeof node.setSelectionRange === 'function') { try {node.setSelectionRange(node.value.length,node.value.length)} catch {} } })()`,
        'focus input'
      )
      for (const character of text) {
        assertStateCurrent(state)
        if (character.length === 1)
          await pressBrowserKey(
            state.view.webContents,
            character === '\n' ? 'Enter' : character,
            () => assertStateCurrent(state)
          )
        else await browserCdp(state.view.webContents, 'Input.insertText', { text: character })
      }
      return settleAndUpdate(state)
    },

    async select({ threadId, session: sessionName, ref, value }) {
      const state = requireSessionState(threadId, sessionName)
      await pointAtRef(state, sessionName, ref)
      await evaluateRef(
        state,
        ref,
        `(() => {
        const node = ${browserRefExpression(ref)}
        if (node.tagName !== 'SELECT') throw new Error('Target is not a select element.')
        const option = [...node.options].find(option => option.value === ${JSON.stringify(value)})
        if (!option || option.disabled || option.parentElement.disabled) throw new Error('Option is unavailable or disabled.')
        node.value = option.value
        const Event = node.ownerDocument.defaultView.Event
        node.dispatchEvent(new Event('input', {bubbles:true})); node.dispatchEvent(new Event('change', {bubbles:true}))
      })()`,
        'select'
      )
      return settleAndUpdate(state)
    },

    async check({ threadId, session: sessionName, ref, checked }) {
      const state = requireSessionState(threadId, sessionName)
      const point = await pointAtRef(state, sessionName, ref)
      if (typeof point.checked !== 'boolean')
        throw new Error('Target is not a checkbox or radio input.')
      if (point.checked !== checked)
        await clickBrowserPoint(
          state.view.webContents,
          { x: point.x, y: point.y },
          () => assertStateCurrent(state),
          () => pointAtRef(state, sessionName, ref)
        )
      const value = await evaluateRef<boolean>(
        state,
        ref,
        `(() => {const node = ${browserRefExpression(ref)}; return 'checked' in node ? node.checked : node.getAttribute('aria-checked') === 'true'})()`,
        'verify check'
      )
      if (value !== checked) throw new Error('The page did not accept the checked state.')
      return settleAndUpdate(state)
    },

    async press({ threadId, session: sessionName, key }) {
      const state = requireSessionState(threadId, sessionName)
      await pressBrowserKey(state.view.webContents, key, () => assertStateCurrent(state))
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
      const image = await browserCdp<{ data: string }>(
        state.view.webContents,
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        }
      )
      assertStateCurrent(state)
      const buffer = Buffer.from(image.data, 'base64')
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
  const rawOperations = { ...service }
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
        const readOnly = ['getUrl', 'getTitle', 'snapshot', 'screenshot', 'pdf'].includes(method)
        if (state?.dialog && !['getUrl', 'getTitle', 'snapshot', 'close'].includes(method))
          return Promise.reject(new Error('Handle the pending browser dialog before continuing.'))
        const version = state?.controlVersion ?? 0
        if (!readOnly && state?.controlledBy === 'user')
          return Promise.reject(
            new Error('Browser control is paused for the user. Resume automation first.')
          )
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
        return lifecycle.run(deadlineInput, () =>
          readOnly ? operation(args) : mutationContext.run({ version }, () => operation(args))
        )
      }
    })
  }
  return service
}
