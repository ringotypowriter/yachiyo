import { useEffect, useRef, useState } from 'react'

import {
  EMPTY_THINKING_PAGE,
  THINKING_PAGE_MIN_SWAP_MS,
  type ThinkingPage,
  computeThinkingPage
} from '../lib/thinkingPager.ts'

// Drives a throttled, teleprompter-style view of streaming thinking content.
//
// - Within a page (≤4 lines), new text is applied immediately; DOM cost is
//   minimal because the renderer writes plain text, not markdown.
// - When the latest line crosses a 4-line page boundary, the page swap is
//   gated to at least THINKING_PAGE_MIN_SWAP_MS apart to avoid flashing.
// - When the stream ends (isActive → false), the latest page is flushed.
export function useThinkingPager(reasoning: string, isActive: boolean): ThinkingPage {
  const [displayed, setDisplayed] = useState<ThinkingPage>(() =>
    isActive ? computeThinkingPage(reasoning) : EMPTY_THINKING_PAGE
  )
  const lastSwapAtRef = useRef<number>(0)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<ThinkingPage>(displayed)

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!isActive) {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      return
    }

    const latest = computeThinkingPage(reasoning)
    latestRef.current = latest

    setDisplayed((prev) => {
      if (prev.index === latest.index) {
        return prev.text === latest.text ? prev : latest
      }
      const now = Date.now()
      const elapsed = now - lastSwapAtRef.current
      if (elapsed >= THINKING_PAGE_MIN_SWAP_MS) {
        lastSwapAtRef.current = now
        return latest
      }
      if (pendingTimerRef.current === null) {
        pendingTimerRef.current = setTimeout(() => {
          pendingTimerRef.current = null
          lastSwapAtRef.current = Date.now()
          setDisplayed(latestRef.current)
        }, THINKING_PAGE_MIN_SWAP_MS - elapsed)
      }
      return prev
    })
  }, [reasoning, isActive])

  return displayed
}
