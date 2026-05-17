export interface ComposerWheelScrollMetrics {
  scrollOffset: number
  viewportSize: number
  contentSize: number
}

export type ComposerWheelDestination = 'attachments' | 'local' | 'none' | 'timeline'

export interface ComposerWheelForwardInput {
  altKey: boolean
  ctrlKey: boolean
  deltaMode: number
  deltaX: number
  deltaY: number
  metaKey: boolean
  shiftKey: boolean
}

export interface ComposerTimelineWheelTarget {
  dispatchEvent: (event: Event) => boolean
  scrollBy: (options: ScrollToOptions) => void
}

const SCROLL_EDGE_EPSILON = 1

function isVerticalWheel(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 0
}

function canScrollInWheelDirection(metrics: ComposerWheelScrollMetrics, delta: number): boolean {
  if (delta < 0) {
    return metrics.scrollOffset > SCROLL_EDGE_EPSILON
  }

  if (delta > 0) {
    return metrics.scrollOffset + metrics.viewportSize < metrics.contentSize - SCROLL_EDGE_EPSILON
  }

  return false
}

export function resolveComposerWheelDestination(input: {
  attachmentStrip: ComposerWheelScrollMetrics | null
  deltaX: number
  deltaY: number
  localScroll?: ComposerWheelScrollMetrics | null
  overAttachmentStrip: boolean
  overTextarea: boolean
  popupOpen: boolean
  textarea: ComposerWheelScrollMetrics | null
}): ComposerWheelDestination {
  if (input.popupOpen || !isVerticalWheel(input.deltaX, input.deltaY)) {
    return 'none'
  }

  if (input.localScroll) {
    return canScrollInWheelDirection(input.localScroll, input.deltaY) ? 'local' : 'none'
  }

  if (
    input.overTextarea &&
    input.textarea &&
    canScrollInWheelDirection(input.textarea, input.deltaY)
  ) {
    return 'local'
  }

  if (
    input.overAttachmentStrip &&
    input.attachmentStrip &&
    canScrollInWheelDirection(input.attachmentStrip, input.deltaY)
  ) {
    return 'attachments'
  }

  return 'timeline'
}

function createForwardedWheelEvent(input: ComposerWheelForwardInput): Event {
  const wheelEventInit: WheelEventInit = {
    altKey: input.altKey,
    bubbles: true,
    cancelable: true,
    ctrlKey: input.ctrlKey,
    deltaMode: input.deltaMode,
    deltaX: input.deltaX,
    deltaY: input.deltaY,
    metaKey: input.metaKey,
    shiftKey: input.shiftKey
  }

  if (typeof WheelEvent === 'function') {
    return new WheelEvent('wheel', wheelEventInit)
  }

  const event = new Event('wheel', { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    altKey: { value: input.altKey },
    ctrlKey: { value: input.ctrlKey },
    deltaMode: { value: input.deltaMode },
    deltaX: { value: input.deltaX },
    deltaY: { value: input.deltaY },
    metaKey: { value: input.metaKey },
    shiftKey: { value: input.shiftKey }
  })
  return event
}

export function forwardComposerWheelToTimeline(
  timeline: ComposerTimelineWheelTarget,
  input: ComposerWheelForwardInput
): void {
  timeline.dispatchEvent(createForwardedWheelEvent(input))
  timeline.scrollBy({ top: input.deltaY })
}
