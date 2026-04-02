import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { parseComputedLineHeightPx } from '@renderer/features/chat/lib/composerLineMetrics'

type TrailStrength = 'off' | 'low' | 'medium' | 'high'
type CaretIntent = 'typing' | 'delete' | 'nav-left' | 'nav-right' | 'other'

interface SmoothCaretOverlayProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  hostRef: React.RefObject<HTMLElement | null>
  highlightRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  trailStrength?: TrailStrength
  isFocused: boolean
  color: string
  trailColor: string
}

const TAIL_POOL_SIZE = 32
const BASE_CARET_WIDTH = 2

const strengthScale: Record<TrailStrength, number> = {
  off: 0,
  low: 0.55,
  medium: 1,
  high: 1.8
}

// Cached mirror div — typography from the textarea's *computed* styles so glyph
// advances (narrow letters like "l", "i") match the replaced element, not the overlay div.
let _mirror: HTMLDivElement | null = null
let _mirrorSource: HTMLElement | null = null

/** Match textarea text reflow when a vertical scrollbar narrows the editable. */
function mirrorMeasureWidth(overlay: HTMLElement, textarea: HTMLTextAreaElement): number {
  const hw = overlay.getBoundingClientRect().width
  const cw = textarea.clientWidth
  if (cw > 1) {
    return Math.min(hw, cw)
  }
  return hw
}

function applyMirrorTextStyles(
  mirror: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  targetW: number
): void {
  const ts = getComputedStyle(textarea)
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
    overflow: 'hidden',
    fontFeatureSettings: ts.fontFeatureSettings,
    fontKerning: ts.fontKerning,
    fontVariantLigatures: ts.fontVariantLigatures,
    fontVariantNumeric: ts.fontVariantNumeric,
    fontVariantCaps: ts.fontVariantCaps,
    textRendering: ts.textRendering,
    textIndent: ts.textIndent,
    direction: ts.direction,
    unicodeBidi: ts.unicodeBidi
  })
}

function ensureMirror(overlay: HTMLElement, textarea: HTMLTextAreaElement): HTMLDivElement {
  const targetW = mirrorMeasureWidth(overlay, textarea)

  if (_mirror && _mirrorSource === overlay) {
    applyMirrorTextStyles(_mirror, textarea, targetW)
    return _mirror
  }

  if (_mirror) {
    _mirror.remove()
    _mirror = null
  }

  const mirror = document.createElement('div')
  applyMirrorTextStyles(mirror, textarea, targetW)
  document.body.appendChild(mirror)
  _mirror = mirror
  _mirrorSource = overlay
  return mirror
}

function disposeMirror(): void {
  if (_mirror) {
    _mirror.remove()
    _mirror = null
    _mirrorSource = null
  }
}

/** Exclusive end index of the logical line that contains `from` (LF/CR, not soft-wrap). */
function endIndexOfLogicalLine(s: string, from: number): number {
  const n = s.indexOf('\n', from)
  const r = s.indexOf('\r', from)
  let end = s.length
  if (n !== -1) end = Math.min(end, n)
  if (r !== -1) end = Math.min(end, r)
  return end
}

function flushTextareaLayout(textarea: HTMLTextAreaElement): void {
  void textarea.offsetHeight
}

/**
 * Native caret is hidden, so the browser may not scroll the textarea on input. We still clamp
 * to [0, maxScroll]: an uncapped target fights the browser at maxHeight and desyncs highlight
 * scroll from textarea.scrollTop (viewport/caret mismatch after newline or typing).
 */
function ensureCaretVisibleInTextarea(
  textarea: HTMLTextAreaElement,
  caretTop: number,
  caretHeight: number
): void {
  flushTextareaLayout(textarea)
  const ch = textarea.clientHeight
  if (ch < 1) return

  const maxScroll = Math.max(0, textarea.scrollHeight - ch)
  const caretBottom = caretTop + caretHeight
  let next = textarea.scrollTop
  if (caretTop < next) {
    next = caretTop
  }
  if (caretBottom > next + ch) {
    next = caretBottom - ch
  }
  next = Math.max(0, Math.min(next, maxScroll))
  if (next !== textarea.scrollTop) {
    textarea.scrollTop = next
  }
}

/**
 * Textarea caret pixel position via the classic mirror + span marker (same idea as
 * textarea-caret-position): no collapsed Range / getClientRects heuristics.
 * Returns (x, y, height) relative to the mirror's border box top-left.
 */
function measureCaretPos(
  overlay: HTMLElement,
  textarea: HTMLTextAreaElement
): { x: number; y: number; height: number } | null {
  const pos = textarea.selectionStart
  if (pos === null) return null

  const mirror = ensureMirror(overlay, textarea)
  const value = textarea.value
  const clampedPos = value ? Math.min(pos, value.length) : 0

  mirror.replaceChildren()
  const before = value.slice(0, clampedPos)
  if (before.length > 0) {
    mirror.appendChild(document.createTextNode(before))
  }

  // Zero-width marker span at the exact caret position. Using the marker's own rect
  // avoids the union-box problem: when the tail text soft-wraps, getBoundingClientRect()
  // on the tail span returns the bounding box of ALL visual lines, snapping x to the
  // left margin instead of the true caret column.
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(marker)

  // Append remaining text on the same logical line so the mirror reflows identically.
  const lineEnd = endIndexOfLogicalLine(value, clampedPos)
  const afterOnLine = value.slice(clampedPos, lineEnd)
  if (afterOnLine.length > 0) {
    mirror.appendChild(document.createTextNode(afterOnLine))
  }

  const mirrorRect = mirror.getBoundingClientRect()
  const markerRect = marker.getBoundingClientRect()
  const lineHeightPx = parseComputedLineHeightPx(textarea)

  const xRel = markerRect.left - mirrorRect.left
  const yRel = markerRect.top - mirrorRect.top + (markerRect.height - lineHeightPx) / 2

  return {
    x: xRel,
    y: yRel,
    height: lineHeightPx
  }
}

export function SmoothCaretOverlay({
  textareaRef,
  hostRef,
  highlightRef,
  enabled,
  trailStrength = 'low',
  isFocused,
  color,
  trailColor
}: SmoothCaretOverlayProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLDivElement>(null)
  const trailIndexRef = useRef(0)
  const trailPoolRef = useRef<HTMLDivElement[]>([])
  const targetRef = useRef({ x: 0, y: 0, height: 18, visible: false })
  const currentRef = useRef({ x: 0, y: 0, height: 18, visible: false })
  const metricsRef = useRef({ lineHeight: 18, charWidth: 8 })
  const lastIntentRef = useRef<CaretIntent>('other')
  const rafRef = useRef<number | null>(null)
  const scheduledRef = useRef<number | null>(null)
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduceMotion = useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // Trail pool setup
  useEffect(() => {
    if (!overlayRef.current) return
    const pool = trailPoolRef.current
    while (pool.length < TAIL_POOL_SIZE) {
      const el = document.createElement('div')
      el.className = 'echooo-caret-trail'
      el.style.opacity = '0'
      overlayRef.current.appendChild(el)
      pool.push(el)
    }
  }, [])

  // Sync colors
  useEffect(() => {
    const overlay = overlayRef.current
    const caret = caretRef.current
    if (overlay) {
      overlay.style.setProperty('--echooo-caret-color', color)
      overlay.style.setProperty('--echooo-caret-trail-color', trailColor)
    }
    if (caret) caret.style.background = color
    trailPoolRef.current.forEach((node) => {
      node.style.background = trailColor
    })
  }, [color, trailColor])

  const stopBlink = (): void => {
    if (blinkTimerRef.current !== null) {
      clearTimeout(blinkTimerRef.current)
      blinkTimerRef.current = null
    }
    caretRef.current?.classList.remove('echooo-caret--blink')
  }

  const startBlinkAfterDelay = (): void => {
    stopBlink()
    blinkTimerRef.current = setTimeout(() => {
      blinkTimerRef.current = null
      caretRef.current?.classList.add('echooo-caret--blink')
    }, 530)
  }

  const stopAnimation = (): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }

  const applyCaretStyle = (): void => {
    const caret = caretRef.current
    if (!caret) return
    const { x, y, height, visible } = currentRef.current
    caret.style.transform = `translate3d(${x}px, ${y}px, 0)`
    caret.style.height = `${height}px`
    // Don't override opacity when blink animation is active — CSS handles it.
    if (!caret.classList.contains('echooo-caret--blink')) {
      caret.style.opacity = visible ? '1' : '0'
    }
  }

  const hideOverlay = (): void => {
    targetRef.current.visible = false
    currentRef.current.visible = false
    applyCaretStyle()
    stopAnimation()
    stopBlink()
    if (scheduledRef.current !== null) {
      cancelAnimationFrame(scheduledRef.current)
      scheduledRef.current = null
    }
    trailPoolRef.current.forEach((node) => {
      node.style.transition = 'none'
      node.style.opacity = '0'
    })
    textareaRef.current?.classList.remove('echooo-hide-native-caret')
  }

  const spawnTrail = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    height: number,
    opts?: {
      hasRightText?: boolean
      intent?: CaretIntent
      maxLength?: number
    }
  ): void => {
    if (reduceMotion) return
    const trailWeight = strengthScale[trailStrength]
    if (!overlayRef.current || trailWeight <= 0) return
    const pool = trailPoolRef.current
    if (!pool.length) return

    let dx = to.x - from.x
    let dy = to.y - from.y
    let distance = Math.hypot(dx, dy)
    if (distance < 1) return

    const intent = opts?.intent ?? 'other'
    const movingRight = dx >= 0.5
    const maxLength = opts?.maxLength ?? (movingRight ? 80 : 22)
    if (distance > maxLength) {
      const scale = maxLength / distance
      dx *= scale
      dy *= scale
      distance = maxLength
    }

    // Dot counts: typing is light, delete is heavier, nav in between
    let dotCount: number
    if (intent === 'typing') {
      dotCount = 2 + Math.round(trailWeight * 0.8) // high→4
    } else if (intent === 'delete') {
      dotCount = Math.max(4, Math.min(7, Math.round(trailWeight * 2.5 + 2))) // high→7
    } else if (intent === 'nav-right') {
      dotCount = opts?.hasRightText ? Math.max(3, Math.min(5, Math.round(trailWeight + 2))) : 3
    } else if (intent === 'nav-left') {
      dotCount = Math.max(3, Math.min(6, Math.round(trailWeight * 1.5 + 2))) // high→5
    } else {
      dotCount = Math.max(2, Math.min(4, Math.round(trailWeight + 1)))
    }

    // Drift direction: opposite to caret movement so particles trail behind
    const driftSign = dx >= 0 ? -1 : 1

    const now = performance.now()
    const angle = Math.atan2(dy, dx)
    const nx = -Math.sin(angle)
    const ny = Math.cos(angle)

    for (let i = 0; i < dotCount; i += 1) {
      const node = pool[trailIndexRef.current % pool.length]
      trailIndexRef.current += 1

      const t = dotCount === 1 ? 0.5 : i / (dotCount - 1)
      // Perpendicular jitter — wider for delete/nav-left, tighter for typing
      const jitterSpread = intent === 'typing' ? 2.5 : intent === 'delete' ? 4.5 : 3.5
      const jitterNormal = (Math.random() - 0.5) * jitterSpread * (1 - t * 0.4)

      const px = from.x + dx * t + nx * jitterNormal
      const py = from.y + dy * t + ny * jitterNormal
      const centerY = py + height * 0.5

      const baseSize = intent === 'typing' ? 2.0 : intent === 'delete' ? 3.2 : 2.6
      const size = baseSize + (intent === 'typing' ? 0.5 : 0.9) * (1 - t) + 0.4 * trailWeight

      const baseOpacity = intent === 'typing' ? 0.18 : intent === 'delete' ? 0.32 : 0.24
      const opacity = Math.min(
        intent === 'typing' ? 0.38 : intent === 'delete' ? 0.6 : 0.5,
        baseOpacity + (intent === 'typing' ? 0.1 : 0.18) * (1 - t) + 0.1 * trailWeight
      )

      const lifetime =
        intent === 'typing'
          ? 220 + 100 * (1 - t)
          : intent === 'delete'
            ? 320 + 140 * (1 - t)
            : 260 + 120 * (1 - t)

      // Each particle drifts in the opposite-to-movement direction as it fades
      const driftX = driftSign * (5 + Math.random() * 7)
      const driftY = (Math.random() - 0.5) * 5

      node.style.width = `${size}px`
      node.style.height = `${size}px`
      node.style.left = '0'
      node.style.top = '0'
      node.style.transform = `translate3d(${px}px, ${centerY - size * 0.5}px, 0) scale(1)`
      node.style.opacity = `${opacity}`
      node.dataset.spawn = `${now}`
      node.style.transition = 'none'
      // Force reflow to commit spawn position before transition starts
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      node.offsetHeight
      node.style.transition = `opacity ${lifetime}ms ease, transform ${lifetime}ms ease`
      requestAnimationFrame(() => {
        node.style.opacity = '0'
        node.style.transform = `translate3d(${px + driftX}px, ${centerY - size * 0.5 + driftY}px, 0) scale(0.5)`
      })
    }
  }

  const animateCaret = (): void => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    stopBlink()

    const step = (): void => {
      const target = targetRef.current
      const current = currentRef.current
      const distance = Math.hypot(target.x - current.x, target.y - current.y)
      const damping = reduceMotion || distance < 1 ? 1 : distance > 32 ? 0.65 : 0.52
      const vx = target.x - current.x
      const vy = target.y - current.y
      const vh = target.height - current.height
      const visibleChanged = target.visible !== current.visible

      if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5 && Math.abs(vh) < 0.5) {
        currentRef.current = {
          x: target.x,
          y: target.y,
          height: target.height,
          visible: target.visible
        }
        applyCaretStyle()
        if (!visibleChanged || !target.visible) {
          rafRef.current = null
          startBlinkAfterDelay()
          return
        }
      } else {
        currentRef.current = {
          x: current.x + vx * damping,
          y: current.y + vy * damping,
          height: current.height + vh * (reduceMotion ? 1 : 0.2),
          visible: target.visible
        }
        applyCaretStyle()
      }

      rafRef.current = requestAnimationFrame(step)
    }

    rafRef.current = requestAnimationFrame(step)
  }

  const measureCaret = (): void => {
    const textarea = textareaRef.current
    if (!textarea || !enabled) {
      hideOverlay()
      return
    }

    if (!isFocused || document.activeElement !== textarea) {
      hideOverlay()
      return
    }

    // Collapsed cursor only — hide during selections
    if (textarea.selectionStart !== textarea.selectionEnd) {
      hideOverlay()
      return
    }

    textarea.classList.add('echooo-hide-native-caret')

    const highlight = highlightRef.current
    const host = hostRef.current
    if (!highlight || !host) {
      hideOverlay()
      return
    }

    const overlayEl = overlayRef.current
    if (!overlayEl) {
      hideOverlay()
      return
    }

    const caretPos = measureCaretPos(highlight, textarea)
    if (!caretPos) {
      hideOverlay()
      return
    }

    const { height } = caretPos
    // Mirror x/y are in full content coordinates; map into the highlight viewport with the
    // textarea's scrollTop (source of truth). Flush layout first so scrollHeight/clientHeight
    // match the latest value/height after React/layout effects (maxHeight composer).
    ensureCaretVisibleInTextarea(textarea, caretPos.y, height)
    flushTextareaLayout(textarea)
    highlight.scrollTop = textarea.scrollTop

    // Overlay content includes a trailing-newline sentinel so its scrollHeight may exceed
    // the textarea's. If the caret is still below the overlay viewport, scroll it further.
    const hlCh = highlight.clientHeight
    if (hlCh > 0) {
      const caretBottom = caretPos.y + height
      if (caretBottom > highlight.scrollTop + hlCh) {
        const hlMax = Math.max(0, highlight.scrollHeight - hlCh)
        highlight.scrollTop = Math.min(caretBottom - hlCh, hlMax)
      }
    }
    const scrollTop = highlight.scrollTop

    const x = caretPos.x
    const rawY = caretPos.y - scrollTop

    const visibleH = highlight.getBoundingClientRect().height
    // Do not pin the caret to the bottom edge when scroll lags: that hid new lines below the fold.
    const y = Math.max(0, rawY)
    const visible = rawY >= -height * 0.5 && rawY <= visibleH + height * 0.25

    const fontSize = parseFloat(getComputedStyle(textarea).fontSize || '16')
    metricsRef.current = {
      lineHeight: height,
      charWidth: Number.isNaN(fontSize)
        ? Math.max(6, Math.min(14, height * 0.55 * (9 / 14)))
        : Math.max(6, Math.min(14, fontSize * 0.55))
    }

    targetRef.current = { x, y, height, visible }

    let hasRightText = false
    try {
      const end = textarea.selectionStart ?? 0
      hasRightText = textarea.value.substring(end).trim().length > 0
    } catch {
      hasRightText = false
    }

    const dist = Math.hypot(x - currentRef.current.x, y - currentRef.current.y)
    const hasPrevious = currentRef.current.visible
    const intent = lastIntentRef.current

    if (!reduceMotion && hasPrevious && dist > 0.25) {
      const charDx = Math.max(metricsRef.current.charWidth, 6)

      if (intent === 'typing') {
        // Spread from ~2 chars left of caret to just left — gives dots real room to scatter
        spawnTrail({ x: x - charDx * 2.2, y }, { x: x - charDx * 0.15, y }, height, {
          intent,
          maxLength: charDx * 2.5
        })
      } else if (intent === 'delete') {
        // Trail bursts rightward from caret (where the deleted char was)
        spawnTrail({ x, y }, { x: x + charDx * 1.8, y }, height, {
          intent,
          maxLength: charDx * 2
        })
      } else if (intent === 'nav-left' || intent === 'nav-right') {
        const maxLen = intent === 'nav-right' ? charDx * 2 : charDx * 1.5
        spawnTrail({ x: currentRef.current.x, y: currentRef.current.y }, { x, y }, height, {
          intent,
          maxLength: maxLen,
          hasRightText
        })
      } else {
        spawnTrail({ x: currentRef.current.x, y: currentRef.current.y }, { x, y }, height, {
          intent: 'other',
          maxLength: charDx * 1.5
        })
      }
    }

    animateCaret()
  }

  const scheduleMeasure = (): void => {
    if (scheduledRef.current !== null) return
    scheduledRef.current = requestAnimationFrame(() => {
      scheduledRef.current = null
      measureCaret()
    })
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    const textarea = textareaRef.current
    const host = hostRef.current
    if (!textarea || !host || !enabled) return

    const onInput = (event: Event): void => {
      const type = (event as InputEvent).inputType ?? ''
      if (type.startsWith('delete')) {
        lastIntentRef.current = 'delete'
      } else if (type.startsWith('insert')) {
        lastIntentRef.current = 'typing'
      } else {
        lastIntentRef.current = 'other'
      }
      scheduleMeasure()
      requestAnimationFrame(() => scheduleMeasure())
    }

    const onKeyDownCapture = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') {
        lastIntentRef.current = 'nav-left'
      } else if (event.key === 'ArrowRight') {
        lastIntentRef.current = 'nav-right'
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        lastIntentRef.current = 'delete'
      } else {
        lastIntentRef.current = lastIntentRef.current === 'typing' ? 'typing' : 'other'
      }
    }

    const measureEvents = [
      'keyup',
      'click',
      'pointerup',
      'compositionstart',
      'compositionupdate',
      'compositionend'
    ] as const

    textarea.addEventListener('input', onInput, { capture: true })
    textarea.addEventListener('keydown', onKeyDownCapture, { capture: true })
    measureEvents.forEach((ev) => textarea.addEventListener(ev, scheduleMeasure, { capture: true }))

    const onSelectionChange = (): void => {
      if (document.activeElement !== textarea) {
        hideOverlay()
        return
      }
      scheduleMeasure()
    }

    document.addEventListener('selectionchange', onSelectionChange, true)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    textarea.addEventListener('scroll', scheduleMeasure)
    host.addEventListener('scroll', scheduleMeasure, true)

    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => scheduleMeasure())
    }

    scheduleMeasure()

    return () => {
      textarea.removeEventListener('input', onInput, { capture: true } as EventListenerOptions)
      textarea.removeEventListener('keydown', onKeyDownCapture, {
        capture: true
      } as EventListenerOptions)
      measureEvents.forEach((ev) =>
        textarea.removeEventListener(ev, scheduleMeasure, { capture: true } as EventListenerOptions)
      )
      document.removeEventListener('selectionchange', onSelectionChange, true)
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
      textarea.removeEventListener('scroll', scheduleMeasure)
      host.removeEventListener('scroll', scheduleMeasure, true)
      textarea.classList.remove('echooo-hide-native-caret')
      stopAnimation()
      disposeMirror()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, trailStrength, isFocused])

  useEffect(() => {
    if (!enabled || !isFocused) {
      hideOverlay()
    } else {
      scheduleMeasure()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isFocused])

  return (
    <div ref={overlayRef} className="echooo-caret-overlay" aria-hidden="true">
      <div ref={caretRef} className="echooo-caret" style={{ width: BASE_CARET_WIDTH }} />
    </div>
  )
}

export default SmoothCaretOverlay
