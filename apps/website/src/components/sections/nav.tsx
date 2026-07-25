'use client'

import type { ReactElement } from 'react'
import { Github, BookOpen, Languages } from 'lucide-react'
import type { LandingCopy, Locale } from '@/i18n/landing'
import { LANG_KEY, docsHref, homeHref, otherLocale } from '@/i18n/landing'

export function Nav({ copy, locale }: { copy: LandingCopy; locale: Locale }): ReactElement {
  // Picking a language here is a decision, and it outranks browser detection
  // from then on — see the detection script in Landing.astro.
  const rememberChoice = (): void => {
    try {
      localStorage.setItem(LANG_KEY, otherLocale(locale))
    } catch {
      // Private mode or blocked storage: the switch still navigates, the
      // preference just does not persist.
    }
  }

  return (
    <header className="fixed top-0 inset-x-0 z-50 bg-white/80 backdrop-blur-md border-b border-ink/5">
      <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href={homeHref(locale)} className="flex items-center gap-2.5">
          <img src="/icon-128.png" alt="Yachiyo" className="w-7 h-7 rounded-lg" />
          <span className="text-ink font-medium">Yachiyo</span>
        </a>

        <div className="flex items-center gap-5 text-sm text-ink/60">
          <a
            href={docsHref(locale)}
            className="hover:text-mizu-600 transition-colors flex items-center gap-1.5"
          >
            <BookOpen className="w-4 h-4" />
            {copy.nav.docs}
          </a>
          <a
            href="https://github.com/ringotypowriter/yachiyo"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-mizu-600 transition-colors flex items-center gap-1.5"
          >
            <Github className="w-4 h-4" />
            <span className="hidden sm:inline">{copy.nav.github}</span>
          </a>
          <a
            href={copy.nav.switchHref}
            onClick={rememberChoice}
            className="hover:text-mizu-600 transition-colors flex items-center gap-1.5"
          >
            <Languages className="w-4 h-4" />
            {copy.nav.switchTo}
          </a>
        </div>
      </nav>
    </header>
  )
}
