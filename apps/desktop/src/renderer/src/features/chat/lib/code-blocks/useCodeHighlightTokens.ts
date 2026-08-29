import { useEffect, useState } from 'react'
import type { BundledLanguage } from 'shiki'
import { requestHighlightTokens, type HighlightToken } from './highlightTokens.ts'

export function useCodeHighlightTokens(
  code: string,
  language: BundledLanguage | null
): HighlightToken[][] | null {
  const [tokensByLine, setTokensByLine] = useState<HighlightToken[][] | null>(null)

  useEffect(() => {
    setTokensByLine(null)
    if (!language) return

    let cancelled = false
    void import('@streamdown/code')
      .then(({ code: codePlugin }) => {
        if (cancelled || !codePlugin.supportsLanguage(language)) return
        requestHighlightTokens(
          codePlugin,
          { code, language, themes: codePlugin.getThemes() },
          (lines) => {
            if (!cancelled) setTokensByLine(lines)
          }
        )
      })
      .catch((error) => {
        console.error('[code-highlight] failed to load highlighter', error)
      })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return tokensByLine
}
