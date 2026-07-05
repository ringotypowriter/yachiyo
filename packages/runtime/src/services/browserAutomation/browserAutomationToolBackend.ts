/**
 * The tool-facing browser-automation surface, split from the Electron
 * implementation so it can cross process boundaries: the agent's browser tool
 * depends only on this interface, every payload is structured-clone-safe, and
 * an RPC-backed implementation (utility process → main) is interchangeable
 * with the in-process Electron one. The UI-facing session-view surface
 * (BrowserWindow/WebContentsView) lives on BrowserAutomationService in
 * electronBrowserAutomationService.ts and never leaves the main process.
 */

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
  id?: string
  role?: string
  name?: string
  testId?: string
  selectorHint?: string
  box?: BrowserAutomationRefBox
}

export interface BrowserAutomationPageText {
  headings: string[]
  snippets: string[]
  viewport?: string
}

export interface BrowserAutomationPageState {
  url: string
  title?: string
}

export interface BrowserAutomationEvaluationResult extends BrowserAutomationPageState {
  value: unknown
}

export type BrowserAutomationScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface BrowserAutomationSnapshot {
  url: string
  title?: string
  pageText: BrowserAutomationPageText
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

export interface BrowserAutomationToolBackend {
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

  scroll(input: {
    threadId: string
    session: string
    direction?: BrowserAutomationScrollDirection
    amount?: number
    ref?: string
  }): Promise<BrowserAutomationPageState>
  goBack(input: { threadId: string; session: string }): Promise<BrowserAutomationPageState>
  goForward(input: { threadId: string; session: string }): Promise<BrowserAutomationPageState>
  click(input: {
    threadId: string
    session: string
    ref: string
  }): Promise<BrowserAutomationPageState>
  fill(input: {
    threadId: string
    session: string
    ref: string
    text: string
  }): Promise<BrowserAutomationPageState>
  type(input: {
    threadId: string
    session: string
    ref: string
    text: string
  }): Promise<BrowserAutomationPageState>
  select(input: {
    threadId: string
    session: string
    ref: string
    value: string
  }): Promise<BrowserAutomationPageState>
  check(input: {
    threadId: string
    session: string
    ref: string
    checked: boolean
  }): Promise<BrowserAutomationPageState>
  press(input: {
    threadId: string
    session: string
    key: string
  }): Promise<BrowserAutomationPageState>

  evaluateScript(input: {
    threadId: string
    session: string
    script: string
    timeoutMs: number
  }): Promise<BrowserAutomationEvaluationResult>

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

export const BROWSER_AUTOMATION_TOOL_METHODS = [
  'open',
  'close',
  'getUrl',
  'getTitle',
  'loadUrl',
  'waitForFunction',
  'snapshot',
  'scroll',
  'goBack',
  'goForward',
  'click',
  'fill',
  'type',
  'select',
  'check',
  'press',
  'evaluateScript',
  'screenshot',
  'pdf'
] as const satisfies readonly (keyof BrowserAutomationToolBackend)[]

// Compile-time completeness: adding a method to the interface without listing
// it above fails this assignment.
type MissingToolMethod = Exclude<
  keyof BrowserAutomationToolBackend,
  (typeof BROWSER_AUTOMATION_TOOL_METHODS)[number]
>
const assertAllToolMethodsListed: [MissingToolMethod] extends [never] ? true : MissingToolMethod =
  true
void assertAllToolMethodsListed
