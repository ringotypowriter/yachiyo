/**
 * Shared FTS5 query helpers used by both the SQLite storage layer and the
 * CLI readonly search path. Keeps tokenization and SQL generation in one
 * place so the two consumers stay in sync.
 */

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function tokenizeQuery(query: string): string[] {
  return (
    normalizeWhitespace(query)
      .toLowerCase()
      // Match runs of Unicode letters/digits (covers Latin, Cyrillic, kana,
      // Hangul, accented chars, etc.) plus consecutive Han characters as one
      // token. This keeps parity with SQLite FTS5's unicode61 tokenizer which
      // indexes all Unicode word characters.
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter(Boolean) ?? []
  )
}

export function toMatchExpression(query: string): string {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' OR ')
}

export function extractSnippet(content: string, query: string, maxLength = 120): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) {
    return content.length > maxLength ? `${content.slice(0, maxLength)}…` : content
  }
  const start = Math.max(0, idx - 8)
  const end = Math.min(content.length, start + maxLength)
  const snippet = content.slice(start, end)
  return `${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`
}

/**
 * SQL for FTS5 message search. The caller must supply the privacy clause
 * fragment (empty string or `AND threads.privacy_mode IS NULL`).
 */
export function ftsMessageSearchSql(privacyClause: string): string {
  return `
    SELECT
      threads.id          AS threadId,
      threads.title       AS threadTitle,
      messages.id         AS messageId,
      messages.role       AS role,
      messages.created_at AS createdAt,
      messages.content    AS content
    FROM messages_fts
    JOIN messages ON messages.rowid = messages_fts.rowid
    JOIN threads  ON threads.id = messages.thread_id
    WHERE messages_fts MATCH ?
      AND threads.archived_at IS NULL
      AND messages.hidden IS NULL
      ${privacyClause}
    ORDER BY bm25(messages_fts) ASC, messages.created_at ASC
  `
}

/**
 * SQL for FTS5 thread title/preview search.
 */
export function ftsThreadSearchSql(privacyClause: string): string {
  return `
    SELECT threads.id
    FROM threads_fts
    JOIN threads ON threads.rowid = threads_fts.rowid
    WHERE threads_fts MATCH ?
      AND threads.archived_at IS NULL
      ${privacyClause}
    ORDER BY bm25(threads_fts, 3.0, 1.0) ASC
    LIMIT ?
  `
}

export interface FtsMessageRow {
  threadId: string
  threadTitle: string
  messageId: string
  role: 'user' | 'assistant'
  createdAt: string
  content: string
}
