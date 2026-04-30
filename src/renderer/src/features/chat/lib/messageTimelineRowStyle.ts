export interface TimelineVirtualRowStyle {
  position: 'absolute'
  top: 0
  left: 0
  width: '100%'
  transform: string
  contain: 'content'
}

export function buildTimelineVirtualRowStyle(start: number): TimelineVirtualRowStyle {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    transform: `translateY(${start}px)`,
    contain: 'content'
  }
}
