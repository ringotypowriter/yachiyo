'use client'

import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'

export function CTA(): ReactElement {
  return (
    <section className="relative w-full py-32 px-6 bg-mizu-50/30">
      <div className="max-w-2xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-3xl sm:text-4xl font-display font-medium text-ink mb-4">
            Let her into your computer
          </h2>
          <p className="text-base text-ink/50 mb-10">
            Download Yachiyo today and meet the cyber-assistant that lives in your filesystem.
          </p>
          <Button size="lg" asChild>
            <a
              href="https://github.com/ringotypowriter/yachiyo/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="w-4 h-4 mr-2" />
              Download for macOS
            </a>
          </Button>
          <p className="mt-5 text-sm text-ink/40">Free · Open source · Apache-2.0</p>
        </motion.div>
      </div>
    </section>
  )
}
