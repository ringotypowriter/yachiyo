export function remeasureTimelineRowFromDescendant(
  descendant: HTMLElement,
  measureElement: (element: HTMLElement) => void
): boolean {
  const row = descendant.closest<HTMLElement>('.message-timeline-row')
  if (!row) return false
  measureElement(row)
  return true
}

export function shouldAdjustTimelineScrollForSizeChange(
  itemEnd: number,
  scrollOffset: number
): boolean {
  return itemEnd <= scrollOffset
}

export function resolveTimelineScrollOffsetAfterSizeChange(input: {
  itemEnd: number
  previousSize: number
  nextSize: number
  scrollOffset: number
}): number {
  if (!shouldAdjustTimelineScrollForSizeChange(input.itemEnd, input.scrollOffset)) {
    return input.scrollOffset
  }
  return Math.max(0, input.scrollOffset + input.nextSize - input.previousSize)
}
