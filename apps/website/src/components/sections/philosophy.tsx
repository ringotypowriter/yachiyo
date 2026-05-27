'use client'

import type { ReactElement } from 'react'
import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'

const values = [
  {
    title: 'Yours, not a platform',
    description:
      'Most AI clients want to become ecosystems. Yachiyo respects your privacy and gets out of your way.'
  },
  {
    title: 'No MCP. No marketplace.',
    description: 'Skills-only. No protocol maze, no plugin store, no vendor lock-in.'
  },
  {
    title: 'No telemetry',
    description:
      'Your data never leaves your machine unless you send it. Local SQLite, local memory, local soul.'
  },
  {
    title: 'A living persona',
    description:
      'SOUL.md and USER.md shape every interaction. She remembers, adapts, and grows alongside you.'
  }
]

function InkBloomItem({
  title,
  description,
  index,
  isVisible
}: {
  title: string
  description: string
  index: number
  isVisible: boolean
}): ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: isVisible ? 1 : 0 }}
      transition={{ duration: 0.4, delay: 0.3 + index * 0.35 }}
      className="relative py-5"
    >
      {/* Ink bloom behind */}
      <motion.div
        className="absolute -left-8 top-1/2 -translate-y-1/2 w-40 h-32"
        initial={{ scale: 0, opacity: 0 }}
        animate={isVisible ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }}
        transition={{ duration: 1, delay: 0.2 + index * 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="w-full h-full rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(75,175,201,0.18) 0%, rgba(75,175,201,0) 70%)',
            filter: 'blur(10px)'
          }}
          animate={{
            scale: [1, 1.25, 0.95, 1.2, 1],
            x: [0, 24, -12, 18, 0],
            y: [0, -18, 12, -10, 0]
          }}
          transition={{
            duration: 7,
            ease: 'easeInOut',
            repeat: Infinity,
            repeatType: 'mirror'
          }}
        />
      </motion.div>

      {/* Text */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{
          opacity: isVisible ? 1 : 0,
          y: isVisible ? 0 : 8
        }}
        transition={{
          duration: 0.8,
          delay: 0.35 + index * 0.35,
          ease: [0.22, 1, 0.36, 1]
        }}
        className="relative z-10"
      >
        <h3 className="text-lg font-medium text-ink mb-1">{title}</h3>
        <p className="text-base text-ink/55 leading-relaxed">{description}</p>
      </motion.div>
    </motion.div>
  )
}

export function Philosophy(): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const isVisible = useInView(containerRef, { once: true, amount: 0.4 })

  return (
    <section className="relative w-full py-32 px-6 bg-white">
      <div ref={containerRef} className="relative max-w-2xl mx-auto">
        {/* Stationery paper */}
        <div className="absolute inset-0 -inset-x-6 sm:-inset-x-10 bg-white rounded-3xl shadow-[0_24px_80px_rgba(0,0,0,0.04)]" />

        {/* Content */}
        <div className="relative px-6 sm:px-10 py-14">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: isVisible ? 1 : 0, y: isVisible ? 0 : 12 }}
            transition={{ duration: 0.6 }}
            className="mb-10"
          >
            <h2 className="text-3xl sm:text-4xl font-display font-medium text-ink mb-3">
              Why Yachiyo?
            </h2>
            <p className="text-base text-ink/50">
              Because your assistant should be yours — not a platform, not a marketplace, not a
              maze.
            </p>
          </motion.div>

          <div>
            {values.map((value, index) => (
              <InkBloomItem key={value.title} {...value} index={index} isVisible={isVisible} />
            ))}
          </div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: isVisible ? 1 : 0 }}
            transition={{ duration: 0.6, delay: 1.8 }}
            className="mt-12 text-sm text-ink/40 italic font-display"
          >
            — Yachiyo
          </motion.p>
        </div>
      </div>
    </section>
  )
}
