import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, powerMonitor } from 'electron'
import type { ActivityTrackingConfig } from '../../shared/yachiyo/protocol.ts'
import { getActivityTracker } from '../yachiyo-server/activity/ActivityTracker.ts'
import { recognizeActivityScreenshot } from '../yachiyo-server/activity/visionOcr.ts'
import { captureActivityScreenshot } from './activityScreenshot.ts'

/**
 * Wires Electron window blur/focus events to the ActivityTracker singleton.
 * This is the ONLY file that couples the tracker to Electron.
 *
 * Call installActivityTrackerHost() once during app startup
 * (after the Yachiyo server is initialized).
 */
export function installActivityTrackerHost(initialConfig: ActivityTrackingConfig): void {
  const tracker = getActivityTracker(initialConfig.mode)
  tracker.setIdleTimeProvider(() => powerMonitor.getSystemIdleTime() * 1000)
  tracker.setOcrConfig(initialConfig.ocr)

  const helperPath = resolveVisionOcrHelperPath()
  if (helperPath) {
    tracker.setOcrSnapshotProvider(async (sample, trigger) => {
      const screenshot = await captureActivityScreenshot(sample)
      if (!screenshot) return null

      try {
        return await recognizeActivityScreenshot({
          helperPath,
          imagePath: screenshot.imagePath,
          sample,
          trigger,
          display: screenshot.display,
          createId: () => randomUUID(),
          timestamp: () => new Date().toISOString()
        })
      } finally {
        await rm(screenshot.imagePath, { force: true })
      }
    })
  }

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

function resolveVisionOcrHelperPath(): string | undefined {
  if (process.platform !== 'darwin') return undefined

  const candidates = [
    join(process.resourcesPath, 'external-hooks', 'vision-ocr'),
    join(app.getAppPath(), 'external-hooks', 'vision-ocr', '.build', 'release', 'vision-ocr')
  ]

  return candidates.find((candidate) => existsSync(candidate))
}

function isAnyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
}
