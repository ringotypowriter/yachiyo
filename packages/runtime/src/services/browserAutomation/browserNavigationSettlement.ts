type DidStartNavigationListener = (
  event: unknown,
  url: string,
  isInPlace: boolean,
  isMainFrame: boolean,
  frameProcessId: number,
  frameRoutingId: number
) => void
type DidNavigateListener = (
  event: unknown,
  url: string,
  httpResponseCode: number,
  httpStatusText: string
) => void
type DidFailLoadListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedUrl: string,
  isMainFrame: boolean,
  frameProcessId: number,
  frameRoutingId: number
) => void
type EmptyNavigationListener = () => void

interface NavigationEventListeners {
  destroyed: EmptyNavigationListener
  'did-fail-load': DidFailLoadListener
  'did-finish-load': EmptyNavigationListener
  'did-navigate': DidNavigateListener
  'did-start-navigation': DidStartNavigationListener
  'did-stop-loading': EmptyNavigationListener
}

interface NavigationWebContents {
  getURL(): string
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  off<TEvent extends keyof NavigationEventListeners>(
    event: TEvent,
    listener: NavigationEventListeners[TEvent]
  ): unknown
  on<TEvent extends keyof NavigationEventListeners>(
    event: TEvent,
    listener: NavigationEventListeners[TEvent]
  ): unknown
}

const DEFAULT_REPLACEMENT_NAVIGATION_SETTLE_TIMEOUT_MS = 15_000

export interface ReplacementNavigationSettlementOptions {
  settleTimeoutMs?: number
}

type ReplacementNavigationOutcome = { status: 'loaded' } | { status: 'failed'; error: Error }

function isElectronNavigationAbort(error: unknown): boolean {
  return error instanceof Error && /\bERR_ABORTED\b/u.test(error.message)
}

export async function loadUrlSettlingReplacementNavigation(
  webContents: NavigationWebContents,
  url: string,
  options: ReplacementNavigationSettlementOptions = {}
): Promise<string> {
  let mainFrameNavigationCount = 0
  let replacementCommitted = false
  let resolveOutcome: (outcome: ReplacementNavigationOutcome) => void = () => {}
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const outcomePromise = new Promise<ReplacementNavigationOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  const onDidStartNavigation = (
    _event: unknown,
    _navigationUrl: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame || isInPlace) return
    mainFrameNavigationCount += 1
    if (mainFrameNavigationCount > 1) {
      replacementCommitted = false
    }
  }
  const onDidNavigate = (): void => {
    if (mainFrameNavigationCount > 1) {
      replacementCommitted = true
    }
  }
  const onDidFailLoad = (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame || mainFrameNavigationCount <= 1) return
    if (errorCode === -3 || errorDescription === 'ERR_ABORTED') return
    resolveOutcome({
      status: 'failed',
      error: new Error(`Navigation failed for ${validatedUrl}: ${errorDescription} (${errorCode})`)
    })
  }
  const onDidFinishLoad = (): void => {
    if (replacementCommitted) {
      resolveOutcome({ status: 'loaded' })
    }
  }
  const onDidStopLoading = (): void => {
    if (replacementCommitted) {
      resolveOutcome({ status: 'loaded' })
    }
  }
  const onDestroyed = (): void => {
    resolveOutcome({
      status: 'failed',
      error: new Error(`Browser contents were destroyed while loading ${url}.`)
    })
  }

  const cleanup = (): void => {
    webContents.off('did-start-navigation', onDidStartNavigation)
    webContents.off('did-navigate', onDidNavigate)
    webContents.off('did-fail-load', onDidFailLoad)
    webContents.off('did-finish-load', onDidFinishLoad)
    webContents.off('did-stop-loading', onDidStopLoading)
    webContents.off('destroyed', onDestroyed)
    if (timeoutId) clearTimeout(timeoutId)
  }

  webContents.on('did-start-navigation', onDidStartNavigation)
  webContents.on('did-navigate', onDidNavigate)
  webContents.on('did-fail-load', onDidFailLoad)
  webContents.on('did-finish-load', onDidFinishLoad)
  webContents.on('did-stop-loading', onDidStopLoading)
  webContents.on('destroyed', onDestroyed)

  try {
    try {
      await webContents.loadURL(url)
      return webContents.getURL() || url
    } catch (error) {
      if (!isElectronNavigationAbort(error) || mainFrameNavigationCount <= 1) {
        throw error
      }
    }

    if (webContents.isDestroyed()) {
      throw new Error(`Browser contents were destroyed while loading ${url}.`)
    }

    const settleTimeoutMs =
      options.settleTimeoutMs ?? DEFAULT_REPLACEMENT_NAVIGATION_SETTLE_TIMEOUT_MS
    const timeoutOutcome = new Promise<ReplacementNavigationOutcome>((resolve) => {
      timeoutId = setTimeout(
        () =>
          resolve({
            status: 'failed',
            error: new Error(
              `Timed out after ${settleTimeoutMs}ms waiting for replacement navigation from ${url}.`
            )
          }),
        settleTimeoutMs
      )
    })
    const outcome = await Promise.race([outcomePromise, timeoutOutcome])
    if (outcome.status === 'failed') throw outcome.error

    const finalUrl = webContents.getURL()
    if (!finalUrl) {
      throw new Error(`Replacement navigation from ${url} completed without a final URL.`)
    }
    return finalUrl
  } finally {
    cleanup()
  }
}
