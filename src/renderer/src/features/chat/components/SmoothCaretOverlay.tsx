import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { prepareWithSegments, layoutWithLines, clearCache } from '@chenglou/pretext'
import {
  syncPretextContext,
  buildFontString,
  resolveLineHeightPx,
  getMeasureContext
} from '@renderer/features/chat/lib/pretextSync'

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
  /** Pass the textarea value so the caret remeasures on programmatic clears (e.g. send). */
  text?: string
}

const TAIL_POOL_SIZE = 32
const BASE_CARET_WIDTH = 2

const strengthScale: Record<TrailStrength, number> = {
  off: 0,
  low: 0.55,
  medium: 1,
  high: 1.8
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
 * Textarea caret pixel position via pretext (canvas-based line-breaking) + canvas measureText.
 * No DOM mirror — pure arithmetic, immune to the union-box and mirror-width-mismatch bugs.
 * Returns (x, y, height) relative to the textarea's border-box top-left.
 */

function measureCaretPos(
  textarea: HTMLTextAreaElement
): { x: number; y: number; height: number } | null {
  const pos = textarea.selectionStart
  if (pos === null) return null

  const cs = getComputedStyle(textarea)
  const lineHeight = resolveLineHeightPx(cs)
  const paddingLeft = parseFloat(cs.paddingLeft)
  const paddingTop = parseFloat(cs.paddingTop)
  const paddingRight = parseFloat(cs.paddingRight)
  const contentWidth = textarea.clientWidth - paddingLeft - paddingRight
  if (contentWidth <= 0) return null

  const value = textarea.value
  const caretIndex = value ? Math.min(pos, value.length) : 0
  const fontString = buildFontString(cs)

  syncPretextContext(cs)

  const prepared = prepareWithSegments(value || '\u200b', fontString, { whiteSpace: 'pre-wrap' })
  const { lines } = layoutWithLines(prepared, contentWidth, lineHeight)

  // Find which visual line contains the caret.
  // pretext excludes hard-break chars (\n, \r\n) from line.text, so we must
  // account for the consumed break characters between lines.
  let charOffset = 0
  let caretLineIndex = 0
  let offsetInLine = 0
  let matched = false

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].text.length
    const lineEndOffset = charOffset + lineLen

    // Caret is strictly within this line's visible text
    if (caretIndex < lineEndOffset) {
      caretLineIndex = i
      offsetInLine = caretIndex - charOffset
      matched = true
      break
    }

    // Count consumed hard-break chars that pretext excluded from line.text
    let nextOffset = lineEndOffset
    if (nextOffset < value.length && value[nextOffset] === '\r') nextOffset++
    if (nextOffset < value.length && value[nextOffset] === '\n') nextOffset++
    const breakChars = nextOffset - lineEndOffset

    if (breakChars > 0) {
      // Hard break: caret on the \n itself → show at end of the visible line
      if (caretIndex < nextOffset) {
        caretLineIndex = i
        offsetInLine = lineLen
        matched = true
        break
      }
      charOffset = nextOffset
    } else if (i === lines.length - 1) {
      // Last line, no trailing \n → caret at end of text
      caretLineIndex = i
      offsetInLine = lineLen
      matched = true
      break
    } else {
      // Soft wrap → caret at the wrap point belongs to the next visual line
      charOffset = lineEndOffset
    }
  }

  // Trailing newline: caret is past all lines (e.g. "hello\n" with caret at pos 6).
  // Pretext doesn't emit the trailing empty line, so place caret on a virtual next line.
  if (!matched) {
    caretLineIndex = lines.length
    offsetInLine = Math.max(0, caretIndex - charOffset)
  }

  // Reuse pretext's canvas (already has letterSpacing/wordSpacing synced)
  const ctx = getMeasureContext() as CanvasRenderingContext2D
  ctx.font = fontString
  const lineText = lines[caretLineIndex]?.text ?? ''
  const xOffset = ctx.measureText(lineText.slice(0, offsetInLine)).width

  // Clamp y to the textarea's actual content so line-breaking differences between
  // pretext and the browser never push the caret below the scrollable area.
  const rawY = paddingTop + caretLineIndex * lineHeight
  const maxY = Math.max(0, textarea.scrollHeight - parseFloat(cs.paddingBottom) - lineHeight)

  return {
    x: paddingLeft + xOffset,
    y: Math.min(rawY, maxY),
    height: lineHeight
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
  trailColor,
  text
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

    const caretPos = measureCaretPos(textarea)
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

    // When the textarea's own dimensions change (window resize, flex reflow, maxHeight
    // transitions, etc.) the pretext line-breaking cache may reference stale widths.
    // Clear it and remeasure so the caret stays in sync with the new text wrapping.
    let lastObservedWidth = textarea.clientWidth
    const ro = new ResizeObserver(() => {
      const w = textarea.clientWidth
      if (w !== lastObservedWidth) {
        lastObservedWidth = w
        clearCache()
        scheduleMeasure()
      }
    })
    ro.observe(textarea)

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
      ro.disconnect()
      textarea.classList.remove('echooo-hide-native-caret')
      stopAnimation()
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

  // Remeasure when the textarea value changes programmatically (e.g. cleared on send).
  // Native input events already trigger scheduleMeasure, so this covers the gap where
  // React sets the value without firing an input event.
  useEffect(() => {
    if (enabled && isFocused) {
      scheduleMeasure()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  return (
    <div ref={overlayRef} className="echooo-caret-overlay" aria-hidden="true">
      <div ref={caretRef} className="echooo-caret" style={{ width: BASE_CARET_WIDTH }} />
    </div>
  )
}

export default SmoothCaretOverlay
