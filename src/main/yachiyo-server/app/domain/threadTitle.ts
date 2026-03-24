import type { MessageRecord } from '../../../../shared/yachiyo/protocol.ts'
import { summarizeMessageInput } from '../../../../shared/yachiyo/messageContent.ts'
import type { ModelMessage } from '../../runtime/types.ts'

export const MAX_THREAD_TITLE_LENGTH = 60

export function deriveThreadTitleFallback(
  message: Pick<MessageRecord, 'content' | 'images'>
): string {
  const summary = summarizeMessageInput(message)
  return summary ? summary.slice(0, MAX_THREAD_TITLE_LENGTH) : ''
}

export function buildThreadTitleGenerationMessages(query: string): ModelMessage[] {
  return [
    {
      role: 'user',
      content: [
        'Generate a short thread title and a single emoji icon from this user query.',
        'Reply with exactly two lines and nothing else:',
        '- Line 1: exactly one emoji that represents the thread topic',
        '- Line 2: the title text (2–6 words, plain text only, no emoji, same language as the query)',
        '',
        'Do not add labels like "Emoji:" or "Title:".',
        `Keep the title under ${MAX_THREAD_TITLE_LENGTH} characters.`,
        'Do not repeat the user query verbatim.',
        'Compress the request into a compact topic label.',
        'Avoid filler like "Chat" or "Conversation".',
        '',
        'Examples:',
        'User query: Plan the MVP for a note-taking app',
        '📝',
        'Note-Taking MVP Plan',
        '',
        'User query: Fix the flaky login redirect after refresh',
        '🐛',
        'Login Redirect Flake',
        '',
        "User query: Write an email asking to reschedule tomorrow's interview",
        '📧',
        'Interview Reschedule Email',
        '',
        'User query:',
        query.trim()
      ].join('\n')
    }
  ]
}

export function sanitizeGeneratedThreadTitle(value: string): string | null {
  const firstNonEmptyLine =
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  const withoutWrappingQuotes = firstNonEmptyLine.replace(/^["'`]+|["'`]+$/gu, '').trim()
  const collapsedWhitespace = withoutWrappingQuotes.replace(/\s+/gu, ' ').trim()
  const withoutTrailingPunctuation = collapsedWhitespace.replace(/[.!?]+$/u, '').trim()
  const title = withoutTrailingPunctuation.slice(0, MAX_THREAD_TITLE_LENGTH).trim()

  return title || null
}

function extractFirstEmoji(text: string): string | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const first = [...segmenter.segment(text.trim())][0]?.segment ?? ''
  return /\p{Extended_Pictographic}/u.test(first) ? first : null
}

function stripLeadingEmoji(text: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const segments = [...segmenter.segment(text.trim())]
  let i = 0
  while (i < segments.length && /\p{Extended_Pictographic}/u.test(segments[i].segment)) {
    i++
  }
  return segments
    .slice(i)
    .map((s) => s.segment)
    .join('')
    .trim()
}

export function parseGeneratedTitleAndIcon(value: string): {
  icon: string | null
  title: string | null
} {
  const nonEmptyLines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  if (nonEmptyLines.length === 0) return { icon: null, title: null }

  const icon = extractFirstEmoji(nonEmptyLines[0])

  let rawTitleLine: string | undefined
  if (icon && nonEmptyLines[0] === icon) {
    // First line is emoji-only — title is on the next line
    rawTitleLine = nonEmptyLines[1]
  } else if (icon) {
    // Emoji is inline at the start of a combined line
    const remainder = nonEmptyLines[0].slice(icon.length).trim()
    rawTitleLine = remainder || nonEmptyLines[1]
  } else {
    // No emoji found — treat first line as title
    rawTitleLine = nonEmptyLines[0]
  }

  const cleanedTitle = rawTitleLine ? stripLeadingEmoji(rawTitleLine) : null
  const title = cleanedTitle ? sanitizeGeneratedThreadTitle(cleanedTitle) : null

  return { icon, title }
}
