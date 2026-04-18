export const THINKING_PAGE_LINES = 4
export const THINKING_PAGE_MIN_SWAP_MS = 1000

export interface ThinkingPage {
  index: number
  text: string
}

export const EMPTY_THINKING_PAGE: ThinkingPage = { index: 0, text: '' }

export function computeThinkingPage(reasoning: string): ThinkingPage {
  if (!reasoning) return EMPTY_THINKING_PAGE
  const rawLines = reasoning.split('\n')
  const hasTrailingBlank = rawLines.length > 1 && rawLines[rawLines.length - 1].length === 0
  const lines = hasTrailingBlank ? rawLines.slice(0, -1) : rawLines
  if (lines.length === 0) return EMPTY_THINKING_PAGE
  const latestLineIdx = lines.length - 1
  const index = Math.floor(latestLineIdx / THINKING_PAGE_LINES)
  const start = index * THINKING_PAGE_LINES
  const text = lines.slice(start, start + THINKING_PAGE_LINES).join('\n')
  return { index, text }
}
