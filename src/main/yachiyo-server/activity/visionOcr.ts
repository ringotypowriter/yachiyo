import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type {
  ActivitySnapshot,
  ActivitySnapshotDisplay,
  ActivitySnapshotTrigger
} from '../../../shared/yachiyo/protocol.ts'
import type { SampleResult } from './osascript.ts'
import { cleanActivityOcrLines } from './ActivityOcrCleaner.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024

interface VisionOcrLineOutput {
  text?: string
  confidence?: number
}

interface VisionOcrOutput {
  revision?: number
  lines?: VisionOcrLineOutput[]
}

export interface RecognizeActivityScreenshotInput {
  helperPath: string
  imagePath: string
  sample: SampleResult
  trigger: ActivitySnapshotTrigger
  display?: ActivitySnapshotDisplay
  createId: () => string
  timestamp: () => string
  timeoutMs?: number
}

export async function recognizeActivityScreenshot(
  input: RecognizeActivityScreenshotInput
): Promise<ActivitySnapshot | null> {
  const { stdout } = await execFileAsync(
    input.helperPath,
    ['--recognition-level', 'fast', '--languages', 'system', input.imagePath],
    {
      encoding: 'utf8',
      timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER
    }
  )
  const parsed = JSON.parse(stdout.trim()) as VisionOcrOutput
  const cleaned = cleanActivityOcrLines({
    lines: (parsed.lines ?? []).flatMap((line) =>
      typeof line.text === 'string' && typeof line.confidence === 'number'
        ? [{ text: line.text, confidence: line.confidence }]
        : []
    )
  })

  if (!cleaned) return null

  return {
    id: input.createId(),
    capturedAt: input.timestamp(),
    appName: input.sample.appName,
    bundleId: input.sample.bundleId,
    ...(input.sample.windowTitle ? { windowTitle: input.sample.windowTitle } : {}),
    source: 'screen',
    trigger: input.trigger,
    ...(input.display ? { display: input.display } : {}),
    ocr: {
      ...cleaned,
      revision: parsed.revision ?? cleaned.revision
    }
  }
}
