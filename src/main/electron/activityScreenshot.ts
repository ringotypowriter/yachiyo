import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { screen, type Display } from 'electron'

import type {
  ActivitySnapshotDisplay,
  ActivitySnapshotRect
} from '../../shared/yachiyo/protocol.ts'
import type { SampleResult, SampleWindowBounds } from '../yachiyo-server/activity/osascript.ts'
import { selectActivityScreenshotCapture } from './activityScreenshotSelection.ts'

const execFileAsync = promisify(execFile)
const SCREENSHOT_PATH = '/usr/sbin/screencapture'

export interface ActivityScreenshotResult {
  imagePath: string
  display: ActivitySnapshotDisplay
}

function toRect(bounds: SampleWindowBounds | Display['bounds']): ActivitySnapshotRect {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

async function captureRect(rect: ActivitySnapshotRect, imagePath: string): Promise<void> {
  await execFileAsync(
    SCREENSHOT_PATH,
    ['-x', '-R', `${rect.x},${rect.y},${rect.width},${rect.height}`, imagePath],
    { timeout: 5_000 }
  )
}

export async function captureActivityScreenshot(
  sample: SampleResult
): Promise<ActivityScreenshotResult | null> {
  if (process.platform !== 'darwin') return null

  const display = selectActivityScreenshotCapture({
    windowBounds: sample.windowBounds ? toRect(sample.windowBounds) : undefined,
    displays: screen.getAllDisplays().map((candidate) => ({
      displayId: candidate.id,
      bounds: toRect(candidate.bounds)
    }))
  })
  if (!display?.captureBounds) return null

  const dir = join(tmpdir(), 'yachiyo-activity-ocr')
  await mkdir(dir, { recursive: true })
  const imagePath = join(dir, `${randomUUID()}.png`)

  await captureRect(display.captureBounds, imagePath)
  return { imagePath, display }
}
