import { useEffect, useState } from 'react'
import { code as codePlugin } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'
import { requestHighlightTokens, type HighlightToken } from './highlightTokens.ts'

export function useCodeHighlightTokens(
  code: string,
  language: BundledLanguage | null
): HighlightToken[][] | null {
  const [tokensByLine, setTokensByLine] = useState<HighlightToken[][] | null>(null)

  useEffect(() => {
    if (!language) return
    let cancelled = false
    requestHighlightTokens(
      codePlugin,
      { code, language, themes: codePlugin.getThemes() },
      (lines) => {
        if (!cancelled) setTokensByLine(lines)
      }
    )
    return () => {
      cancelled = true
    }
  }, [code, language])

  return tokensByLine
}
