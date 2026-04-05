'use client'

import { motion } from 'framer-motion'
import type { ReactElement } from 'react'

const shots = [
  {
    src: '/screenshots/reply-branching.jpg',
    alt: 'Reply branching',
    label: 'Reply Branching'
  },
  {
    src: '/screenshots/providers.jpg',
    alt: 'Provider configuration',
    label: 'Providers'
  },
  {
    src: '/screenshots/schedules.jpg',
    alt: 'Scheduled runs',
    label: 'Schedules'
  },
  {
    src: '/screenshots/coding-agents.jpg',
    alt: 'Coding agent profiles',
    label: 'Coding Agents'
  },
  {
    src: '/screenshots/model-and-agent-picker.jpg',
    alt: 'Model and agent picker',
    label: 'Model Picker'
  },
  {
    src: '/screenshots/app-home.jpg',
    alt: 'Essentials view',
    label: 'Essentials'
  }
]

export function Screenshots(): ReactElement {
  return (
    <section className="relative w-full py-32 px-6 bg-white">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-display font-medium text-ink mb-3">
            See Yachiyo in action
          </h2>
          <p className="text-base text-ink/50">
            A quiet workspace built around threads, runs, and streaming messages.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
          {shots.map((shot, index) => (
            <motion.div
              key={shot.label}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5, delay: index * 0.06 }}
            >
              <div
                className="relative overflow-hidden rounded-3xl bg-mizu-50/30"
                style={{ aspectRatio: '1400 / 908' }}
              >
                <img
                  src={shot.src}
                  alt={shot.alt}
                  width={1400}
                  height={908}
                  loading={index < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              </div>
              <p className="mt-4 text-sm text-ink/40">{shot.label}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
