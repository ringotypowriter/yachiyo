/**
 * Shared FTS5 query helpers used by both the SQLite storage layer and the
 * CLI readonly search path. Keeps tokenization and SQL generation in one
 * place so the two consumers stay in sync.
 *
 * The FTS index uses the trigram tokenizer (substring matching, CJK-capable),
 * so MATCH expressions can only contain tokens of 3+ characters. Queries
 * whose tokens are all shorter fall back to LIKE via the `like*SearchSql`
 * builders below.
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
      // token. Tokens are matched as substrings by the trigram tokenizer.
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter(Boolean) ?? []
  )
}

/** The trigram tokenizer cannot match substrings shorter than 3 characters. */
const MIN_TRIGRAM_TOKEN_LENGTH = 3

/**
 * Canonical tokenizer clause for the FTS tables. threadSearchIndex.ts writes
 * it into the DDL; the CLI checks sqlite_master for it to detect an index the
 * desktop app has not migrated yet (the CLI opens the database readonly and
 * cannot rebuild).
 */
export const FTS_TOKENIZE = `tokenize='trigram remove_diacritics 1'`

function isTrigramMatchable(token: string): boolean {
  return [...token].length >= MIN_TRIGRAM_TOKEN_LENGTH
}

/**
 * SQLite LIKE only case-folds ASCII, so cover the common casings of cased
 * non-ASCII tokens (да → Да / ДА) explicitly. Caseless tokens (CJK, digits)
 * collapse to a single pattern. Tokens contain only letters/digits, so no
 * LIKE escaping is needed.
 */
function casePatternVariants(token: string): string[] {
  const capitalized = token.charAt(0).toUpperCase() + token.slice(1)
  return [...new Set([token, capitalized, token.toUpperCase()])].map((variant) => `%${variant}%`)
}

export interface FtsSearchPlan {
  /** FTS5 MATCH expression for the trigram-matchable tokens; '' when none. */
  matchExpr: string
  /** LIKE patterns for the tokens trigram cannot match (shorter than 3 chars). */
  likePatterns: string[]
}

/**
 * Split a query into what the trigram index can MATCH and what must be
 * supplemented with substring LIKE, so short tokens (two-character Chinese
 * words, "db", "ui") are never silently dropped from mixed queries.
 */
export function buildFtsSearchPlan(query: string): FtsSearchPlan {
  const tokens = tokenizeQuery(query)
  const matchable = tokens.filter(isTrigramMatchable)
  return {
    matchExpr: matchable.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' OR '),
    likePatterns: tokens.filter((token) => !isTrigramMatchable(token)).flatMap(casePatternVariants)
  }
}

/** MATCH expression for the trigram-matchable tokens only; '' when none. */
export function toMatchExpression(query: string): string {
  return buildFtsSearchPlan(query).matchExpr
}

/** Substring LIKE patterns for every token — the full LIKE-fallback variant. */
export function toLikeFallbackPatterns(query: string): string[] {
  return tokenizeQuery(query).flatMap(casePatternVariants)
}

/**
 * Whole-query phrase MATCH for the sidebar: a trigram phrase query is a
 * contiguous-substring match (spaces included), preserving the LIKE
 * '%query%' semantics the UI always had while adding BM25 ranking. Returns
 * '' when the phrase is too short for trigrams — callers fall back to LIKE.
 */
export function toPhraseMatchExpression(query: string): string {
  const phrase = normalizeWhitespace(query)
  if ([...phrase].length < MIN_TRIGRAM_TOKEN_LENGTH) return ''
  return `"${phrase.replace(/"/gu, '""')}"`
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
 * How many BM25-ranked message rows to fetch per requested result thread.
 * Bounds the fetch for common-token queries that would otherwise materialize
 * a large fraction of the messages table into JS.
 */
export const FTS_MESSAGE_ROWS_PER_THREAD = 20

/**
 * SQL for FTS5 message search. The caller must supply the privacy clause
 * fragment (empty string or `AND threads.privacy_mode IS NULL`), and bind
 * two params: the MATCH expression and the row LIMIT.
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
    LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
    WHERE messages_fts MATCH ?
      AND threads.archived_at IS NULL
      AND threads.channel_group_id IS NULL
      AND messages.hidden IS NULL
      AND (channel_users.id IS NULL OR channel_users.role != 'guest')
      ${privacyClause}
    ORDER BY bm25(messages_fts) ASC, messages.created_at ASC
    LIMIT ?
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
    LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
    WHERE threads_fts MATCH ?
      AND threads.archived_at IS NULL
      AND threads.channel_group_id IS NULL
      AND (channel_users.id IS NULL OR channel_users.role != 'guest')
      ${privacyClause}
    ORDER BY bm25(threads_fts, 3.0, 1.0) ASC
    LIMIT ?
  `
}

function likeAnyClause(column: string, patternCount: number): string {
  return Array.from({ length: patternCount }, () => `${column} LIKE ?`).join(' OR ')
}

/**
 * LIKE fallback for message search when the query has no trigram-matchable
 * token. Same joins/filters/result shape as `ftsMessageSearchSql`, ordered by
 * recency instead of BM25. Bind one pattern per `patternCount`, then LIMIT.
 */
export function likeMessageSearchSql(privacyClause: string, patternCount: number): string {
  return `
    SELECT
      threads.id          AS threadId,
      threads.title       AS threadTitle,
      messages.id         AS messageId,
      messages.role       AS role,
      messages.created_at AS createdAt,
      messages.content    AS content
    FROM messages
    JOIN threads ON threads.id = messages.thread_id
    LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
    WHERE (${likeAnyClause('messages.content', patternCount)})
      AND threads.archived_at IS NULL
      AND threads.channel_group_id IS NULL
      AND messages.hidden IS NULL
      AND (channel_users.id IS NULL OR channel_users.role != 'guest')
      ${privacyClause}
    ORDER BY messages.created_at DESC
    LIMIT ?
  `
}

/**
 * LIKE fallback for thread title/preview search. Bind each pattern twice
 * (title, then preview) in order, then LIMIT.
 */
export function likeThreadSearchSql(privacyClause: string, patternCount: number): string {
  const pairClause = Array.from(
    { length: patternCount },
    () => '(threads.title LIKE ? OR threads.preview LIKE ?)'
  ).join(' OR ')
  return `
    SELECT threads.id
    FROM threads
    LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
    WHERE (${pairClause})
      AND threads.archived_at IS NULL
      AND threads.channel_group_id IS NULL
      AND (channel_users.id IS NULL OR channel_users.role != 'guest')
      ${privacyClause}
    ORDER BY threads.updated_at DESC
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
