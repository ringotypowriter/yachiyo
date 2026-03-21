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
        'Generate a short thread title from this user query.',
        'Reply immediately with only the title.',
        'Use plain text only.',
        `Keep it under ${MAX_THREAD_TITLE_LENGTH} characters.`,
        'Prefer 2 to 6 words.',
        'Do not stay silent.',
        'You must return exactly one non-empty title.',
        'Use the same language as the user query.',
        'Do not repeat the user query verbatim.',
        'Do not copy long phrases from the user query.',
        'Compress the request into a compact topic label.',
        'Avoid filler like "Chat" or "Conversation".',
        '',
        'Examples:',
        'User query: Plan the MVP for a note-taking app',
        'Title: Note-Taking MVP Plan',
        '',
        'User query: Fix the flaky login redirect after refresh',
        'Title: Login Redirect Flake',
        '',
        "User query: Write an email asking to reschedule tomorrow's interview",
        'Title: Interview Reschedule Email',
        '',
        'User query:',
        query.trim(),
        'Title:'
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
