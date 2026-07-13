export interface FloatingPanelRect {
  top: number
  right: number
  bottom: number
  left: number
}

export interface FloatingPanelSize {
  width: number
  height: number
}

export interface FloatingPanelLayoutInput {
  anchor: FloatingPanelRect
  panel: FloatingPanelSize
  viewport: FloatingPanelSize
  preferredPlacement: 'top' | 'bottom'
  alignment: 'start' | 'center' | 'end'
  gap?: number
  margin?: number
}

export interface FloatingPanelLayout {
  top: number
  left: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

const DEFAULT_GAP = 8
const DEFAULT_MARGIN = 12

export function resolveFloatingPanelLayout({
  anchor,
  panel,
  viewport,
  preferredPlacement,
  alignment,
  gap = DEFAULT_GAP,
  margin = DEFAULT_MARGIN
}: FloatingPanelLayoutInput): FloatingPanelLayout {
  const availableWidth = Math.max(0, viewport.width - margin * 2)
  const width = Math.min(panel.width, availableWidth)
  const availableAbove = Math.max(0, anchor.top - gap - margin)
  const availableBelow = Math.max(0, viewport.height - anchor.bottom - gap - margin)
  const preferredSpace = preferredPlacement === 'top' ? availableAbove : availableBelow
  const oppositeSpace = preferredPlacement === 'top' ? availableBelow : availableAbove
  const placement =
    preferredSpace >= panel.height || preferredSpace >= oppositeSpace
      ? preferredPlacement
      : preferredPlacement === 'top'
        ? 'bottom'
        : 'top'
  const availableHeight = Math.max(0, viewport.height - margin * 2)
  const maxHeight = Math.min(
    panel.height,
    availableHeight,
    placement === 'top' ? availableAbove : availableBelow
  )

  const desiredLeft =
    alignment === 'start'
      ? anchor.left
      : alignment === 'end'
        ? anchor.right - width
        : anchor.left + (anchor.right - anchor.left - width) / 2
  const maximumLeft = Math.max(margin, viewport.width - margin - width)
  const left = Math.max(margin, Math.min(desiredLeft, maximumLeft))
  const desiredTop = placement === 'top' ? anchor.top - gap - maxHeight : anchor.bottom + gap
  const maximumTop = Math.max(margin, viewport.height - margin - maxHeight)
  const top = Math.max(margin, Math.min(desiredTop, maximumTop))

  return { top, left, width, maxHeight, placement }
}
