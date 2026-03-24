import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { theme } from '@renderer/theme/theme'

interface PopupState {
  anchorX: number
  anchorY: number
  placement: 'top' | 'bottom'
}

function TooltipPopup({
  state,
  children
}: {
  state: PopupState
  children: React.ReactNode
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const [left, setLeft] = useState(state.anchorX)

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setVisible(true)
      if (ref.current) {
        const width = ref.current.offsetWidth
        const clamped = Math.max(
          8,
          Math.min(state.anchorX - width / 2, window.innerWidth - width - 8)
        )
        setLeft(clamped)
      }
    })
    return () => cancelAnimationFrame(id)
  }, [state.anchorX])

  const GAP = 4
  const isTop = state.placement === 'top'

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top: isTop ? state.anchorY - GAP : state.anchorY + GAP,
        transform: isTop
          ? `translateY(${visible ? '-100%' : 'calc(-100% + 4px)'})`
          : `translateY(${visible ? '0' : '4px'})`,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.13s ease, transform 0.13s ease',
        pointerEvents: 'none',
        zIndex: 9999,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 9,
        padding: '7px 11px',
        fontSize: 12,
        lineHeight: 1.5,
        color: theme.text.primary,
        whiteSpace: 'nowrap',
        boxShadow: theme.shadow.menu
      }}
    >
      {children}
    </div>
  )
}

export interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  placement?: 'top' | 'bottom'
  delay?: number
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 350
}: TooltipProps): React.JSX.Element {
  const [popup, setPopup] = useState<PopupState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  function handleMouseEnter(e: React.MouseEvent<HTMLSpanElement>): void {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
    }
    const rect = e.currentTarget.getBoundingClientRect()
    timerRef.current = setTimeout(() => {
      // Auto-flip to bottom when too close to the top edge
      const FLIP_THRESHOLD = 100
      const effectivePlacement =
        placement === 'top' && rect.top < FLIP_THRESHOLD ? 'bottom' : placement
      setPopup({
        anchorX: rect.left + rect.width / 2,
        anchorY: effectivePlacement === 'top' ? rect.top : rect.bottom,
        placement: effectivePlacement
      })
    }, delay)
  }

  function handleMouseLeave(): void {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setPopup(null)
  }

  return (
    <>
      <span onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
        {children}
      </span>
      {popup !== null
        ? createPortal(<TooltipPopup state={popup}>{content}</TooltipPopup>, document.body)
        : null}
    </>
  )
}
