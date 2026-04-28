import { app, BrowserWindow, powerMonitor } from 'electron'
import {
  getActivityTracker,
  type ActivityTrackingMode
} from './yachiyo-server/activity/ActivityTracker.ts'

/**
 * Wires Electron window blur/focus events to the ActivityTracker singleton.
 * This is the ONLY file that couples the tracker to Electron.
 *
 * Call installActivityTrackerHost() once during app startup
 * (after the Yachiyo server is initialized).
 */
export function installActivityTrackerHost(initialMode: ActivityTrackingMode): void {
  const tracker = getActivityTracker(initialMode)
  tracker.setIdleTimeProvider(() => powerMonitor.getSystemIdleTime() * 1000)

  const handleBlur = (): void => {
    // Blur fires before focus moves to the other app — wait a tick
    // then check if we're truly unfocused (another Yachiyo window
    // might have gained focus in the meantime).
    setTimeout(() => {
      if (isAnyWindowFocused()) return
      tracker.handleWindowBlur()
    }, 100)
  }

  const handleFocus = (): void => {
    tracker.handleWindowFocus()
  }

  // Wire existing windows
  BrowserWindow.getAllWindows().forEach((w) => {
    w.on('blur', handleBlur)
    w.on('focus', handleFocus)
  })

  // Wire future windows
  app.on('browser-window-created', (_event, w) => {
    w.on('blur', handleBlur)
    w.on('focus', handleFocus)
  })
}

function isAnyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
}
