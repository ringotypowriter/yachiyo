/**
 * Text/tokenization helper source inlined into the querySource SQLite worker
 * script. This is plain JavaScript source text, concatenated verbatim into
 * SQLITE_SOURCE_QUERY_WORKER_SCRIPT — it references constants (MAX_LIMIT,
 * DEFAULT_LIMIT) defined by the surrounding script.
 */
export const SQLITE_SOURCE_QUERY_WORKER_TEXT_HELPERS = `
function normalizeText(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\\s+/gu, ' ').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function truncate(value, maxLength = 180) {
  const compact = String(value).replace(/\\s+/gu, ' ').trim()
  return compact.length > maxLength ? compact.slice(0, maxLength - 3) + '...' : compact
}

function includesText(value, text) {
  return typeof value === 'string' && value.toLowerCase().includes(text.toLowerCase())
}

function tokenizeQuery(query) {
  return (
    query
      .replace(/\\s+/gu, ' ')
      .trim()
      .toLowerCase()
      .match(/[\\p{L}\\p{N}]+/gu) ?? []
  ).filter(Boolean)
}

function casePatternVariants(token) {
  // SQLite LIKE only case-folds ASCII; cover the common casings of cased
  // non-ASCII tokens explicitly. Keep in sync with storage/ftsQuery.ts.
  const capitalized = token.charAt(0).toUpperCase() + token.slice(1)
  return [...new Set([token, capitalized, token.toUpperCase()])].map(
    (variant) => '%' + variant + '%'
  )
}

function buildFtsSearchPlan(query) {
  // Trigram index: tokens shorter than 3 characters cannot MATCH and are
  // supplemented with substring LIKE patterns instead of being dropped.
  // Keep in sync with storage/ftsQuery.ts buildFtsSearchPlan.
  const tokens = tokenizeQuery(query)
  const matchable = tokens.filter((token) => [...token].length >= 3)
  return {
    matchExpr: matchable.map((token) => '"' + token.replace(/"/gu, '""') + '"').join(' OR '),
    likePatterns: tokens.filter((token) => [...token].length < 3).flatMap(casePatternVariants)
  }
}

function extractSnippet(content, query, maxLength = 120) {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) {
    return content.length > maxLength ? content.slice(0, maxLength) + '...' : content
  }
  const start = Math.max(0, idx - 8)
  const end = Math.min(content.length, start + maxLength)
  const snippet = content.slice(start, end)
  return (start > 0 ? '...' : '') + snippet + (end < content.length ? '...' : '')
}

function getLimit(limit) {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)))
    : DEFAULT_LIMIT
}

function parseCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) return 0
  const parsed = Number.parseInt(cursor, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function paginate(rows, input) {
  const start = parseCursor(input.cursor)
  const limit = getLimit(input.limit)
  const sliced = rows.slice(start, start + limit)
  const nextOffset = start + sliced.length
  return {
    rows: sliced,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {})
  }
}
`
