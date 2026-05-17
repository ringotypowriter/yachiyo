import type {
  ActivitySnapshotDisplay,
  ActivitySnapshotDisplaySelection,
  ActivitySnapshotRect
} from '../../shared/yachiyo/protocol.ts'

export interface ActivityScreenshotDisplayCandidate {
  displayId: number
  bounds: ActivitySnapshotRect
}

export interface SelectActivityScreenshotCaptureInput {
  windowBounds?: ActivitySnapshotRect
  displays: ActivityScreenshotDisplayCandidate[]
  minCaptureSize?: number
}

const DEFAULT_MIN_CAPTURE_SIZE = 24

function intersectionRect(
  a: ActivitySnapshotRect,
  b: ActivitySnapshotRect
): ActivitySnapshotRect | undefined {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const width = right - x
  const height = bottom - y

  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

function area(rect: ActivitySnapshotRect): number {
  return rect.width * rect.height
}

function integerRect(rect: ActivitySnapshotRect): ActivitySnapshotRect {
  const x = Math.floor(rect.x)
  const y = Math.floor(rect.y)
  const right = Math.ceil(rect.x + rect.width)
  const bottom = Math.ceil(rect.y + rect.height)
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  }
}

export function selectActivityScreenshotCapture(
  input: SelectActivityScreenshotCaptureInput
): ActivitySnapshotDisplay | undefined {
  const minCaptureSize = input.minCaptureSize ?? DEFAULT_MIN_CAPTURE_SIZE
  if (!input.windowBounds) return undefined
  if (input.windowBounds.width < minCaptureSize || input.windowBounds.height < minCaptureSize) {
    return undefined
  }

  const best = input.displays
    .flatMap((display) => {
      const captureBounds = intersectionRect(input.windowBounds!, display.bounds)
      return captureBounds ? [{ display, captureBounds, area: area(captureBounds) }] : []
    })
    .sort((left, right) => right.area - left.area)[0]

  if (!best || best.area < minCaptureSize * minCaptureSize) return undefined

  return {
    displayId: best.display.displayId,
    selection: 'window-overlap' satisfies ActivitySnapshotDisplaySelection,
    bounds: best.display.bounds,
    captureBounds: integerRect(best.captureBounds)
  }
}
