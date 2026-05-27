const CURRENT_INFO_HINTS =
  /\b(?:latest|current|recent|news|now|today|status|price|version|upcoming)\b|\bnext\b(?![./])|\bthis year\b/i

function findStaleYear(query: string, currentYear: number): number | null {
  const years = Array.from(query.matchAll(/\b(19|20)\d{2}\b/g))
    .map((m) => Number(m[0]))
    .filter((y) => y >= currentYear - 10 && y < currentYear)

  if (years.length === 0) {
    return null
  }
  return Math.max(...years)
}

export function normalizeSearchQuery(query: string): string {
  const currentYear = new Date().getFullYear()

  let normalized = query.replaceAll('{currentYear}', String(currentYear))

  if (CURRENT_INFO_HINTS.test(normalized) && !normalized.includes(String(currentYear))) {
    const staleYear = findStaleYear(normalized, currentYear)
    if (staleYear !== null) {
      const pattern = new RegExp(`\\b${staleYear}\\b`, 'g')
      normalized = normalized.replace(pattern, String(currentYear))
    }
  }

  return normalized
}
