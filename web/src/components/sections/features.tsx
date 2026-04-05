'use client'

import type { ReactElement } from 'react'
import { motion } from 'framer-motion'

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

function NoteCard({
  title,
  description,
  emoji,
  x,
  y,
  drift,
  duration,
  index
}: {
  title: string
  description: string
  emoji: string
  x: string
  y: number
  drift: { x: number[]; y: number[] }
  duration: number
  index: number
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
        className="relative bg-[#fdfdfd] rounded-3xl p-5 shadow-[0_8px_28px_rgba(0,0,0,0.08),0_3px_8px_rgba(0,0,0,0.06)] hover:shadow-[0_18px_50px_rgba(75,175,201,0.18),0_8px_20px_rgba(0,0,0,0.08)] transition-shadow duration-300 cursor-default"
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
    </motion.div>
  )
}

export function Features(): ReactElement {
  return (
    <section className="relative w-full py-32 px-6 overflow-hidden">
      <div className="max-w-4xl mx-auto">
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
            <NoteCard key={feature.title} {...feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  )
}
