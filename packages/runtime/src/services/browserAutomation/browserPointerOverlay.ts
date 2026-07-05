import electron from 'electron'

import type {
  BrowserAutomationActivityBubbleState,
  BrowserAutomationOverlayTheme,
  BrowserAutomationPointerState,
  BrowserAutomationViewBounds
} from '@yachiyo/shared/protocol'
import { createLatestWinsRunner } from './latestWinsRunner.ts'

const { BrowserWindow } = electron

const POINTER_OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
  pointer-events: none;
}

#pointer {
  position: absolute;
  z-index: 20;
  top: 0;
  left: 0;
  opacity: 0;
  transform: translate3d(0, 0, 0);
  transition:
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 120ms ease;
  will-change: transform, opacity;
}

#tip {
  position: absolute;
  top: 0;
  left: 0;
  width: 24px;
  height: 24px;
  transform: translate(-2px, -2px);
  color: rgb(var(--overlay-accent-rgb));
  filter: drop-shadow(0 3px 8px rgb(var(--overlay-scrim-rgb) / 0.42));
}

#tip path {
  fill: rgb(var(--overlay-surface-rgb) / 0.96);
  stroke: rgb(var(--overlay-accent-rgb));
  stroke-width: 1.8px;
  stroke-linejoin: round;
}

#ring {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid rgb(var(--overlay-accent-strong-rgb) / 0.72);
  box-shadow: 0 0 0 4px rgb(var(--overlay-accent-rgb) / 0.18);
}

#label {
  position: absolute;
  top: 22px;
  left: 12px;
  max-width: 160px;
  padding: 4px 8px;
  border: 1px solid rgb(var(--overlay-accent-strong-rgb) / 0.28);
  border-radius: 999px;
  background: rgb(var(--overlay-accent-rgb) / 0.88);
  color: rgb(var(--overlay-surface-rgb));
  font: 700 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 6px 18px rgb(var(--overlay-scrim-rgb) / 0.22);
  backdrop-filter: blur(8px);
}

#activity-bubble {
  position: absolute;
  z-index: 10;
  right: 16px;
  bottom: 16px;
  width: min(420px, calc(100vw - 32px));
  max-height: 120px;
  overflow: hidden;
  padding: 10px 12px;
  border: 1px solid rgb(var(--overlay-surface-rgb) / 0.16);
  border-radius: 16px;
  background: rgb(var(--overlay-ink-rgb) / 0.72);
  box-shadow: 0 10px 30px rgb(var(--overlay-scrim-rgb) / 0.28);
  color: rgb(var(--overlay-surface-rgb));
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 150ms ease,
    transform 150ms ease;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

#activity-bubble[data-visible='true'] {
  opacity: 1;
  transform: translateY(0);
}

#activity-label {
  margin-bottom: 4px;
  color: rgb(var(--overlay-text-muted-rgb) / 0.78);
  font: 700 10px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

#activity-text {
  display: -webkit-box;
  overflow: hidden;
  color: rgb(var(--overlay-surface-rgb));
  font: 600 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  white-space: pre-wrap;
}

#activity-meta {
  margin-top: 4px;
  overflow: hidden;
  color: rgb(var(--overlay-text-muted-rgb) / 0.76);
  font: 500 11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
</head>
<body>
  <div id="activity-bubble" aria-live="polite">
    <div id="activity-label"></div>
    <div id="activity-text"></div>
    <div id="activity-meta"></div>
  </div>
  <div id="pointer" aria-hidden="true">
    <div id="ring"></div>
    <svg id="tip" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
    </svg>
    <div id="label"></div>
  </div>
<script>
(() => {
  const pointer = document.getElementById('pointer')
  const label = document.getElementById('label')
  const activityBubble = document.getElementById('activity-bubble')
  const activityLabel = document.getElementById('activity-label')
  const activityText = document.getElementById('activity-text')
  const activityMeta = document.getElementById('activity-meta')
  const setRgbVar = (name, value) => {
    if (typeof value !== 'string') return
    const parts = value.trim().split(' ').filter(Boolean)
    if (parts.length !== 3) return
    const channels = parts.map((part) => Number(part))
    if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return
    document.documentElement.style.setProperty(name, channels.join(' '))
  }
  window.__yachiyoSetTheme = (theme) => {
    if (!theme) return
    setRgbVar('--overlay-accent-rgb', theme.accentRgb)
    setRgbVar('--overlay-accent-strong-rgb', theme.accentStrongRgb)
    setRgbVar('--overlay-surface-rgb', theme.surfaceRgb)
    setRgbVar('--overlay-ink-rgb', theme.inkRgb)
    setRgbVar('--overlay-text-muted-rgb', theme.textMutedRgb)
    setRgbVar('--overlay-scrim-rgb', theme.scrimRgb)
  }
  window.__yachiyoSetPointer = (state) => {
    if (!state || !state.visible) {
      pointer.style.opacity = '0'
      return
    }
    const x = Math.max(0, Math.min(window.innerWidth, Number(state.x) || 0))
    const y = Math.max(0, Math.min(window.innerHeight, Number(state.y) || 0))
    pointer.style.opacity = '1'
    pointer.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)'
    label.textContent = state.label || ''
    label.style.display = state.label ? 'block' : 'none'
  }
  window.__yachiyoSetActivityBubble = (state) => {
    if (!state || !state.text) {
      activityBubble.dataset.visible = 'false'
      return
    }
    activityLabel.textContent = state.label || ''
    activityText.textContent = state.text || ''
    activityMeta.textContent = state.meta || ''
    activityMeta.style.display = state.meta ? 'block' : 'none'
    activityBubble.dataset.visible = 'true'
  }
})()
</script>
</body>
</html>`

export interface BrowserPointerOverlay {
  attachTo: (window: InstanceType<typeof BrowserWindow>) => void
  detach: () => void
  setBounds: (bounds: BrowserAutomationViewBounds) => void
  updateTheme: (theme: BrowserAutomationOverlayTheme | null) => void
  updatePointer: (pointer: BrowserAutomationPointerState | null) => void
  updateActivityBubble: (activityBubble: BrowserAutomationActivityBubbleState | null) => void
  destroy: () => void
}

function parseRgbChannels(value: string | undefined): [number, number, number] | null {
  if (typeof value !== 'string') return null
  const parts = value.trim().split(' ').filter(Boolean)
  if (parts.length !== 3) return null

  const channels = parts.map((part) => Number(part))
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null
  }

  return channels as [number, number, number]
}

function transparentBackgroundFromTheme(
  theme: BrowserAutomationOverlayTheme | null
): string | null {
  const channels = parseRgbChannels(theme?.scrimRgb ?? theme?.surfaceRgb)
  return channels ? `rgba(${channels.join(', ')}, 0)` : null
}

export function createBrowserPointerOverlay(): BrowserPointerOverlay {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    acceptFirstMouse: false,
    webPreferences: {
      backgroundThrottling: false,
      transparent: true,
      sandbox: false
    }
  })
  window.setIgnoreMouseEvents(true, { forward: true })
  let currentPointer: BrowserAutomationPointerState | null = null
  let currentActivityBubble: BrowserAutomationActivityBubbleState | null = null
  let currentTheme: BrowserAutomationOverlayTheme | null = null
  let attachedWindow: InstanceType<typeof BrowserWindow> | null = null
  let currentBounds: BrowserAutomationViewBounds | null = null
  let destroyed = false
  const loaded = window.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(POINTER_OVERLAY_HTML)}`
  )

  function applyBounds(): void {
    if (destroyed || window.isDestroyed() || !attachedWindow || attachedWindow.isDestroyed()) return
    if (!currentBounds) return
    const contentBounds = attachedWindow.getContentBounds()
    window.setBounds({
      x: contentBounds.x + currentBounds.x,
      y: contentBounds.y + currentBounds.y,
      width: currentBounds.width,
      height: currentBounds.height
    })
  }

  function parentCanShowOverlay(): boolean {
    return Boolean(
      attachedWindow &&
      !attachedWindow.isDestroyed() &&
      attachedWindow.isVisible() &&
      !attachedWindow.isMinimized()
    )
  }

  function ensureVisible(): void {
    if (destroyed || window.isDestroyed() || !attachedWindow || attachedWindow.isDestroyed()) return
    if (!currentBounds || !parentCanShowOverlay()) {
      window.hide()
      return
    }

    window.setParentWindow(attachedWindow)
    applyBounds()
    window.showInactive()
    window.setAlwaysOnTop(true, 'pop-up-menu')
    window.moveTop()
    window.setAlwaysOnTop(false)
  }

  function hideOverlay(): void {
    if (destroyed || window.isDestroyed()) return
    window.hide()
  }

  function followParent(): void {
    ensureVisible()
  }

  function unfollowParent(): void {
    if (!attachedWindow || attachedWindow.isDestroyed()) return
    attachedWindow.off('focus', ensureVisible)
    attachedWindow.off('show', ensureVisible)
    attachedWindow.off('restore', ensureVisible)
    attachedWindow.off('move', followParent)
    attachedWindow.off('resize', followParent)
    attachedWindow.off('enter-full-screen', ensureVisible)
    attachedWindow.off('leave-full-screen', ensureVisible)
    attachedWindow.off('hide', hideOverlay)
    attachedWindow.off('minimize', hideOverlay)
    attachedWindow.off('closed', detach)
  }

  function detach(): void {
    if (destroyed || window.isDestroyed()) return
    unfollowParent()
    attachedWindow = null
    window.hide()
    window.setParentWindow(null)
  }

  // Latest-wins per channel: at most one executeJavaScript in flight, so
  // rapid updates during a page load cannot pile up Electron's internal
  // did-stop-loading listeners (executeJavaScript parks on that event while
  // the overlay document is still loading). The script builders read the
  // current state at execution time, so the trailing run pushes the newest
  // value.
  function createOverlayScriptApplier(buildScript: () => string): () => void {
    const schedule = createLatestWinsRunner(async () => {
      await loaded
      if (destroyed || window.webContents.isDestroyed()) return
      await window.webContents.executeJavaScript(buildScript(), true)
    })
    return () => {
      if (destroyed || window.webContents.isDestroyed()) return
      schedule()
    }
  }

  const applyPointer = createOverlayScriptApplier(
    () => `window.__yachiyoSetPointer(${JSON.stringify(currentPointer)})`
  )
  const applyTheme = createOverlayScriptApplier(
    () => `window.__yachiyoSetTheme(${JSON.stringify(currentTheme)})`
  )
  const applyActivityBubble = createOverlayScriptApplier(
    () => `window.__yachiyoSetActivityBubble(${JSON.stringify(currentActivityBubble)})`
  )

  return {
    attachTo(parentWindow) {
      if (destroyed || window.isDestroyed() || parentWindow.isDestroyed()) return
      if (attachedWindow !== parentWindow) {
        unfollowParent()
        attachedWindow = parentWindow
        window.setParentWindow(parentWindow)
        parentWindow.on('focus', ensureVisible)
        parentWindow.on('show', ensureVisible)
        parentWindow.on('restore', ensureVisible)
        parentWindow.on('move', followParent)
        parentWindow.on('resize', followParent)
        parentWindow.on('enter-full-screen', ensureVisible)
        parentWindow.on('leave-full-screen', ensureVisible)
        parentWindow.on('hide', hideOverlay)
        parentWindow.on('minimize', hideOverlay)
        parentWindow.on('closed', detach)
      }
      ensureVisible()
    },
    detach,
    setBounds(bounds) {
      if (destroyed || window.isDestroyed()) return
      currentBounds = bounds
      ensureVisible()
    },
    updateTheme(theme) {
      currentTheme = theme
      const background = transparentBackgroundFromTheme(theme)
      if (background) {
        window.setBackgroundColor(background)
      }
      applyTheme()
    },
    updatePointer(pointer) {
      currentPointer = pointer
      applyPointer()
    },
    updateActivityBubble(activityBubble) {
      currentActivityBubble = activityBubble
      applyActivityBubble()
    },
    destroy() {
      detach()
      destroyed = true
      if (!window.isDestroyed()) {
        window.close()
      }
    }
  }
}
