import { useEffect } from 'react'
import { animate, useMotionValue, useTransform, type MotionValue } from 'framer-motion'
import type { AvatarPhase } from './avatarTypes'
import { getActivityEyeShape, getRestingTurn, getWinkEyeWeight } from './activityMotion'
import { WINK_DURATION_MS } from './winkMotion'

export function useActivityMotion(
  phase: AvatarPhase,
  moving: boolean,
  wink: number,
  winkProgress: MotionValue<number>
): { eyeTransform: MotionValue<string>; rotation: MotionValue<number> } {
  const initialShape = getActivityEyeShape(phase)
  const width = useMotionValue(initialShape.width)
  const height = useMotionValue(initialShape.height)
  const rotation = useMotionValue(0)
  const eyeTransform = useTransform(() => {
    const weight = getWinkEyeWeight(winkProgress.get())
    return `scale(${1 + (width.get() - 1) * weight}, ${1 + (height.get() - 1) * weight})`
  })

  useEffect(() => {
    const shape = getActivityEyeShape(phase)
    if (!moving) {
      width.set(shape.width)
      height.set(shape.height)
      return
    }
    let cancelled = false
    let pulse: ReturnType<typeof animate> | undefined
    const widen = animate(width, shape.width, { duration: 0.32, ease: 'easeInOut' })
    const stretch = animate(height, shape.height, { duration: 0.32, ease: 'easeInOut' })
    void stretch.then(() => {
      if (cancelled || (phase !== 'thinking' && phase !== 'working')) return
      pulse = animate(height, [shape.height, shape.height * 1.06, shape.height], {
        duration: phase === 'thinking' ? 5.8 : 2.6,
        repeat: Infinity,
        ease: 'easeInOut'
      })
    })
    return () => {
      cancelled = true
      widen.stop()
      stretch.stop()
      pulse?.stop()
    }
  }, [phase, moving, width, height])

  useEffect(() => {
    if (!moving) {
      rotation.set(0)
      return
    }
    let cancelled = false
    let turn: ReturnType<typeof animate> | undefined
    const settle = animate(rotation, getRestingTurn(rotation.get()), {
      duration: 0.26,
      ease: 'easeOut'
    })
    void settle.then(() => {
      if (cancelled || phase !== 'working') return
      rotation.set(0)
      turn = animate(rotation, [0, 0, -9, 0, 368, 360, 360], {
        duration: 8.5,
        times: [0, 0.34, 0.38, 0.4, 0.54, 0.6, 1],
        repeat: Infinity,
        ease: 'easeInOut',
        delay: wink > 0 ? WINK_DURATION_MS / 1000 : 0
      })
    })
    return () => {
      cancelled = true
      settle.stop()
      turn?.stop()
    }
  }, [phase, moving, wink, rotation])

  return { eyeTransform, rotation }
}
