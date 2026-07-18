import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult } from '@streamdown/code'
import { readCodeHighlightTokenTheme, type CodeHighlightTokenTheme } from './codeHighlightTheme.ts'

export interface HighlightToken extends CodeHighlightTokenTheme {
  content: string
}

export function toHighlightTokenLines(result: HighlightResult): HighlightToken[][] {
  return result.tokens.map((lineTokens) =>
    lineTokens.map((token) => ({
      content: token.content,
      ...readCodeHighlightTokenTheme(token.htmlStyle as Record<string, string> | undefined)
    }))
  )
}

// plugin.highlight returns the result synchronously on a cache hit and skips the
// callback entirely, so both delivery paths must be handled.
export function requestHighlightTokens(
  plugin: Pick<CodeHighlighterPlugin, 'highlight'>,
  options: HighlightOptions,
  onTokens: (lines: HighlightToken[][]) => void
): void {
  const cached = plugin.highlight(options, (result) => onTokens(toHighlightTokenLines(result)))
  if (cached) onTokens(toHighlightTokenLines(cached))
}
