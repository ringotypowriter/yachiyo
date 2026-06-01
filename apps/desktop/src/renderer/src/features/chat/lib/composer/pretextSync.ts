import {
  prepareWithSegments,
  layoutWithLines,
  clearCache,
  type LayoutLine
} from '@chenglou/pretext'
// @ts-expect-error — subpath resolved via Vite alias; not in package exports
import { getMeasureContext } from '@chenglou/pretext/measurement'

// ---------------------------------------------------------------------------
// Canvas context sync
// ---------------------------------------------------------------------------
// Pretext measures text via a shared <canvas> context. CSS properties like
// letter-spacing, word-spacing, text-rendering, and font-kerning affect glyph
// advances. If the canvas context doesn't carry the same values, pretext's
// line-breaking drifts from the browser's — especially over long unbroken
// strings (URLs) where sub-pixel errors accumulate.
// ---------------------------------------------------------------------------

let _ls = ''
let _ws = ''
let _tr = ''
let _fk = ''

export function syncPretextContext(cs: CSSStyleDeclaration): void {
  const ls = cs.letterSpacing !== 'normal' ? cs.letterSpacing : '0px'
  const ws = cs.wordSpacing !== 'normal' ? cs.wordSpacing : '0px'
  const tr = (cs as CSSStyleDeclaration & { textRendering?: string }).textRendering ?? 'auto'
  const fk = (cs as CSSStyleDeclaration & { fontKerning?: string }).fontKerning ?? 'auto'

  if (ls !== _ls || ws !== _ws || tr !== _tr || fk !== _fk) {
    const ctx = getMeasureContext() as CanvasRenderingContext2D
    ctx.letterSpacing = ls
    ctx.wordSpacing = ws
    if ('textRendering' in ctx) ctx.textRendering = tr as CanvasTextRendering
    if ('fontKerning' in ctx) ctx.fontKerning = fk as CanvasFontKerning
    clearCache()
    _ls = ls
    _ws = ws
    _tr = tr
    _fk = fk
  }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function buildFontString(cs: CSSStyleDeclaration): string {
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
}

export function resolveLineHeightPx(cs: CSSStyleDeclaration): number {
  const lh = cs.lineHeight
  const fs = parseFloat(cs.fontSize || '16')
  const fontSize = Number.isNaN(fs) ? 16 : fs
  if (lh && lh !== 'normal') {
    if (lh.endsWith('px')) {
      const px = parseFloat(lh)
      if (!Number.isNaN(px)) return px
    }
    const v = parseFloat(lh)
    if (!Number.isNaN(v)) return v > 0 && v < 4 ? v * fontSize : v
  }
  return fontSize * 1.2
}

/**
 * Compute pretext layout lines for a textarea's current value and geometry.
 * Returns `null` when the textarea has no usable content width.
 */
export function computePretextLines(
  value: string,
  textarea: HTMLTextAreaElement
): LayoutLine[] | null {
  const cs = getComputedStyle(textarea)
  const paddingLeft = parseFloat(cs.paddingLeft)
  const paddingRight = parseFloat(cs.paddingRight)
  const contentWidth = textarea.clientWidth - paddingLeft - paddingRight
  if (contentWidth <= 0) return null

  syncPretextContext(cs)
  const fontString = buildFontString(cs)
  const lineHeight = resolveLineHeightPx(cs)
  const prepared = prepareWithSegments(value || '\u200b', fontString, { whiteSpace: 'pre-wrap' })
  return layoutWithLines(prepared, contentWidth, lineHeight).lines
}

// ---------------------------------------------------------------------------
// Line-aware cursor navigation
// ---------------------------------------------------------------------------

/** Map a character index in the full text to (lineIndex, offsetInLine, charOffset). */
function locateCaret(
  lines: LayoutLine[],
  value: string,
  pos: number
): { lineIndex: number; offsetInLine: number; lineCharStart: number } {
  let charOffset = 0
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].text.length
    const lineEnd = charOffset + lineLen

    if (pos <= lineEnd || i === lines.length - 1) {
      return {
        lineIndex: i,
        offsetInLine: Math.min(pos - charOffset, lineLen),
        lineCharStart: charOffset
      }
    }

    // Skip consumed hard-break chars
    let next = lineEnd
    if (next < value.length && value[next] === '\r') next++
    if (next < value.length && value[next] === '\n') next++
    if (next > lineEnd) {
      if (pos < next) {
        return { lineIndex: i, offsetInLine: lineLen, lineCharStart: charOffset }
      }
      charOffset = next
    } else {
      charOffset = lineEnd
    }
  }
  return { lineIndex: lines.length - 1, offsetInLine: 0, lineCharStart: 0 }
}

/** Compute the character offset of the start of a given pretext line. */
function lineStartOffset(lines: LayoutLine[], value: string, targetLine: number): number {
  let charOffset = 0
  for (let i = 0; i < targetLine; i++) {
    charOffset += lines[i].text.length
    if (charOffset < value.length && value[charOffset] === '\r') charOffset++
    if (charOffset < value.length && value[charOffset] === '\n') charOffset++
  }
  return charOffset
}

/** Find the character index on `targetLineText` whose X offset is closest to `targetX`. */
function charAtX(ctx: CanvasRenderingContext2D, lineText: string, targetX: number): number {
  if (targetX <= 0 || lineText.length === 0) return 0
  // Binary search for the closest character
  let lo = 0
  let hi = lineText.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const w = ctx.measureText(lineText.slice(0, mid + 1)).width
    if (w <= targetX) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  // lo is now the first char whose right edge exceeds targetX.
  // Check whether lo or lo-1 is closer.
  if (lo > 0 && lo <= lineText.length) {
    const wBefore = ctx.measureText(lineText.slice(0, lo)).width
    const wAfter = lo < lineText.length ? ctx.measureText(lineText.slice(0, lo + 1)).width : wBefore
    if (targetX - wBefore < wAfter - targetX) return lo
  }
  return lo
}

// Sticky "goal X" — the X offset the cursor aims for across consecutive
// up/down presses. Preserved until any non-vertical navigation resets it.
let _goalX: number | null = null

/** Clear the goal column. Call on any horizontal movement, typing, or click. */
export function clearGoalX(): void {
  _goalX = null
}

/**
 * Navigate the textarea cursor up or down one pretext visual line.
 * Returns `true` if the event was handled (caller should preventDefault).
 */
export function navigatePretextLine(
  textarea: HTMLTextAreaElement,
  direction: 'up' | 'down',
  extend: boolean
): boolean {
  const value = textarea.value
  if (!value) return false

  const lines = computePretextLines(value, textarea)
  if (!lines || lines.length === 0) return false

  // Determine the moving end of the selection (the "head")
  const head =
    !extend && textarea.selectionStart !== textarea.selectionEnd
      ? direction === 'up'
        ? textarea.selectionStart
        : textarea.selectionEnd
      : direction === 'up' || textarea.selectionDirection === 'backward'
        ? textarea.selectionStart
        : textarea.selectionEnd

  const { lineIndex, offsetInLine } = locateCaret(lines, value, head)
  const targetLine = direction === 'up' ? lineIndex - 1 : lineIndex + 1

  // Compute or reuse the goal X
  const cs = getComputedStyle(textarea)
  const ctx = getMeasureContext() as CanvasRenderingContext2D
  ctx.font = buildFontString(cs)

  if (_goalX === null) {
    const currentLineText = lines[lineIndex].text
    _goalX = ctx.measureText(currentLineText.slice(0, offsetInLine)).width
  }

  // At boundary — move to start/end of text
  if (targetLine < 0) {
    const newPos = 0
    if (extend) {
      textarea.setSelectionRange(newPos, textarea.selectionEnd, 'backward')
    } else {
      textarea.setSelectionRange(newPos, newPos)
    }
    return true
  }
  if (targetLine >= lines.length) {
    const newPos = value.length
    if (extend) {
      textarea.setSelectionRange(textarea.selectionStart, newPos, 'forward')
    } else {
      textarea.setSelectionRange(newPos, newPos)
    }
    return true
  }

  const targetLineText = lines[targetLine].text
  const targetOffset = charAtX(ctx, targetLineText, _goalX)
  const newPos = lineStartOffset(lines, value, targetLine) + targetOffset

  if (extend) {
    const anchor =
      textarea.selectionDirection === 'backward' ? textarea.selectionEnd : textarea.selectionStart
    textarea.setSelectionRange(
      Math.min(anchor, newPos),
      Math.max(anchor, newPos),
      newPos < anchor ? 'backward' : 'forward'
    )
  } else {
    textarea.setSelectionRange(newPos, newPos)
  }
  return true
}

export { getMeasureContext }
