export interface BrowserAutomationViewportRecord {
  width: number
  height: number
}

export interface BrowserAutomationViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAutomationPointerState {
  x: number
  y: number
  visible: boolean
  label?: string
  updatedAt: string
}

export interface BrowserAutomationActivityBubbleState {
  label: string
  text: string
  meta?: string
}

export interface BrowserAutomationOverlayTheme {
  accentRgb?: string
  accentStrongRgb?: string
  surfaceRgb?: string
  inkRgb?: string
  textMutedRgb?: string
  scrimRgb?: string
}

export interface BrowserAutomationOverlayState {
  activityBubble?: BrowserAutomationActivityBubbleState | null
  theme?: BrowserAutomationOverlayTheme
}

export interface BrowserAutomationSessionRecord {
  threadId: string
  session: string
  url: string
  title?: string
  viewport: BrowserAutomationViewportRecord
  pointer?: BrowserAutomationPointerState
  updatedAt: string
}

export interface ListBrowserAutomationSessionsInput {
  threadId: string
}

export interface ShowBrowserAutomationSessionInput {
  threadId: string
  session: string
  bounds: BrowserAutomationViewBounds
  overlay?: BrowserAutomationOverlayState
}

export interface HideBrowserAutomationSessionInput {
  threadId: string
  session: string
}

export interface SetBrowserAutomationSessionBoundsInput {
  threadId: string
  session: string
  bounds: BrowserAutomationViewBounds
  overlay?: BrowserAutomationOverlayState
}
