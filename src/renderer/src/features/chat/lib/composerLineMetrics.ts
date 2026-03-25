/**
 * Resolved used line-height in CSS pixels (handles px, unitless multipliers, normal).
 */
export function parseComputedLineHeightPx(el: HTMLElement): number {
  const s = getComputedStyle(el)
  const lh = s.lineHeight
  const fs = parseFloat(s.fontSize || '16')
  const fontSize = Number.isNaN(fs) ? 16 : fs

  if (lh && lh !== 'normal') {
    if (lh.endsWith('px')) {
      const px = parseFloat(lh)
      if (!Number.isNaN(px)) return px
    }
    const parsed = parseFloat(lh)
    if (!Number.isNaN(parsed)) {
      if (parsed > 0 && parsed < 4) {
        return parsed * fontSize
      }
      return parsed
    }
  }
  return fontSize * 1.2
}
