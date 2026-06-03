const THING_HASHTAG_RE = /(^|[^\p{L}\p{N}_\-/])#([A-Za-z][A-Za-z0-9_-]*)/gu

export function collectThingMentionSlugs(text: string): string[] {
  const slugs: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  THING_HASHTAG_RE.lastIndex = 0
  while ((match = THING_HASHTAG_RE.exec(text)) !== null) {
    const slug = match[2]?.toLowerCase()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    slugs.push(slug)
  }

  return slugs
}

export function isThingMentionToken(token: string, validSlugs: ReadonlySet<string>): boolean {
  if (!token.startsWith('#')) return false
  const slug = token.slice(1).toLowerCase()
  return Boolean(slug) && validSlugs.has(slug)
}
