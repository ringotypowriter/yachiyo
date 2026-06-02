const LEADING_THING_HASHTAG_RE = /^#[A-Za-z][A-Za-z0-9_-]*[ \t]*/

export function resolveLeadingThingHashtagCursorOffset(text: string): number {
  const match = LEADING_THING_HASHTAG_RE.exec(text)
  return match ? match[0].length : text.length
}
