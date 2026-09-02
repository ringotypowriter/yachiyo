export function remeasureTimelineRowFromDescendant(
  descendant: HTMLElement,
  measureElement: (element: HTMLElement) => void
): boolean {
  const row = descendant.closest<HTMLElement>('.message-timeline-row')
  if (!row) return false
  measureElement(row)
  return true
}
