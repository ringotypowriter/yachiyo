import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'

type TrailStrength = 'off' | 'low' | 'medium' | 'high'
type CaretIntent = 'typing' | 'delete' | 'nav-left' | 'nav-right' | 'other'

interface SmoothCaretOverlayProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  hostRef: React.RefObject<HTMLElement | null>
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

// Mirror div: computes caret (x, y, height) relative to the textarea's top-left corner.
// Returns null when position cannot be determined.
function measureTextareaCaretPos(
  textarea: HTMLTextAreaElement
): { x: number; y: number; height: number } | null {
  const pos = textarea.selectionStart
  if (pos === null) return null

  const style = getComputedStyle(textarea)
  const mirror = document.createElement('div')

  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '-9999px',
    left: '-9999px',
    zIndex: '-1',
    boxSizing: style.boxSizing,
    width: `${textarea.offsetWidth}px`,
    paddingTop: style.paddingTop,
    paddingRight: style.paddingRight,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
    borderTopWidth: style.borderTopWidth,
    borderRightWidth: style.borderRightWidth,
    borderBottomWidth: style.borderBottomWidth,
    borderLeftWidth: style.borderLeftWidth,
    borderStyle: 'solid',
    borderColor: 'transparent',
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    whiteSpace: 'pre-wrap',
    wordBreak: style.wordBreak,
    overflowWrap: style.overflowWrap,
    tabSize: style.tabSize,
    overflow: 'hidden'
  })

  mirror.textContent = textarea.value.substring(0, pos)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const mirrorRect = mirror.getBoundingClientRect()
  const markerRect = marker.getBoundingClientRect()
  document.body.removeChild(mirror)

  const fontSizePx = parseFloat(style.fontSize) || 16
  // Caret height is capped to ~1.2x font-size so it fits the glyph body
  // rather than the full line box (which includes leading space).
  const caretHeight = fontSizePx * 1.2
  // Use the line box height from the mirror to vertically center the caret.
  const lineBoxHeight = markerRect.height > 0 ? markerRect.height : caretHeight
  const verticalOffset = (lineBoxHeight - caretHeight) / 2

  return {
    x: markerRect.left - mirrorRect.left,
    y: markerRect.top - mirrorRect.top - textarea.scrollTop + verticalOffset,
    height: caretHeight
  }
}

export function SmoothCaretOverlay({
  textareaRef,
  hostRef,
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
    caret.style.opacity = visible ? '1' : '0'
  }

  const hideOverlay = (): void => {
    targetRef.current.visible = false
    currentRef.current.visible = false
    applyCaretStyle()
    stopAnimation()
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

    const caretPos = measureTextareaCaretPos(textarea)
    if (!caretPos) {
      hideOverlay()
      return
    }

    const host = hostRef.current
    if (!host) {
      hideOverlay()
      return
    }

    const hostRect = host.getBoundingClientRect()
    const textareaRect = textarea.getBoundingClientRect()

    const x = textareaRect.left - hostRect.left + caretPos.x
    const y = textareaRect.top - hostRect.top + caretPos.y
    const { height } = caretPos

    metricsRef.current = {
      lineHeight: height,
      charWidth: Math.max(6, Math.min(14, height * 0.55 * (9 / 14)))
    }

    targetRef.current = { x, y, height, visible: true }

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
    if (!textarea || !enabled) return

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

    const measureEvents = ['keyup', 'click', 'pointerup', 'compositionend'] as const

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
    textarea.addEventListener('scroll', scheduleMeasure)

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
      textarea.removeEventListener('scroll', scheduleMeasure)
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

  return (
    <div ref={overlayRef} className="echooo-caret-overlay" aria-hidden="true">
      <div ref={caretRef} className="echooo-caret" style={{ width: BASE_CARET_WIDTH }} />
    </div>
  )
}

export default SmoothCaretOverlay
