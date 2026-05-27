'use client'

import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

const zeroPositions: { x: number; y: number }[] = []
const zeroVelocities: { x: number; y: number }[] = []

const features = [
  {
    title: 'Reply Branching',
    description:
      'Conversations form a tree. Explore different tones without losing the other paths.',
    emoji: '🌿',
    x: '4%',
    y: 0,
    drift: { x: [0, 16, 0], y: [0, -10, 0] },
    duration: 14
  },
  {
    title: 'Skills are just Markdown',
    description: 'Drop a SKILL.md into your workspace. No runtime. No API surface. It just works.',
    emoji: '📝',
    x: '52%',
    y: 30,
    drift: { x: [0, -12, 0], y: [0, 14, 0] },
    duration: 16
  },
  {
    title: 'Multi-Provider Runtime',
    description: 'Claude today, Gemini tomorrow, your own model next week. Switch per-message.',
    emoji: '⚡️',
    x: '22%',
    y: 140,
    drift: { x: [0, 10, 0], y: [0, 12, 0] },
    duration: 18
  },
  {
    title: 'Channel Multiplexing',
    description:
      'One local instance for Telegram, Discord, and QQ — shared context, shared memory.',
    emoji: '🌐',
    x: '62%',
    y: 200,
    drift: { x: [0, -14, 0], y: [0, -8, 0] },
    duration: 15
  },
  {
    title: 'Scheduled Runs',
    description: 'Set one-off or cron tasks, then let Yachiyo run them while you focus elsewhere.',
    emoji: '⏰',
    x: '6%',
    y: 300,
    drift: { x: [0, 8, 0], y: [0, -14, 0] },
    duration: 17
  },
  {
    title: 'Coding Agent Dispatch',
    description:
      'Delegate to Claude Code or Codex through ACP, then bring it back into the thread.',
    emoji: '👾',
    x: '48%',
    y: 380,
    drift: { x: [0, -10, 0], y: [0, 10, 0] },
    duration: 19
  },
  {
    title: 'Local-First Storage',
    description: 'Everything stays in SQLite under ~/.yachiyo/. No cloud. No telemetry.',
    emoji: '💾',
    x: '18%',
    y: 480,
    drift: { x: [0, 12, 0], y: [0, -6, 0] },
    duration: 16
  },
  {
    title: 'Browser-Backed Research',
    description: 'Search live sessions, read pages into Markdown, and keep what matters.',
    emoji: '🔍',
    x: '56%',
    y: 540,
    drift: { x: [0, -8, 0], y: [0, -12, 0] },
    duration: 18
  }
]

for (let i = 0; i < features.length; i++) {
  zeroPositions.push({ x: 0, y: 0 })
  zeroVelocities.push({ x: 0, y: 0 })
}

function NoteCard({
  title,
  description,
  emoji,
  x,
  y,
  drift,
  duration,
  index,
  cardRef,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: {
  title: string
  description: string
  emoji: string
  x: string
  y: number
  drift: { x: number[]; y: number[] }
  duration: number
  index: number
  cardRef: (el: HTMLDivElement | null) => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
}): ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.6, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
      className="absolute w-64 sm:w-72"
      style={{ left: x, top: y }}
    >
      <div
        ref={cardRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none"
        style={{ transform: 'translate3d(0px, 0px, 0px)' }}
      >
        <motion.div
          animate={{
            x: drift.x,
            y: drift.y,
            rotate: [0, 1.2, -0.8, 0]
          }}
          transition={{
            duration,
            repeat: Infinity,
            ease: 'easeInOut'
          }}
          whileHover={{
            scale: 1.03,
            rotate: 0,
            y: -4,
            transition: { duration: 0.25 }
          }}
          className="relative bg-[#fdfdfd] rounded-3xl p-5 shadow-[0_8px_28px_rgba(0,0,0,0.08),0_3px_8px_rgba(0,0,0,0.06)] hover:shadow-[0_18px_50px_rgba(75,175,201,0.18),0_8px_20px_rgba(0,0,0,0.08)] transition-shadow duration-300"
        >
          <div className="absolute -top-3 -right-3 w-10 h-10 rounded-full bg-white border-2 border-mizu-100 flex items-center justify-center text-lg shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
            {emoji}
          </div>

          <div className="flex items-start gap-3">
            <span className="mt-2 w-1.5 h-1.5 rounded-full bg-mizu-400 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-ink mb-1">{title}</h3>
              <p className="text-sm text-ink/50 leading-relaxed">{description}</p>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  )
}

export function Features(): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<(HTMLDivElement | null)[]>([])
  const positionsRef = useRef<{ x: number; y: number }[]>(zeroPositions)
  const velocitiesRef = useRef<{ x: number; y: number }[]>(zeroVelocities)
  const draggingRef = useRef<number | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const containerWidthRef = useRef<number>(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (containerRef.current) {
      containerWidthRef.current = containerRef.current.clientWidth
    }
  }, [])

  useEffect(() => {
    const onResize = (): void => {
      if (containerRef.current) {
        containerWidthRef.current = containerRef.current.clientWidth
        for (let i = 0; i < features.length; i++) {
          positionsRef.current[i] = { x: 0, y: 0 }
          velocitiesRef.current[i] = { x: 0, y: 0 }
          const el = notesRef.current[i]
          if (el) {
            el.style.transform = 'translate3d(0px, 0px, 0px)'
          }
        }
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const handlePointerDown = (index: number, e: React.PointerEvent<HTMLDivElement>): void => {
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    draggingRef.current = index
    lastPointerRef.current = { x: e.clientX, y: e.clientY }
    velocitiesRef.current[index] = { x: 0, y: 0 }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const idx = draggingRef.current
    if (idx === null) return
    const dx = e.clientX - lastPointerRef.current.x
    const dy = e.clientY - lastPointerRef.current.y
    lastPointerRef.current = { x: e.clientX, y: e.clientY }
    positionsRef.current[idx].x += dx
    positionsRef.current[idx].y += dy
    const el = notesRef.current[idx]
    if (el) {
      const p = positionsRef.current[idx]
      el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (draggingRef.current !== null) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      draggingRef.current = null
    }
  }

  useEffect(() => {
    const step = (): void => {
      const cw = containerWidthRef.current
      if (!cw) {
        rafRef.current = requestAnimationFrame(step)
        return
      }

      const repelRadius = 220
      const repelStrength = 0.08
      const springStrength = 0.02
      const damping = 0.88

      const homes = features.map((f) => ({
        x: cw * (parseFloat(f.x) / 100),
        y: f.y
      }))

      for (let i = 0; i < features.length; i++) {
        for (let j = i + 1; j < features.length; j++) {
          const xi = homes[i].x + positionsRef.current[i].x
          const yi = homes[i].y + positionsRef.current[i].y
          const xj = homes[j].x + positionsRef.current[j].x
          const yj = homes[j].y + positionsRef.current[j].y
          const dx = xj - xi
          const dy = yj - yi
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < repelRadius && d > 0.001) {
            const force = (repelRadius - d) * repelStrength
            const fx = (dx / d) * force
            const fy = (dy / d) * force
            velocitiesRef.current[i].x -= fx
            velocitiesRef.current[i].y -= fy
            velocitiesRef.current[j].x += fx
            velocitiesRef.current[j].y += fy
          }
        }
      }

      for (let i = 0; i < features.length; i++) {
        if (draggingRef.current === i) {
          velocitiesRef.current[i] = { x: 0, y: 0 }
          continue
        }

        velocitiesRef.current[i].x += -positionsRef.current[i].x * springStrength
        velocitiesRef.current[i].y += -positionsRef.current[i].y * springStrength
        velocitiesRef.current[i].x *= damping
        velocitiesRef.current[i].y *= damping

        positionsRef.current[i].x += velocitiesRef.current[i].x
        positionsRef.current[i].y += velocitiesRef.current[i].y

        const el = notesRef.current[i]
        if (el) {
          const p = positionsRef.current[i]
          el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`
        }
      }

      rafRef.current = requestAnimationFrame(step)
    }

    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  return (
    <section className="relative w-full py-32 px-6 overflow-hidden">
      <div ref={containerRef} className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-8 text-center"
        >
          <h2 className="text-3xl sm:text-4xl font-display font-medium text-ink mb-3">
            What Yachiyo can do
          </h2>
          <p className="text-base text-ink/50">
            Only what&apos;s necessary for a cyber-assistant that lives in your computer.
          </p>
        </motion.div>

        <div className="relative h-187.5">
          {features.map((feature, index) => (
            <NoteCard
              key={feature.title}
              {...feature}
              index={index}
              cardRef={(el: HTMLDivElement | null): void => {
                notesRef.current[index] = el
              }}
              onPointerDown={(e) => handlePointerDown(index, e)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
