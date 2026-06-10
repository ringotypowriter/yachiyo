export interface ThingsBoardScrollMetrics {
  scrollOffset: number
  viewportSize: number
  contentSize: number
}

const SCROLL_EDGE_EPSILON = 1

function isVerticalWheel(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 0
}

export function canScrollInWheelDirection(
  metrics: ThingsBoardScrollMetrics,
  delta: number
): boolean {
  if (delta < 0) {
    return metrics.scrollOffset > SCROLL_EDGE_EPSILON
  }

  if (delta > 0) {
    return metrics.scrollOffset + metrics.viewportSize < metrics.contentSize - SCROLL_EDGE_EPSILON
  }

  return false
}

export function resolveThingsBoardWheelDelta(input: {
  deltaX: number
  deltaY: number
  horizontal: ThingsBoardScrollMetrics
}): number | null {
  if (!isVerticalWheel(input.deltaX, input.deltaY)) {
    return null
  }

  return canScrollInWheelDirection(input.horizontal, input.deltaY) ? input.deltaY : null
}
