'use client'

import type { ReactElement } from 'react'
import { Github } from 'lucide-react'

export function Footer(): ReactElement {
  const currentYear = new Date().getFullYear()

  return (
    <footer className="w-full py-10 px-6 bg-mizu-50/40">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-5">
        <div className="flex items-center gap-3">
          <img src="/icon-128.png" alt="Yachiyo" className="w-8 h-8 rounded-xl" />
          <span className="text-ink font-medium">Yachiyo</span>
        </div>

        <div className="flex items-center gap-6 text-sm text-ink/55">
          <a
            href="https://github.com/ringotypowriter/yachiyo"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-mizu-600 transition-colors flex items-center gap-1.5"
          >
            <Github className="w-4 h-4" />
            GitHub
          </a>
          <a
            href="https://github.com/ringotypowriter/yachiyo/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-mizu-600 transition-colors"
          >
            Releases
          </a>
        </div>

        <p className="text-xs text-ink/40 text-center md:text-right">
          © {currentYear} Ringo. Code licensed under Apache-2.0.
          <br />
          Name, logo, and branding assets remain all rights reserved.
        </p>
      </div>
    </footer>
  )
}
