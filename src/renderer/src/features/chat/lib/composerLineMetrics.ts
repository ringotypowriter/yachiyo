/**
 * Measures the x-offset (in px, relative to the overlay's left edge) of the character
 * at `charIndex` inside a textarea using the mirror-div technique.
 */
export function measureCharXInTextarea(
  overlay: HTMLElement,
  textarea: HTMLTextAreaElement,
  charIndex: number
): number {
  const ts = getComputedStyle(textarea)
  const hw = overlay.getBoundingClientRect().width
  const cw = textarea.clientWidth
  const targetW = cw > 1 ? Math.min(hw, cw) : hw

  const mirror = document.createElement('div')
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '-9999px',
    left: '-9999px',
    zIndex: '-1',
    boxSizing: ts.boxSizing,
    width: `${targetW}px`,
    paddingTop: ts.paddingTop,
    paddingRight: ts.paddingRight,
    paddingBottom: ts.paddingBottom,
    paddingLeft: ts.paddingLeft,
    border: 'none',
    fontSize: ts.fontSize,
    fontFamily: ts.fontFamily,
    fontWeight: ts.fontWeight,
    fontStyle: ts.fontStyle,
    lineHeight: ts.lineHeight,
    letterSpacing: ts.letterSpacing,
    wordSpacing: ts.wordSpacing,
    whiteSpace: ts.whiteSpace,
    wordBreak: ts.wordBreak,
    overflowWrap: ts.overflowWrap,
    tabSize: ts.tabSize,
    overflow: 'hidden'
  })
  document.body.appendChild(mirror)

  const value = textarea.value
  const before = value.slice(0, Math.min(charIndex, value.length))
  if (before.length > 0) {
    mirror.appendChild(document.createTextNode(before))
  }

  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(marker)

  const mirrorRect = mirror.getBoundingClientRect()
  const markerRect = marker.getBoundingClientRect()
  const x = markerRect.left - mirrorRect.left

  document.body.removeChild(mirror)
  return x
}

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
