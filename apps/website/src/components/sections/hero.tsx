'use client'

import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, Github } from 'lucide-react'

export function Hero(): ReactElement {
  return (
    <section className="relative w-full min-h-screen flex items-center justify-center px-6 py-24 bg-white">
      <div className="relative z-10 max-w-4xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <img
            src="/branding.jpeg"
            alt="Yachiyo"
            className="w-36 h-36 sm:w-44 sm:h-44 md:w-52 md:h-52 rounded-4xl object-cover mx-auto"
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          <Badge variant="default" className="mb-6">
            Open source · macOS · Skills-only
          </Badge>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-display font-medium tracking-tight text-ink mb-4"
        >
          Yachiyo
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="text-lg sm:text-xl md:text-2xl text-mizu-600 mb-6 font-medium"
        >
          your cyber-assistant
        </motion.p>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.25 }}
          className="text-base sm:text-lg text-ink/55 max-w-lg mx-auto mb-10 leading-relaxed"
        >
          Only what&apos;s necessary for a cyber-assistant that lives in your computer.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-3"
        >
          <Button size="lg" className="w-full sm:w-auto text-base" asChild>
            <a
              href="https://github.com/ringotypowriter/yachiyo/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="w-4 h-4 mr-2" />
              Download for macOS
            </a>
          </Button>
          <Button variant="outline" size="lg" className="w-full sm:w-auto text-base" asChild>
            <a
              href="https://github.com/ringotypowriter/yachiyo"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Github className="w-4 h-4 mr-2" />
              View on GitHub
            </a>
          </Button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-5 text-sm text-ink/35"
        >
          Apache-2.0 licensed
        </motion.p>
      </div>
    </section>
  )
}
