import type { MessageRecord } from '../../../../shared/yachiyo/protocol.ts'
import { summarizeMessageInput } from '../../../../shared/yachiyo/messageContent.ts'
import type { ModelMessage } from '../../runtime/types.ts'

export const MAX_THREAD_TITLE_LENGTH = 32
export const THREAD_TITLE_MAX_TOKEN = 128
const MAX_ATTACHMENT_BASENAME_LENGTH = 30

function sanitizeFilename(filename: string): string {
  // Truncate at the first control character (newline, tab, null byte, etc.) to
  // prevent prompt injection when filenames are embedded in title-generation
  // messages. Stripping instead of truncating would silently join the legitimate
  // prefix to the injected suffix.
  const controlIndex = filename.search(/[\p{Cc}\p{Cf}]/u)
  return (controlIndex >= 0 ? filename.slice(0, controlIndex) : filename).trim()
}

function trimFilename(filename: string): string {
  const safe = sanitizeFilename(filename)
  const dotIndex = safe.lastIndexOf('.')
  if (dotIndex <= 0) return safe.slice(0, MAX_ATTACHMENT_BASENAME_LENGTH)
  const basename = safe.slice(0, dotIndex)
  const ext = safe.slice(dotIndex)
  return basename.slice(0, MAX_ATTACHMENT_BASENAME_LENGTH) + ext
}

function extFromMediaType(mediaType: string): string {
  const sub = (mediaType.split('/')[1] ?? mediaType).split('+')[0].split(';')[0].toLowerCase()
  return sub === 'jpeg' ? 'jpg' : sub
}

export function buildTitleQuery(
  content: string,
  images?: { mediaType: string; filename?: string }[],
  attachments?: { filename: string }[]
): string {
  const parts: string[] = []
  const text = content.trim()
  if (text) parts.push(text)

  for (const img of images ?? []) {
    const label = img.filename ? trimFilename(img.filename) : extFromMediaType(img.mediaType)
    parts.push(`[image:${label}]`)
  }

  for (const att of attachments ?? []) {
    parts.push(`[document:${trimFilename(att.filename)}]`)
  }

  return parts.join(' ')
}

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
