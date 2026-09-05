export interface TimelineViewportAnchor {
  key: string
  top: number
}

export function captureTimelineViewportAnchor(
  container: HTMLElement
): TimelineViewportAnchor | null {
  const top = container.getBoundingClientRect().top
  for (const row of container.querySelectorAll<HTMLElement>('[data-timeline-row-key]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > top && rect.top < top + container.clientHeight) {
      return { key: row.dataset.timelineRowKey!, top: rect.top - top }
    }
  }
  return null
}

/** Returns null while the virtualizer has not mounted the anchor yet. */
export function restoreTimelineViewportAnchor(
  container: HTMLElement,
  anchor: TimelineViewportAnchor
): number | null {
  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-timeline-row-key]')).find(
    (element) => element.dataset.timelineRowKey === anchor.key
  )
  if (!row) return null
  const delta = row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.top
  if (Math.abs(delta) > 0.5) container.scrollTop += delta
  return delta
}
