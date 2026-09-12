import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { theme } from '@renderer/theme/theme'
import type { AvatarPhase } from './avatarTypes'
import { sampleWinkPose, WINK_DURATION_MS } from './winkMotion'
import { samplePointingPose, getPointingRestTarget, POINTING_CYCLE_MS } from './pointingMotion'
import { useActivityMotion } from './useActivityMotion'

interface YachiyoAvatarProps {
  phase?: AvatarPhase
  size?: 'compact' | 'inline' | 'conversation' | 'display'
  /** Change this number to request one wink without restarting the body morph. */
  wink?: number
  idleWink?: boolean
  label?: string
}

const heights = { compact: 16, inline: 28, conversation: 32, display: 64 } as const
const spring = { type: 'spring' as const, stiffness: 240, damping: 22, mass: 0.8 }

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia?.(reducedMotionQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
function getReducedMotion(): boolean {
  return window.matchMedia?.(reducedMotionQuery).matches === true
}

export function YachiyoAvatar({
  phase = 'idle',
  size = 'inline',
  wink = 0,
  idleWink = true,
  label
}: YachiyoAvatarProps): React.JSX.Element {
  const id = `avatar-${useId().replace(/:/g, '')}`
  const root = useRef<HTMLSpanElement>(null)
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false)
  const [visible, setVisible] = useState(true)
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden
  )

  useEffect(() => {
    const element = root.current
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    if (element) observer?.observe(element)
    const onVisibility = (): void => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const moving = visible && pageVisible && !reducedMotion
  const dots = phase === 'loading'
  const winkProgress = useMotionValue(0)
  const activity = useActivityMotion(phase, moving, wink, winkProgress)
  const winkSide = useMotionValue<'left' | 'right'>('left')
  const nextSide = useRef<'left' | 'right'>('left')
  const winkPose = useTransform(() => sampleWinkPose(winkProgress.get(), winkSide.get()))
  const eyePath = useTransform(winkPose, (pose) => pose.eye)
  const otherEyePath = useTransform(winkPose, (pose) => pose.otherEye)
  const pointingProgress = useMotionValue(0)
  const pointingPose = useTransform(pointingProgress, samplePointingPose)
  const handX = useTransform(pointingPose, (pose) => pose.handX)
  const handY = useTransform(pointingPose, (pose) => pose.handY)
  const handRadius = useTransform(pointingPose, (pose) => pose.handRadius)
  const bodyTransform = useTransform(() => {
    const pose = winkPose.get()
    const point = pointingPose.get()
    return `translateY(${pose.bodyY + point.bodyY}px) rotate(${pose.bodyRotate + point.bodyRotate}deg) scale(${pose.bodyScaleX}, ${pose.bodyScaleY})`
  })
  const faceTransform = useTransform(() => {
    const pose = winkPose.get()
    const point = pointingPose.get()
    return `translate(${pose.gazeX + point.gazeX}px, ${pose.gazeY + point.gazeY}px)`
  })
  const played = useRef({ wink: 0, success: false })

  useEffect(() => {
    if (!moving) {
      pointingProgress.set(0)
      return
    }
    if (phase !== 'speaking') {
      const retreat = animate(pointingProgress, getPointingRestTarget(pointingProgress.get()), {
        duration: 0.3,
        ease: 'easeOut'
      })
      return () => retreat.stop()
    }
    pointingProgress.set(0)
    const playback = animate(pointingProgress, 1, {
      duration: POINTING_CYCLE_MS / 1000,
      ease: 'linear',
      repeat: Infinity,
      // A requested wink takes the stage before the explaining gesture resumes.
      delay: wink > 0 ? WINK_DURATION_MS / 1000 : 0
    })
    return () => {
      playback.stop()
    }
  }, [phase, moving, wink, pointingProgress])

  useEffect(() => {
    const requested =
      wink !== played.current.wink || (phase === 'success' && !played.current.success)
    const element = root.current
    if (!element || !moving || dots) {
      played.current = { wink, success: phase === 'success' }
      return
    }
    let playback: ReturnType<typeof animate> | undefined
    const play = (): void => {
      playback?.stop()
      winkProgress.set(0)
      winkSide.set(nextSide.current)
      nextSide.current = nextSide.current === 'left' ? 'right' : 'left'
      element.dataset.winking = 'true'
      playback = animate(winkProgress, 1, {
        duration: WINK_DURATION_MS / 1000,
        ease: 'linear',
        onComplete: () => element.removeAttribute('data-winking')
      })
    }
    // Defer consumption until the effect survives Strict Mode's setup/cleanup probe.
    const startFrame = requestAnimationFrame(() => {
      played.current = { wink, success: phase === 'success' }
      if (requested) play()
    })
    const timer = phase === 'idle' && idleWink ? setInterval(play, 11000) : undefined
    return () => {
      clearInterval(timer)
      cancelAnimationFrame(startFrame)
      playback?.stop()
      winkProgress.set(0)
      element.removeAttribute('data-winking')
    }
  }, [wink, phase, moving, dots, winkProgress, winkSide, idleWink])

  const height = heights[size]
  const style = {
    width: height * 1.5625,
    height,
    '--avatar-body': theme.text.accent,
    '--avatar-eyes': '#fff'
  } as CSSProperties

  return (
    <span
      ref={root}
      className="yachiyo-avatar"
      data-phase={phase}
      data-size={size}
      data-moving={moving}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <motion.svg
        viewBox="0 0 100 64"
        width="100%"
        height="100%"
        focusable="false"
        initial={false}
        animate={{ rotate: phase === 'working' ? -7 : 0 }}
        transition={moving ? spring : { duration: 0 }}
      >
        <defs>
          <filter
            id={id}
            x="-30%"
            y="-50%"
            width="160%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
            <feColorMatrix
              in="blur"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
            />
          </filter>
        </defs>
        <motion.g
          className="yachiyo-avatar__activity-turn"
          style={{
            rotate: activity.rotation,
            transformBox: 'view-box',
            transformOrigin: '50% 50%'
          }}
        >
          <motion.g
            className="yachiyo-avatar__wink-body"
            style={{ transform: bodyTransform, transformOrigin: '50px 42px' }}
          >
            <g className="yachiyo-avatar__pose">
              <g filter={reducedMotion ? undefined : `url(#${id})`} fill="var(--avatar-body)">
                {[0, 1, 2].map((index) => (
                  <motion.g
                    key={index}
                    initial={false}
                    style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                    animate={{
                      y: moving && dots ? [0, -5, 0, 0] : 0,
                      scaleX: moving && dots ? [1, 0.94, 1.12, 1] : 1,
                      scaleY: moving && dots ? [1, 1.1, 0.88, 1] : 1
                    }}
                    transition={
                      moving && dots
                        ? {
                            duration: 1.25,
                            repeat: Infinity,
                            delay: index * 0.13,
                            times: [0, 0.3, 0.6, 1],
                            ease: 'easeInOut'
                          }
                        : { duration: 0.15 }
                    }
                  >
                    <motion.circle
                      cy="32"
                      initial={false}
                      animate={{ cx: dots ? 22 + index * 28 : 50, r: dots ? 8 : 22 }}
                      transition={moving ? spring : { duration: 0 }}
                    />
                  </motion.g>
                ))}
                <motion.circle
                  className="yachiyo-avatar__hand"
                  cx={handX}
                  cy={handY}
                  r={handRadius}
                />
              </g>
              <motion.g
                initial={false}
                animate={{ opacity: dots ? 0 : 1, scale: dots ? 0.5 : 1 }}
                style={{ transformOrigin: '50px 32px' }}
                transition={{ duration: moving ? 0.18 : 0, delay: moving && !dots ? 0.12 : 0 }}
              >
                <g className="yachiyo-avatar__gaze">
                  <motion.g
                    className="yachiyo-avatar__expression"
                    style={{ transform: faceTransform }}
                  >
                    {[eyePath, otherEyePath].map((path, index) => (
                      <g key={index} className="yachiyo-avatar__blink">
                        <motion.g
                          className="yachiyo-avatar__activity-eye"
                          style={{
                            transform: activity.eyeTransform,
                            transformBox: 'fill-box',
                            transformOrigin: 'center'
                          }}
                        >
                          <motion.path
                            className={`yachiyo-avatar__eye yachiyo-avatar__eye--${index === 0 ? 'wink' : 'smile'}`}
                            d={path}
                          />
                        </motion.g>
                      </g>
                    ))}
                  </motion.g>
                </g>
              </motion.g>
            </g>
          </motion.g>
        </motion.g>
        {phase === 'waiting' && (
          <circle
            className="yachiyo-avatar__waiting-dot"
            cx={76}
            cy={17}
            r={3}
            fill="var(--avatar-body)"
          />
        )}
        {phase === 'thinking' && (
          <g className="yachiyo-avatar__thoughts" fill="var(--avatar-body)">
            {[0, 1, 2].map((index) => (
              <circle
                key={index}
                className="yachiyo-avatar__thought-dot"
                cx={39 + index * 11}
                cy={index === 1 ? 3 : 6}
                r={2}
                style={{ animationDelay: `${index * 0.28}s` }}
              />
            ))}
          </g>
        )}
      </motion.svg>
    </span>
  )
}
